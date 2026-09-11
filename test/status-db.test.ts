import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { StatusSnapshot } from '../shared/status.ts'
import { getLatestStatusSnapshot, getStatusHistory, saveStatusSnapshot, STATUS_BUCKET_MS, STATUS_RETENTION_MS } from '../server/utils/status-db.ts'

/** In-memory SQLite with the D1 statement API, including exec's line splitting. */
function database() {
  const sqlite = new DatabaseSync(':memory:')
  return {
    sqlite,
    async exec(sql: string) {
      for (const statement of sql.trim().split('\n')) sqlite.prepare(statement).run()
    },
    prepare(sql: string) {
      const statement = sqlite.prepare(sql)
      let values: Array<string | number | null> = []
      return {
        bind(...args: Array<string | number | null>) { values = args; return this },
        async run() { return statement.run(...values) },
        async all() { return { results: statement.all(...values) } },
      }
    },
  }
}

function snapshot(time = Date.now()): StatusSnapshot {
  return {
    generatedAt: time, refreshAfterMs: 60000, overall: 'operational', services: [], history: [], errors: {},
    node: { name: 'EQAD-003', status: 'operational', timestamp: time, systemType: 'Windows_NT', cpuUsage: 10, memoryUsage: 20, message: '运行正常' },
    minecraft: { address: 'play.mcyzw.top:25565', status: 'operational', online: true, playersOnline: 0, playersMax: 20, version: '26.2', protocol: '776', latencyMs: 50, message: '服务在线' },
  }
}

test('D1 初始化不被多行 exec 阻塞，保存和历史查询使用真实 SQL', async (t) => {
  const db = database()
  t.after(() => db.sqlite.close())
  await assert.rejects(db.exec('CREATE TABLE example (\n value TEXT\n);'), /incomplete input/)
  const source = { context: { cloudflare: { env: { DB: db } } } }
  const now = Math.floor(Date.now() / STATUS_BUCKET_MS) * STATUS_BUCKET_MS
  await saveStatusSnapshot(snapshot(now - STATUS_BUCKET_MS), source)
  await saveStatusSnapshot(snapshot(now), source)
  // A fresh binding has no process-local schema promise, like a cold Worker.
  const coldSource = { env: { DB: { prepare: db.prepare, exec: db.exec } } }
  const history = await getStatusHistory(coldSource, 24)
  assert.deepEqual(history.map((sample) => sample.capturedAt), [now - STATUS_BUCKET_MS, now])
  assert.equal((await getLatestStatusSnapshot(coldSource))?.minecraft.online, true)
  assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM status_samples').get()?.count, 2)
})

test('D1 的备用绑定和 Cron 上下文可用，同一时间桶覆盖并清理过期样本', async (t) => {
  const db = database()
  t.after(() => db.sqlite.close())
  const source = { env: {}, context: { cloudflare: { env: { youzaiworld_service_status: db } } } }
  const now = Math.floor(Date.now() / STATUS_BUCKET_MS) * STATUS_BUCKET_MS
  await saveStatusSnapshot(snapshot(now - STATUS_RETENTION_MS - STATUS_BUCKET_MS), source)
  await saveStatusSnapshot(snapshot(now), source)
  const latest = snapshot(now + 1)
  latest.minecraft.playersOnline = 2
  await saveStatusSnapshot(latest, source)
  const history = await getStatusHistory(source, 72)
  assert.equal(history.length, 1)
  assert.equal(history[0]?.minecraft.playersOnline, 2)
  assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM status_samples').get()?.count, 1)
})

test('一次 D1 初始化失败后后续请求可以重试', async (t) => {
  const db = database()
  t.after(() => db.sqlite.close())
  let fail = true
  const binding = {
    prepare(sql: string) {
      if (fail) { fail = false; throw new Error('D1 temporarily unavailable') }
      return db.prepare(sql)
    },
  }
  const source = { env: { DB: binding } }
  await assert.rejects(saveStatusSnapshot(snapshot(), source), /temporarily unavailable/)
  await saveStatusSnapshot(snapshot(), source)
  assert.equal((await getStatusHistory(source, 24)).length, 1)
})
