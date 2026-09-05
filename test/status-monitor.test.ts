import assert from 'node:assert/strict'
import test from 'node:test'
import type { MinecraftStatus, NodeStatus, ServiceStatus } from '../shared/status.ts'
import {
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
})
