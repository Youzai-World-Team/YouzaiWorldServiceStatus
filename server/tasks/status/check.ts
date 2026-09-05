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

    if (unavailable.length) {
      console.warn(`[service-status] 检测到异常：${unavailable.join('、')}`)
    } else {
      console.log('[service-status] 所有服务运行正常')
    }

    return {
      result: snapshot.overall,
      generatedAt: snapshot.generatedAt,
    }
  },
})
