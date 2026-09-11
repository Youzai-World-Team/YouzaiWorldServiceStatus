import { collectStatusSnapshot } from '../server/utils/status-monitor.ts'
import type { StatusSnapshot } from '../shared/status.ts'

function summary(snapshot: StatusSnapshot) {
  return {
    generatedAt: new Date(snapshot.generatedAt).toISOString(),
    overall: snapshot.overall,
    services: snapshot.services.map(({ id, status, httpStatus, latencyMs, message }) => ({ id, status, httpStatus, latencyMs, message })),
    node: { ...snapshot.node, ageMs: snapshot.node.timestamp === null ? null : snapshot.generatedAt - snapshot.node.timestamp },
    minecraft: snapshot.minecraft,
    errors: snapshot.errors,
  }
}

// No server or production database is started. Run one collection against the
// public endpoints using the current source, and optionally read the deployed API.
const current = await collectStatusSnapshot()
console.log(JSON.stringify({ source: 'local-code/live-endpoints', ...summary(current) }, null, 2))
if (current.services.some((service) => service.status === 'outage')
  || current.node.status === 'outage' || current.node.status === 'unknown'
  || !current.minecraft.online) process.exitCode = 1

if (process.argv.includes('--compare-deployed')) {
  try {
    const response = await fetch('https://status.mcyzw.top/api/status', {
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    console.log(JSON.stringify({ source: 'deployed-worker', ...summary(await response.json() as StatusSnapshot) }, null, 2))
  } catch (error) {
    console.error('无法读取已部署状态 Worker：', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
