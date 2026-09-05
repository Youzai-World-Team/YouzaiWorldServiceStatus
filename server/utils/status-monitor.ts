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
const REQUEST_ATTEMPTS = 2
const RETRY_DELAY_MS = 150
const REFRESH_AFTER_MS = 60_000
const CACHE_MAX_AGE_MS = 30_000
const DEGRADED_LATENCY_MS = 2_500
const NODE_STALE_AFTER_MS = 10 * 60 * 1000
const TRANSIENT_FAILURE_GRACE_MS = 6 * 60 * 1000

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
  if (name === 'TypeError') return '无法连接服务'
  if (/^HTTP \d+$/.test(message)) return `返回异常状态 ${message.slice(5)}`
  return fallback
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function retryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return true
  return error.name === 'AbortError'
    || error.name === 'TimeoutError'
    || error.name === 'TypeError'
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * Edge-to-origin connections can fail transiently. Retry only network-like
 * failures and explicitly retryable HTTP statuses, while keeping the whole
 * operation bounded by REQUEST_TIMEOUT_MS.
 */
export async function fetchWithRetry(url: string, init: RequestInit = {}): Promise<Response> {
  const attemptTimeout = Math.max(1, Math.floor((REQUEST_TIMEOUT_MS - RETRY_DELAY_MS) / REQUEST_ATTEMPTS))
  let lastError: unknown = new Error('请求失败')

  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), attemptTimeout)
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      })
      if (attempt === REQUEST_ATTEMPTS - 1 || !retryableStatus(response.status)) return response
      lastError = new Error(`HTTP ${response.status}`)
      if (response.body && !response.body.locked) void response.body.cancel()
    } catch (error) {
      lastError = error
      if (attempt === REQUEST_ATTEMPTS - 1 || !retryableError(error)) throw error
    } finally {
      clearTimeout(timeout)
    }
    await wait(RETRY_DELAY_MS)
  }

  throw lastError
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetchWithRetry(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'YouzaiWorld-ServiceStatus/1.0',
      ...init?.headers,
    },
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
    response = await fetchWithRetry(definition.url, {
      headers: {
        Accept: '*/*',
        'User-Agent': 'YouzaiWorld-ServiceStatus/1.0',
      },
      redirect: 'follow',
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

function isTransientFailureMessage(message: unknown): boolean {
  if (typeof message !== 'string') return false
  return message === '响应超时'
    || message === '无法连接服务'
    || /^返回异常状态 (408|425|429|5\d\d)$/.test(message)
}

function isFreshSnapshot(snapshot: StatusSnapshot, now: number): boolean {
  const age = now - snapshot.generatedAt
  return age >= 0 && age <= TRANSIENT_FAILURE_GRACE_MS
}

function hasTransientFailures(snapshot: StatusSnapshot): boolean {
  return snapshot.services.some((service) => service.status === 'outage' && isTransientFailureMessage(service.message))
    || snapshot.node.status === 'unknown'
    || snapshot.minecraft.status === 'unknown'
}

/**
 * A single failed probe should not make a healthy service appear offline. The
 * raw failed snapshot is still persisted for history; this only controls the
 * response shown to users until the next successful probe or grace period.
 */
export function recoverTransientFailures(
  snapshot: StatusSnapshot,
  previous: StatusSnapshot | null,
  now = Date.now(),
): StatusSnapshot {
  if (!previous || !isFreshSnapshot(previous, now)) return snapshot

  let recovered = false
  const recoveredNames: string[] = []
  const services = snapshot.services.map((service) => {
    const prior = previous.services.find((item) => item.id === service.id)
    if (
      !prior
      || (prior.status !== 'operational' && prior.status !== 'degraded')
      || service.status !== 'outage'
      || !isTransientFailureMessage(service.message)
    ) return service
    recovered = true
    recoveredNames.push(service.name)
    return {
      ...service,
      status: prior.status,
      latencyMs: prior.latencyMs,
      httpStatus: prior.httpStatus,
      checkedAt: now,
      message: `本次检测失败，沿用最近一次成功状态（${service.message}）`,
    }
  })

  let node = snapshot.node
  if (snapshot.node.status === 'unknown' && isTransientFailureMessage(snapshot.errors.node)) {
    if (previous.node.status === 'operational' || previous.node.status === 'degraded') {
      recovered = true
      recoveredNames.push('运行节点')
      node = {
        ...previous.node,
        message: `本次检测失败，沿用最近一次成功状态（${snapshot.errors.node}）`,
      }
    }
  }

  let minecraft = snapshot.minecraft
  if (snapshot.minecraft.status === 'unknown' && isTransientFailureMessage(snapshot.errors.minecraft)) {
    if (previous.minecraft.status === 'operational' || previous.minecraft.status === 'degraded') {
      recovered = true
      recoveredNames.push('Minecraft 游戏服务')
      minecraft = {
        ...previous.minecraft,
        message: `本次检测失败，沿用最近一次成功状态（${snapshot.errors.minecraft}）`,
      }
    }
  }

  if (!recovered) return snapshot
  const errors = { ...snapshot.errors }
  delete errors.node
  delete errors.minecraft
  errors.worker = `本次检测存在瞬时网络失败，已沿用最近一次成功状态：${recoveredNames.join('、')}`
  return {
    ...snapshot,
    services,
    node,
    minecraft,
    overall: deriveOverallStatus(services, node, minecraft),
    errors,
    stale: true,
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
      let previous = cachedSnapshot?.stale ? null : cachedSnapshot
      if (hasTransientFailures(snapshot) && (!previous || !isFreshSnapshot(previous, Date.now()))) {
        try {
          previous = await getLatestStatusSnapshot(source)
        } catch {
          previous = null
        }
      }
      const displaySnapshot = recoverTransientFailures(snapshot, previous)
      try {
        await saveStatusSnapshot(snapshot, source)
        displaySnapshot.history = historyPoints(await getStatusHistory(source, 24), MAX_HISTORY_POINTS)
      } catch (error) {
        displaySnapshot.errors.storage = errorMessage(error, '状态历史存储暂不可用')
        displaySnapshot.history = historyPoints(getMemoryStatusHistory(24), MAX_HISTORY_POINTS)
      }
      cachedSnapshot = displaySnapshot
      cachedAt = Date.now()
      return displaySnapshot
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
