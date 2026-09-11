import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { MinecraftStatus, NodeStatus, ServiceStatus } from '../shared/status.ts'
import {
  collectStatusSnapshot,
  deriveOverallStatus,
  fetchWithRetry,
  normalizeHistoryResponse,
  normalizeMinecraftResponse,
  normalizeNodeResponse,
  recoverTransientFailures,
} from '../server/utils/status-monitor.ts'
import { historyPoints } from '../server/utils/status-db.ts'

test('节点数据会归一化百分比和秒级时间戳', () => {
  const node = normalizeNodeResponse({
    status: 200,
    data: [{
      nickname: 'EQAD-003',
      timestamp: 1_800_000_000,
      system: { type: 'Linux', cpuUsage: 0.25, memUsage: 61 },
    }],
  }, 1_800_000_100_000)

  assert.equal(node.status, 'operational')
  assert.equal(node.timestamp, 1_800_000_000_000)
  assert.equal(node.cpuUsage, 25)
  assert.equal(node.memoryUsage, 61)
})

test('节点 ISO 时间戳在十分钟内会保持在线', () => {
  const timestamp = Date.parse('2026-09-11T12:00:00.000Z')
  const node = normalizeNodeResponse({
    status: 200,
    data: [{
      nickname: 'EQAD-003',
      timestamp: '2026-09-11T12:00:00.000Z',
      system: { type: 'Windows_NT', cpuUsage: 0.1, memUsage: 0.2 },
    }],
  }, timestamp + 9 * 60 * 1000)

  assert.equal(node.status, 'operational')
  assert.equal(node.timestamp, timestamp)
})

test('超过十分钟未更新的节点会被标记为离线', () => {
  const node = normalizeNodeResponse({
    status: 200,
    data: [{
      nickname: 'EQAD-003',
      timestamp: 1_800_000_000_000,
      system: { type: 'Linux', cpuUsage: 0.2, memUsage: 0.5 },
    }],
  }, 1_800_000_700_001)

  assert.equal(node.status, 'outage')
})

test('节点新鲜度以十分钟为边界，不因 ISO 格式提前判为离线', () => {
  const timestamp = Date.parse('2026-09-11T12:00:00.000Z')
  const payload = { status: 200, data: [{ nickname: 'EQAD-003', timestamp: new Date(timestamp).toISOString() }] }
  assert.equal(normalizeNodeResponse(payload, timestamp + 600000).status, 'operational')
  assert.equal(normalizeNodeResponse(payload, timestamp + 600001).status, 'outage')
})

test('Minecraft 在线响应会保留玩家、版本和延迟', () => {
  const minecraft = normalizeMinecraftResponse({
    online: true,
    players: { online: 12, max: 80 },
    version: '1.21.8',
    protocol: 772,
    round_trip_latency: 42.4,
  })

  assert.equal(minecraft.status, 'operational')
  assert.equal(minecraft.playersOnline, 12)
  assert.equal(minecraft.playersMax, 80)
  assert.equal(minecraft.latencyMs, 42)
})

test('Minecraft 探测格式错误不能直接解释为游戏服务离线', () => {
  for (const payload of [null, {}, { error: 'upstream failed' }, { online: 'true' }]) {
    assert.throws(() => normalizeMinecraftResponse(payload), /格式异常/)
  }
  assert.equal(normalizeMinecraftResponse({ online: false }).status, 'outage')
})

function mockServiceFetch(t: TestContext) {
  return t.mock.method(globalThis, 'fetch', async (input: string | URL, init: RequestInit) => {
    const url = String(input)
    if (url === 'https://mcyzw.top/') return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } })
    if (url === 'https://api.mcyzw.top/api/activities') return Response.json([])
    if (url === 'https://assets.mcyzw.top/images/logocircle.webp') return new Response('image', { headers: { 'Content-Type': 'image/webp' } })
    if (url === 'https://mailservice.mcyzw.top/health') return Response.json({ ok: true })
    if (url === 'https://api.eqad.fun/mcsm/api/services/') {
      const headers = new Headers(init.headers)
      const fresh = init.cache === 'no-store' && headers.get('Cache-Control') === 'no-cache'
      return Response.json({ status: 200, data: [{
        nickname: 'EQAD-003',
        // Reproduce the live discrepancy: cached edge data is old, origin is fresh.
        timestamp: new Date(Date.now() - (fresh ? 1000 : 40 * 60000)).toISOString(),
        system: { type: 'Windows_NT', cpuUsage: 0.12, memUsage: 0.66 },
      }] })
    }
    throw new Error(`Unexpected dependency: ${url}`)
  })
}

