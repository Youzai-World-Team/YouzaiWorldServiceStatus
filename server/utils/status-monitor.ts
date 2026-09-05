import type {
  AvailabilityPoint,
  MinecraftStatus,
  NodeStatus,
  ServiceStatus,
  StatusSnapshot,
  StatusTone,
} from '../../shared/status.ts'
import {
  getLatestMemoryStatusSnapshot,
  getLatestStatusSnapshot,
  getMemoryStatusHistory,
  getStatusHistory,
  historyPoints,
  saveStatusSnapshot,
} from './status-db.ts'

const NODE_SERVICES_URL = 'https://api.eqad.fun/mcsm/api/services/'
const MINECRAFT_STATUS_URL = 'https://mcyzw.top/api/craftping/get_status'
const NODE_NAME = 'EQAD-003'
const MINECRAFT_HOST = 'play.mcyzw.top'
const MINECRAFT_PORT = 25565
const MAX_HISTORY_POINTS = 96
const REQUEST_TIMEOUT_MS = 8_000
const REFRESH_AFTER_MS = 60_000
const CACHE_MAX_AGE_MS = 30_000
const DEGRADED_LATENCY_MS = 2_500
const NODE_STALE_AFTER_MS = 10 * 60 * 1000

interface ServiceDefinition {
  id: ServiceStatus['id']
  name: string
  description: string
  url: string
  validate?: (response: Response) => Promise<boolean> | boolean
}

type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown }

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

const SERVICE_DEFINITIONS: ServiceDefinition[] = [
  {
    id: 'website',
    name: '悠哉世界官网',
    description: 'mcyzw.top',
    url: 'https://mcyzw.top/',
    validate: (response) => response.headers.get('content-type')?.includes('text/html') === true,
  },
  {
    id: 'api',
    name: 'API 服务端',
    description: 'api.mcyzw.top',
    url: 'https://api.mcyzw.top/api/activities',
    validate: async (response) => Array.isArray(await response.json()),
  },
  {
    id: 'assets',
    name: '官网静态资源',
    description: 'assets.mcyzw.top',
    url: 'https://assets.mcyzw.top/images/logocircle.webp',
    validate: (response) => response.headers.get('content-type')?.startsWith('image/') === true,
  },
  {
    id: 'mail',
    name: '域名邮件处理器',
    description: 'mailservice.mcyzw.top',
    url: 'https://mailservice.mcyzw.top/health',
    validate: async (response) => (await response.json() as { ok?: unknown })?.ok === true,
  },
]

let cachedSnapshot: StatusSnapshot | null = null
let cachedAt = 0
let pendingSnapshot: Promise<StatusSnapshot> | null = null

function finiteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizedTimestamp(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const number = finiteNumber(value)
  if (number === null || number <= 0) return null
  return number < 1_000_000_000_000 ? number * 1000 : number
}

function usagePercent(value: unknown): number | null {
  const number = finiteNumber(value)
  if (number === null) return null
  const percent = number <= 1 ? number * 100 : number
  return Math.min(100, Math.max(0, percent))
}

