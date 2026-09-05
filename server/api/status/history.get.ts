import { getQuery } from 'h3'
import { getMemoryStatusHistory, getStatusHistory } from '../../utils/status-db'

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type, X-Requested-With',
  })
  const query = getQuery(event)
  const requestedHours = Number(query.hours)
  const hours = Number.isFinite(requestedHours) ? requestedHours : 72
  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=120')
  let samples
  let storageError: string | undefined
  try {
    samples = await getStatusHistory(event, hours)
  } catch {
    // A transient D1 failure should not make the public status graph disappear;
    // the process-local cache still contains recent samples when available.
    storageError = 'D1 状态历史暂时不可用'
    samples = getMemoryStatusHistory(hours)
  }
  return {
    ok: true,
    retentionHours: 72,
    generatedAt: Date.now(),
    samples,
    ...(storageError ? { errors: { storage: storageError } } : {}),
  }
})