test('完整采集接受活动空数组并绕过旧节点缓存，Minecraft 不再依赖 craftping', async (t) => {
  const http = mockServiceFetch(t)
  const snapshot = await collectStatusSnapshot(async (host, port) => {
    assert.equal(host, 'play.mcyzw.top')
    assert.equal(port, 25565)
    return { online: true, version: '26.2', protocol: 776, players: { online: 0, max: 20 }, round_trip_latency: 985 }
  })
  assert.equal(snapshot.overall, 'operational')
  assert.equal(snapshot.services.length, 4)
  assert.ok(snapshot.services.every((service) => service.status === 'operational'))
  assert.equal(snapshot.node.status, 'operational')
  assert.equal(snapshot.minecraft.online, true)
  assert.equal(http.mock.callCount(), 5)
})

test('Minecraft 检测超时只影响该项，不把其他正常服务连带标为离线', async (t) => {
  mockServiceFetch(t)
  const snapshot = await collectStatusSnapshot(async () => { throw new DOMException('timeout', 'TimeoutError') })
  assert.equal(snapshot.overall, 'degraded')
  assert.ok(snapshot.services.every((service) => service.status === 'operational'))
  assert.equal(snapshot.node.status, 'operational')
  assert.equal(snapshot.minecraft.status, 'unknown')
  assert.equal(snapshot.errors.minecraft, '响应超时')
})

test('历史数据按时间排序并过滤无效记录', () => {
  const history = normalizeHistoryResponse({
    'EQAD-003': [
      { time: 1_800_000_100, status: 'offline' },
      { time: 0, status: 'online' },
      { time: 1_800_000_000, status: 'online' },
      { time: 1_800_000_200, status: 'invalid' },
    ],
  })

  assert.deepEqual(history.map((point) => point.status), ['online', 'offline'])
})

test('部分服务异常时总体状态为部分异常', () => {
  const service = (status: ServiceStatus['status']): ServiceStatus => ({
    id: 'website',
    name: '官网',
    description: 'mcyzw.top',
    url: 'https://mcyzw.top',
    status,
    latencyMs: 10,
    httpStatus: 200,
    checkedAt: 1,
    message: '',
  })
  const node: NodeStatus = {
    name: 'EQAD-003',
    status: 'operational',
    timestamp: 1,
    systemType: 'Linux',
    cpuUsage: 10,
    memoryUsage: 20,
    message: '',
  }
  const minecraft: MinecraftStatus = {
    address: 'play.mcyzw.top:25565',
    status: 'operational',
    online: true,
    playersOnline: 1,
    playersMax: 80,
    version: '1.21.8',
    protocol: '772',
    latencyMs: 30,
    message: '',
  }

  assert.equal(deriveOverallStatus([service('operational')], node, minecraft), 'operational')
  assert.equal(deriveOverallStatus([service('outage')], node, minecraft), 'degraded')
})

test('五分钟样本会聚合为覆盖完整区间的图表点', () => {
  const samples = Array.from({ length: 288 }, (_, index) => ({
    capturedAt: index * 300_000,
    overall: 'operational' as const,
    services: [],
    node: {
      name: 'EQAD-003',
      status: index === 1 ? 'outage' as const : 'operational' as const,
      timestamp: index * 300_000,
      systemType: 'Linux',
      cpuUsage: 10,
      memoryUsage: 20,
      message: '',
    },
    minecraft: {
      address: 'play.mcyzw.top:25565',
      status: 'operational' as const,
      online: true,
      playersOnline: 1,
      playersMax: 80,
      version: '1.21.8',
      protocol: '772',
      latencyMs: 30,
      message: '',
    },
    errors: {},
  }))

  const points = historyPoints(samples, 96)
  assert.equal(points.length, 96)
  assert.equal(points[0]?.status, 'offline')
  assert.equal(points.at(-1)?.time, samples.at(-1)?.capturedAt)
})

