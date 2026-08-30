import { getStatusSnapshot } from '../utils/status-monitor'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'public, max-age=15, stale-while-revalidate=45')
  return getStatusSnapshot()
})
