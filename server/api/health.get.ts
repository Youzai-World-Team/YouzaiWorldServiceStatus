export default defineEventHandler((event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return {
    ok: true,
    service: 'youzaiworld-service-status',
    time: Date.now(),
  }
})