test('网络抖动时会在总时限内重试一次', async () => {
  const originalFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = (async () => {
    attempts += 1
    if (attempts === 1) throw new TypeError('fetch failed')
    return new Response('ok', { status: 200 })
  }) as typeof fetch

  try {
    const response = await fetchWithRetry('https://status.example.test')
    assert.equal(response.status, 200)
    assert.equal(attempts, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('上游 5xx 时会重试并返回后续成功响应', async () => {
  const originalFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = (async () => {
    attempts += 1
    return attempts === 1
      ? new Response('temporary failure', { status: 503 })
      : new Response('ok', { status: 200 })
  }) as typeof fetch

  try {
    const response = await fetchWithRetry('https://status.example.test')
    assert.equal(response.status, 200)
    assert.equal(attempts, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('HTTP 头已返回但 JSON 响应体卡住时仍会超时重试并结束采集', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    attempts += 1
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('['))
        init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true })
      },
    }))
  })
  const result = fetchWithRetry('https://status.example.test', {}, (response) => response.json())
  const rejection = assert.rejects(result, { name: 'AbortError' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  t.mock.timers.tick(4000)
  await new Promise<void>((resolve) => setImmediate(resolve))
  t.mock.timers.tick(150)
  await new Promise<void>((resolve) => setImmediate(resolve))
  t.mock.timers.tick(4000)
  await rejection
  assert.equal(attempts, 2)
})

test('单次瞬时失败会沿用最近一次成功状态并标记过期', () => {
  const previous: any = {
    generatedAt: 1_800_000_000_000,
    refreshAfterMs: 60_000,
    overall: 'operational',
    services: [{
      id: 'website', name: '官网', description: 'mcyzw.top', url: 'https://mcyzw.top/',
      status: 'operational', latencyMs: 120, httpStatus: 200, checkedAt: 1_800_000_000_000, message: '运行正常',
    }],
    node: {
      name: 'EQAD-003', status: 'operational', timestamp: 1_800_000_000_000,
      systemType: 'Linux', cpuUsage: 10, memoryUsage: 20, message: '运行正常',
    },
    minecraft: {
      address: 'play.mcyzw.top:25565', status: 'operational', online: true,
      playersOnline: 1, playersMax: 80, version: '1.21.8', protocol: '772', latencyMs: 30, message: '服务在线',
    },
    history: [],
    errors: {},
  }
  const current = {
    ...previous,
    generatedAt: 1_800_000_030_000,
    overall: 'outage' as const,
    services: [{ ...previous.services[0], status: 'outage' as const, latencyMs: null, httpStatus: null, message: '响应超时' }],
    errors: { node: '响应超时', minecraft: '响应超时' },
    node: { ...previous.node, status: 'unknown' as const, timestamp: null, message: '响应超时' },
    minecraft: { ...previous.minecraft, status: 'unknown' as const, online: false, message: '响应超时' },
  }

  const recovered = recoverTransientFailures(current, previous, 1_800_000_030_000)
  assert.equal(recovered.stale, true)
  assert.equal(recovered.services[0]?.status, 'operational')
  assert.equal(recovered.node.status, 'operational')
  assert.equal(recovered.minecraft.status, 'operational')
  assert.equal(recovered.overall, 'operational')
  assert.match(recovered.errors.worker || '', /瞬时网络失败/)

  const persistent = recoverTransientFailures(current, {
    ...previous,
    services: current.services,
    node: current.node,
    minecraft: current.minecraft,
  }, 1_800_000_030_000)
  assert.equal(persistent.stale, undefined)
  assert.equal(persistent.services[0]?.status, 'outage')
  assert.equal(persistent.node.status, 'unknown')
  assert.equal(persistent.minecraft.status, 'unknown')

  const partial = recoverTransientFailures(current, {
    ...previous,
    minecraft: current.minecraft,
  }, 1_800_000_030_000)
  assert.equal(partial.node.status, 'operational')
  assert.equal(partial.errors.node, undefined)
  assert.equal(partial.minecraft.status, 'unknown')
  assert.equal(partial.errors.minecraft, '响应超时')
})
