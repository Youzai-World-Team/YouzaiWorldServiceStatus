/** See `server/api/status.options.ts` for the CORS policy rationale. */
export default defineEventHandler((event) => {
  setResponseHeaders(event, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'public, max-age=86400',
  })
  setResponseStatus(event, 204)
  return null
})
