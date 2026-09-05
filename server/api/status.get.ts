import { getStatusSnapshot } from '../utils/status-monitor'

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type, X-Requested-With',
  })
  setResponseHeader(event, 'Cache-Control', 'public, max-age=15, stale-while-revalidate=45')
  return getStatusSnapshot(false, event)
})
