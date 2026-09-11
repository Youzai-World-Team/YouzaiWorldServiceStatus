import { getStatusSnapshot } from '../../utils/status-monitor'

export default defineTask({
  meta: {
    name: 'status:check',
    description: '定时检测悠哉世界各项服务状态',
  },
  async run(taskEvent) {
    const snapshot = await getStatusSnapshot(true, taskEvent)
    const unavailable = [
      ...snapshot.services.filter((service) => service.status !== 'operational').map((service) => service.name),
      ...(snapshot.node.status !== 'operational' ? [snapshot.node.name] : []),
      ...(snapshot.minecraft.status !== 'operational' ? ['Minecraft 游戏服务'] : []),
    ]

    const diagnostics = {
      generatedAt: snapshot.generatedAt,
      overall: snapshot.overall,
      stale: snapshot.stale === true,
      services: snapshot.services.map(({ id, status, httpStatus, latencyMs, message }) => ({ id, status, httpStatus, latencyMs, message })),
      node: {
        status: snapshot.node.status,
        timestamp: snapshot.node.timestamp,
        ageMs: snapshot.node.timestamp === null ? null : snapshot.generatedAt - snapshot.node.timestamp,
        message: snapshot.node.message,
      },
      minecraft: { status: snapshot.minecraft.status, message: snapshot.minecraft.message },
      errors: snapshot.errors,
    }

    if (unavailable.length) {
      console.warn(`[service-status] 检测到异常：${unavailable.join('、')}`, diagnostics)
    } else if (Object.keys(snapshot.errors).length) {
      console.warn('[service-status] 服务在线，监控数据存在异常', diagnostics)
    } else {
      console.log('[service-status] 所有服务运行正常', diagnostics)
    }

    return {
      result: snapshot.overall,
      generatedAt: snapshot.generatedAt,
    }
  },
})
