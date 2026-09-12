import { Buffer } from 'node:buffer'
import { createConnection, isIP } from 'node:net'
import type { Socket } from 'node:net'

const DNS_URL = 'https://cloudflare-dns.com/dns-query'
const MAX_PACKET_BYTES = 1024 * 1024

interface MinecraftEndpoint { host: string; port: number }
interface SrvRecord extends MinecraftEndpoint { priority: number; weight: number }
interface ProbeOptions {
  timeoutMs?: number
  connectSocket?: (endpoint: MinecraftEndpoint) => Socket
}

export interface MinecraftProbeResult {
  online: true
  version: string
  protocol: number
  players: { online: number; max: number }
  round_trip_latency: number
}

async function resolveEndpoint(host: string, port: number, signal: AbortSignal): Promise<MinecraftEndpoint> {
  if (port !== 25703 || isIP(host)) return { host, port }
  const url = new URL(DNS_URL)
  url.searchParams.set('name', `_minecraft._tcp.${host}`)
  url.searchParams.set('type', 'SRV')
  const response = await fetch(url, {
    headers: { Accept: 'application/dns-json' },
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new Error(`Minecraft DNS 查询返回 HTTP ${response.status}`)
  const payload = await response.json() as { Status?: number; Answer?: Array<{ type?: number; data?: string }> }
  // Only a successful negative DNS answer permits the default host/port.
  // A DNS failure must not silently probe port 25703 when an SRV record exists.
  if (payload.Status === 3) return { host, port }
  if (payload.Status !== 0) throw new Error('Minecraft DNS 查询失败')
  const answers = payload.Answer?.filter((answer) => answer.type === 33) ?? []
  if (!answers.length) return { host, port }

  const records: SrvRecord[] = answers.map((answer) => {
    const parts = answer.data?.trim().split(/\s+/) ?? []
    const [priority, weight, srvPort] = parts.slice(0, 3).map(Number)
    const target = parts[3]?.replace(/\.$/, '')
    if (parts.length !== 4 || !target || !/^[a-z0-9.-]+$/i.test(target)
      || !Number.isInteger(priority) || priority! < 0 || priority! > 65535
      || !Number.isInteger(weight) || weight! < 0 || weight! > 65535
      || !Number.isInteger(srvPort) || srvPort! < 1 || srvPort! > 65535) {
      throw new Error('Minecraft SRV 记录无效')
    }
    return { host: target, port: srvPort!, priority: priority!, weight: weight! }
  })
  const priority = Math.min(...records.map((record) => record.priority))
  const candidates = records.filter((record) => record.priority === priority)
  const totalWeight = candidates.reduce((sum, record) => sum + record.weight, 0)
  let choice = Math.random() * (totalWeight || candidates.length)
  for (const record of candidates) {
    choice -= totalWeight ? record.weight : 1
    if (choice < 0) return { host: record.host, port: record.port }
  }
  return candidates[candidates.length - 1]!
}

function encodeVarInt(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value >>> 0
  do {
    let byte = remaining & 0x7f
    remaining >>>= 7
    if (remaining) byte |= 0x80
    bytes.push(byte)
  } while (remaining)
  return Buffer.from(bytes)
}

function decodeVarInt(buffer: Buffer, offset = 0): { value: number; next: number } | null {
  let value = 0
  for (let index = 0; index < 5; index += 1) {
    const byte = buffer[offset + index]
    if (byte === undefined) return null
    value += (byte & 0x7f) * 2 ** (7 * index)
    if (!(byte & 0x80)) {
      if (value > 0x7fff_ffff) throw new Error('Minecraft 状态包长度无效')
      return { value, next: offset + index + 1 }
    }
  }
  throw new Error('Minecraft 状态包 VarInt 无效')
}

function statusRequest(host: string, port: number): Buffer {
  const hostBytes = Buffer.from(host, 'utf8')
  const portBytes = Buffer.alloc(2)
  portBytes.writeUInt16BE(port)
  const handshake = Buffer.concat([
    encodeVarInt(0), encodeVarInt(-1), encodeVarInt(hostBytes.length), hostBytes, portBytes, encodeVarInt(1),
  ])
  return Buffer.concat([encodeVarInt(handshake.length), handshake, Buffer.from([1, 0])])
}

function readStatus(packet: Buffer): Omit<MinecraftProbeResult, 'round_trip_latency'> {
  const id = decodeVarInt(packet)
  if (!id || id.value !== 0) throw new Error('Minecraft 状态包 ID 无效')
  const length = decodeVarInt(packet, id.next)
  if (!length || length.next + length.value !== packet.length) throw new Error('Minecraft 状态包长度不匹配')
  const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(packet.subarray(length.next)))
  if (!payload || typeof payload.version?.name !== 'string'
    || !Number.isInteger(payload.version.protocol)
    || !Number.isInteger(payload.players?.online) || payload.players.online < 0
    || !Number.isInteger(payload.players?.max) || payload.players.max < 0) {
    throw new Error('Minecraft 状态响应格式异常')
  }
  return {
    online: true,
    version: payload.version.name,
    protocol: payload.version.protocol,
    players: { online: payload.players.online, max: payload.players.max },
  }
}

async function queryStatus(
  endpoint: MinecraftEndpoint,
  handshakeHost: string,
  signal: AbortSignal,
  connectSocket: NonNullable<ProbeOptions['connectSocket']>,
): Promise<Omit<MinecraftProbeResult, 'round_trip_latency'>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const socket = connectSocket(endpoint)
    let received = Buffer.alloc(0)
    let finished = false
    const finish = (error?: unknown, result?: Omit<MinecraftProbeResult, 'round_trip_latency'>) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', onAbort)
      socket.destroy()
      if (error) reject(error)
      else resolve(result!)
    }
    const onAbort = () => finish(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    socket.once('error', (error) => finish(error))
    socket.once('close', () => finish(new Error('Minecraft 连接在返回状态前关闭')))
    socket.once('connect', () => {
      if (!finished) socket.write(statusRequest(handshakeHost, endpoint.port))
    })
    socket.on('data', (chunk: Buffer) => {
      if (finished) return
      try {
        if (received.length + chunk.length > MAX_PACKET_BYTES + 5) throw new Error('Minecraft 状态包过大')
        received = Buffer.concat([received, chunk])
        const frame = decodeVarInt(received)
        if (!frame) return
        if (frame.value > MAX_PACKET_BYTES) throw new Error('Minecraft 状态包过大')
        if (received.length < frame.next + frame.value) return
        finish(undefined, readStatus(received.subarray(frame.next, frame.next + frame.value)))
      } catch (error) { finish(error) }
    })
    if (signal.aborted) onAbort()
  })
}

/** Query the same SRV destination as a Java client, within one DNS + TCP deadline. */
export async function probeMinecraftStatus(host: string, port = 25703, options: ProbeOptions = {}): Promise<MinecraftProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Minecraft 直连检测超时', 'TimeoutError')), options.timeoutMs ?? 8000)
  const started = performance.now()
  try {
    const endpoint = await resolveEndpoint(host, port, controller.signal)
    const status = await queryStatus(endpoint, host, controller.signal, options.connectSocket ?? ((target) => createConnection(target)))
    return { ...status, round_trip_latency: Math.max(0, Math.round(performance.now() - started)) }
  } finally {
    clearTimeout(timer)
  }
}