function errorMessage(error: unknown, fallback: string): string {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : ''
  if (name === 'TimeoutError' || name === 'AbortError') return '响应超时'
  if (/^HTTP \d+$/.test(message)) return `返回异常状态 ${message.slice(5)}`
  return fallback
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'YouzaiWorld-ServiceStatus/1.0',
      ...init?.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

export function normalizeNodeResponse(payload: unknown, now = Date.now()): NodeStatus {
  const envelope = payload as { status?: unknown; data?: unknown }
  if (Number(envelope?.status) !== 200 || !Array.isArray(envelope?.data)) {
    throw new Error('节点监控返回格式异常')
  }
  const raw = envelope.data.find((item: any) => String(item?.nickname || '') === NODE_NAME) as any
  if (!raw) throw new Error(`节点监控中未找到 ${NODE_NAME}`)

  const timestamp = normalizedTimestamp(raw.timestamp)
  const stale = timestamp === null || now - timestamp > NODE_STALE_AFTER_MS
  return {
    name: NODE_NAME,
    status: stale ? 'outage' : 'operational',
    timestamp,
    systemType: String(raw.system?.type || '未知'),
    cpuUsage: usagePercent(raw.system?.cpuUsage),
    memoryUsage: usagePercent(raw.system?.memUsage),
    message: stale ? '节点数据已超过 10 分钟未更新' : '运行正常',
  }
}

export function normalizeMinecraftResponse(payload: unknown): MinecraftStatus {
  const raw = payload as any
  const online = raw?.online === true
  const latency = finiteNumber(raw?.round_trip_latency ?? raw?.delay)
  const status: StatusTone = online
    ? latency !== null && latency > DEGRADED_LATENCY_MS ? 'degraded' : 'operational'
    : 'outage'

  return {
    address: `${MINECRAFT_HOST}:${MINECRAFT_PORT}`,
    status,
    online,
    playersOnline: online ? Math.max(0, Math.trunc(finiteNumber(raw?.players?.online) ?? 0)) : null,
    playersMax: online ? Math.max(0, Math.trunc(finiteNumber(raw?.players?.max) ?? 0)) : null,
    version: online && raw?.version != null ? String(raw.version) : null,
    protocol: online && raw?.protocol != null ? String(raw.protocol) : null,
    latencyMs: online && latency !== null ? Math.max(0, Math.round(latency)) : null,
    message: online ? status === 'degraded' ? '服务在线，但响应较慢' : '服务在线' : String(raw?.error || '服务器离线'),
  }
}

export function normalizeHistoryResponse(payload: unknown): AvailabilityPoint[] {
  const records = (payload as Record<string, unknown> | null)?.[NODE_NAME]
  if (!Array.isArray(records)) throw new Error(`历史监控中未找到 ${NODE_NAME}`)
  return records
    .map((item: any): AvailabilityPoint | null => {
      const status = item?.status === 'online' ? 'online' : item?.status === 'offline' ? 'offline' : null
      const time = normalizedTimestamp(item?.time)
      return status && time !== null ? { time, status } : null
    })
    .filter((item): item is AvailabilityPoint => item !== null)
    .sort((a, b) => a.time - b.time)
    .slice(-MAX_HISTORY_POINTS)
}

export function deriveOverallStatus(
  services: ServiceStatus[],
  node: NodeStatus,
  minecraft: MinecraftStatus,
): StatusTone {
  const tones = [...services.map((service) => service.status), node.status, minecraft.status]
  if (tones.every((tone) => tone === 'operational')) return 'operational'
  if (tones.every((tone) => tone === 'outage' || tone === 'unknown')) return 'outage'
  return 'degraded'
}

async function checkService(definition: ServiceDefinition): Promise<ServiceStatus> {
  const checkedAt = Date.now()
  const startedAt = performance.now()
  const publicDefinition = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    url: definition.url,
  }
  let response: Response | null = null
  try {
    response = await fetch(definition.url, {
      headers: {
        Accept: '*/*',
        'User-Agent': 'YouzaiWorld-ServiceStatus/1.0',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const valid = definition.validate ? await definition.validate(response) : true
    if (!valid) throw new Error('invalid response')
    const status = latencyMs > DEGRADED_LATENCY_MS ? 'degraded' : 'operational'
    return {
      ...publicDefinition,
      status,
      latencyMs,
      httpStatus: response.status,
      checkedAt,
      message: status === 'operational' ? '运行正常' : '服务可用，但响应较慢',
    }
  } catch (error) {
    return {
      ...publicDefinition,
      status: 'outage',
      latencyMs: null,
      httpStatus: response?.status ?? null,
      checkedAt,
      message: errorMessage(error, '无法连接服务'),
    }
  } finally {
    if (response?.body && !response.body.locked) void response.body.cancel()
  }
}

async function collectStatusSnapshot(): Promise<StatusSnapshot> {
  const [services, nodeResult, minecraftResult] = await Promise.all([
    settle(Promise.all(SERVICE_DEFINITIONS.map(checkService))),
    settle(requestJson(NODE_SERVICES_URL)),
    settle(requestJson(MINECRAFT_STATUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: MINECRAFT_HOST, port: MINECRAFT_PORT }),
    })),
  ])

  const checkedServices = services.ok ? services.value : []
  const errors: StatusSnapshot['errors'] = {}

  let node: NodeStatus
  try {
    if (!nodeResult.ok) throw nodeResult.error
    node = normalizeNodeResponse(nodeResult.value)
  } catch (error) {
    errors.node = errorMessage(error, error instanceof Error ? error.message : '节点监控暂不可用')
    node = {
      name: NODE_NAME,
      status: 'unknown',
      timestamp: null,
      systemType: null,
      cpuUsage: null,
      memoryUsage: null,
      message: errors.node,
    }
  }

  let minecraft: MinecraftStatus
  try {
    if (!minecraftResult.ok) throw minecraftResult.error
    minecraft = normalizeMinecraftResponse(minecraftResult.value)
  } catch (error) {
    errors.minecraft = errorMessage(error, 'Minecraft 状态暂不可用')
    minecraft = {
      address: `${MINECRAFT_HOST}:${MINECRAFT_PORT}`,
      status: 'unknown',
      online: false,
      playersOnline: null,
      playersMax: null,
      version: null,
      protocol: null,
      latencyMs: null,
      message: errors.minecraft,
    }
  }

  return {
    generatedAt: Date.now(),
    refreshAfterMs: REFRESH_AFTER_MS,
    overall: deriveOverallStatus(checkedServices, node, minecraft),
    services: checkedServices,
    node,
    minecraft,
    history: [],
    errors,
  }
}

export async function getStatusSnapshot(force = false, source?: unknown): Promise<StatusSnapshot> {
  const now = Date.now()
  if (!force && cachedSnapshot && now - cachedAt < CACHE_MAX_AGE_MS) return cachedSnapshot
  if (pendingSnapshot) return pendingSnapshot

  pendingSnapshot = collectStatusSnapshot()
    .then(async (snapshot) => {
      try {
        await saveStatusSnapshot(snapshot, source)
        snapshot.history = historyPoints(await getStatusHistory(source, 24), MAX_HISTORY_POINTS)
      } catch (error) {
        snapshot.errors.storage = errorMessage(error, '状态历史存储暂不可用')
        snapshot.history = historyPoints(getMemoryStatusHistory(24), MAX_HISTORY_POINTS)
      }
      cachedSnapshot = snapshot
      cachedAt = Date.now()
      return snapshot
    })
    .catch(async (error) => {
      // A fully failed collection is uncommon because individual probes settle
      // independently. If it does happen, keep the public status API useful by
      // returning the most recent D1 snapshot and clearly marking it as stale.
      let fallback: StatusSnapshot | null
      try {
        fallback = await getLatestStatusSnapshot(source)
      } catch {
        fallback = getLatestMemoryStatusSnapshot()
      }
      if (!fallback) throw error
      fallback.stale = true
      fallback.errors.worker = errorMessage(error, '实时状态检测失败，当前显示最近一次记录')
      try {
        fallback.history = historyPoints(await getStatusHistory(source, 24), MAX_HISTORY_POINTS)
      } catch {
        fallback.history = historyPoints(getMemoryStatusHistory(24), MAX_HISTORY_POINTS)
      }
      return fallback
    })
    .finally(() => {
      pendingSnapshot = null
    })

  return pendingSnapshot
}
