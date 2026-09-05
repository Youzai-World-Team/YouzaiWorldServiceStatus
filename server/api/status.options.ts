/**
 * CORS preflight for consumers that send non-simple headers (for example
 * `Authorization` or a custom cache header). The status API itself is public,
 * so a wildcard origin is intentional and does not use credentials.
 */
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
