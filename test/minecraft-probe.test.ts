import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import test from 'node:test'
import { probeMinecraftStatus } from '../server/utils/minecraft-probe.ts'

const statusPayload = { version: { name: '26.2', protocol: 776 }, players: { online: 0, max: 20 }, description: { text: '悠哉世界' } }

function varInt(value: number): Buffer {
  const result: number[] = []
  do {
    result.push((value & 127) | (value > 127 ? 128 : 0))
    value >>>= 7
  } while (value)
  return Buffer.from(result)
}

function responsePacket(value = statusPayload): Buffer {
  const json = Buffer.from(JSON.stringify(value))
  const body = Buffer.concat([Buffer.from([0]), varInt(json.length), json])
  return Buffer.concat([varInt(body.length), body])
}

class FakeSocket extends EventEmitter {
  destroyed = false
  request: Buffer | null = null
  reply: (socket: FakeSocket) => void = () => {}

  write(data: Buffer) {
    this.request = data
    this.reply(this)
    return true
  }

  destroy() {
    this.destroyed = true
    this.emit('close')
    return this
  }

  connect() {
    queueMicrotask(() => this.emit('connect'))
    return this as unknown as Socket
  }
}

test('真实 SRV 响应会连接目标端口，保留原始握手域名并解析分片状态包', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init: RequestInit) => {
    const url = new URL(String(input))
    assert.equal(url.hostname, 'cloudflare-dns.com')
    assert.equal(url.searchParams.get('name'), '_minecraft._tcp.play.mcyzw.top')
    assert.equal(init.cache, 'no-store')
    return Response.json({ Status: 0, Answer: [
      { type: 33, data: '100 0 52531 frp-top.com.' },
      { type: 33, data: '200 0 25565 standby.example.test.' },
    ] })
  })
  const socket = new FakeSocket()
  socket.reply = (connection) => {
    const packet = responsePacket()
    for (const part of [packet.subarray(0, 1), packet.subarray(1, 3), packet.subarray(3, 17), packet.subarray(17)]) connection.emit('data', part)
  }
  const result = await probeMinecraftStatus('play.mcyzw.top', 25565, {
    connectSocket: (endpoint) => {
      assert.deepEqual(endpoint, { host: 'frp-top.com', port: 52531 })
      return socket.connect()
    },
  })
  assert.equal(result.online, true)
  assert.equal(result.version, '26.2')
  assert.equal(result.protocol, 776)
  assert.deepEqual(result.players, { online: 0, max: 20 })
  assert.ok(socket.request?.includes(Buffer.from('play.mcyzw.top')))
  assert.deepEqual(socket.request?.subarray(-5, -3), Buffer.from([52531 >> 8, 52531 & 255]))
  assert.equal(socket.destroyed, true)
})

for (const dns of [{ Status: 0 }, { Status: 3 }]) {
  test(`DNS 明确没有 SRV 时使用原地址（Status=${dns.Status}）`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json(dns))
    const socket = new FakeSocket()
    socket.reply = (connection) => connection.emit('data', responsePacket())
    await probeMinecraftStatus('play.example.test', 25565, {
      connectSocket: (endpoint) => {
        assert.deepEqual(endpoint, { host: 'play.example.test', port: 25565 })
        return socket.connect()
      },
    })
  })
}

for (const dns of [{ Status: 2 }, { Status: 0, Answer: [{ type: 33, data: '0 0 0 .' }] }]) {
  test(`DNS 失败或 SRV 无效时不错误连接默认端口：${JSON.stringify(dns)}`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json(dns))
    let connected = false
    await assert.rejects(probeMinecraftStatus('play.example.test', 25565, {
      connectSocket: () => { connected = true; return new FakeSocket().connect() },
    }), /DNS|SRV/)
    assert.equal(connected, false)
  })
}

test('SRV 查询超时会在总时限结束时退出', async (t) => {
  t.mock.method(globalThis, 'fetch', (_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  }))
  await assert.rejects(probeMinecraftStatus('play.example.test', 25565, { timeoutMs: 30 }), { name: 'TimeoutError' })
})

test('TCP 已连接但不返回状态时会超时并关闭连接', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Explicit port must not query SRV') })
  const socket = new FakeSocket()
  await assert.rejects(probeMinecraftStatus('server.example.test', 52531, {
    timeoutMs: 30,
    connectSocket: () => socket.connect(),
  }), { name: 'TimeoutError' })
  assert.equal(socket.destroyed, true)
})

test('连接在完整响应前关闭时不会标记在线', async () => {
  const socket = new FakeSocket()
  socket.reply = (connection) => {
    connection.emit('data', responsePacket().subarray(0, 10))
    connection.destroy()
  }
  await assert.rejects(probeMinecraftStatus('127.0.0.1', 25565, {
    connectSocket: () => socket.connect(),
  }), /返回状态前关闭/)
})

for (const [name, packet] of [
  ['超大包', varInt(1024 * 1024 + 1)],
  ['无效 VarInt', Buffer.from([255, 255, 255, 255, 255])],
  ['错误包 ID', Buffer.from([2, 1, 0])],
  ['JSON 长度不符', Buffer.from([2, 0, 9])],
  ['缺少玩家信息', responsePacket({ ...statusPayload, players: undefined } as unknown as typeof statusPayload)],
] as const) {
  test(`${name}不会被当作 Minecraft 在线响应`, async () => {
    const socket = new FakeSocket()
    socket.reply = (connection) => connection.emit('data', packet)
    await assert.rejects(probeMinecraftStatus('127.0.0.1', 25565, {
      connectSocket: () => socket.connect(),
    }))
    assert.equal(socket.destroyed, true)
  })
}
