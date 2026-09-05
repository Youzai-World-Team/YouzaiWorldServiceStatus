import type { StatusHistorySample, StatusSnapshot } from '../../shared/status.ts'

export const STATUS_RETENTION_HOURS = 72
export const STATUS_RETENTION_MS = STATUS_RETENTION_HOURS * 60 * 60 * 1000
export const STATUS_BUCKET_MS = 5 * 60 * 1000

interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  run(): Promise<unknown>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
}

interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike
  exec?(query: string): Promise<unknown>
}

interface CloudflareSource {
  env?: Record<string, unknown>
  context?: {
    env?: Record<string, unknown>
    cloudflare?: { env?: Record<string, unknown> }
    _platform?: {
      cloudflare?: { env?: Record<string, unknown> }
    }
  }
  cloudflare?: { env?: Record<string, unknown> }
  _platform?: {
    cloudflare?: { env?: Record<string, unknown> }
  }
}

const memorySamples = new Map<number, StatusHistorySample>()
const schemaPromises = new WeakMap<object, Promise<void>>()

function databaseFrom(source?: unknown): D1DatabaseLike | null {
  const candidate = source as CloudflareSource | undefined
  // Nitro's Cloudflare adapter has used a few context layouts across releases.
  // Inspect every possible environment instead of selecting the first truthy
  // object: an empty `event.env` must not hide `event.context._platform...env`.
  const environments: Array<Record<string, unknown> | undefined> = [
    candidate?.env,
    candidate?.context?.env,
    candidate?.context?.cloudflare?.env,
    candidate?.context?._platform?.cloudflare?.env,
    candidate?.cloudflare?.env,
    candidate?._platform?.cloudflare?.env,
    (globalThis as typeof globalThis & { __env__?: Record<string, unknown> }).__env__,
  ]
  for (const env of environments) {
    const db = env?.DB
    if (db && typeof (db as D1DatabaseLike).prepare === 'function') return db as D1DatabaseLike
  }
  return null
}

async function ensureSchema(db: D1DatabaseLike): Promise<void> {
  const existing = schemaPromises.get(db as object)
  if (existing) return existing
  const promise = (async () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS status_samples (
        captured_at INTEGER PRIMARY KEY,
        overall TEXT NOT NULL,
        services_json TEXT NOT NULL,
        node_json TEXT NOT NULL,
        minecraft_json TEXT NOT NULL,
        errors_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS status_samples_captured_idx
        ON status_samples (captured_at DESC);
    `
    if (db.exec) {
      await db.exec(sql)
      return
    }
    await db.prepare(`CREATE TABLE IF NOT EXISTS status_samples (
      captured_at INTEGER PRIMARY KEY,
      overall TEXT NOT NULL,
      services_json TEXT NOT NULL,
      node_json TEXT NOT NULL,
      minecraft_json TEXT NOT NULL,
      errors_json TEXT NOT NULL
    )`).run()
    await db.prepare('CREATE INDEX IF NOT EXISTS status_samples_captured_idx ON status_samples (captured_at DESC)').run()
  })()
  schemaPromises.set(db as object, promise)
  try {
    await promise
  } catch (error) {
    // Do not permanently cache a transient D1/network failure. A later request
    // should be able to retry schema initialization.
    schemaPromises.delete(db as object)
    throw error
  }
}

function bucketTimestamp(timestamp: number): number {
  return Math.floor(timestamp / STATUS_BUCKET_MS) * STATUS_BUCKET_MS
}

function sampleFromSnapshot(snapshot: StatusSnapshot): StatusHistorySample {
  return {
    capturedAt: bucketTimestamp(snapshot.generatedAt),
    overall: snapshot.overall,
    services: snapshot.services,
    node: snapshot.node,
    minecraft: snapshot.minecraft,
    errors: {
      ...(snapshot.errors.node ? { node: snapshot.errors.node } : {}),
      ...(snapshot.errors.minecraft ? { minecraft: snapshot.errors.minecraft } : {}),
    },
  }
}

function snapshotFromSample(sample: StatusHistorySample): StatusSnapshot {
  return {
    generatedAt: sample.capturedAt,
    refreshAfterMs: STATUS_BUCKET_MS,
    overall: sample.overall,
    services: sample.services,
    node: sample.node,
    minecraft: sample.minecraft,
    history: [],
    errors: { ...sample.errors },
  }
}

function pruneMemory(now: number): void {
  const cutoff = now - STATUS_RETENTION_MS
  for (const capturedAt of memorySamples.keys()) {
    if (capturedAt < cutoff) memorySamples.delete(capturedAt)
  }
}

export async function saveStatusSnapshot(snapshot: StatusSnapshot, source?: unknown): Promise<StatusHistorySample> {
  const sample = sampleFromSnapshot(snapshot)
  memorySamples.set(sample.capturedAt, sample)
  pruneMemory(Date.now())

  const db = databaseFrom(source)
  if (!db) return sample

  await ensureSchema(db)
  await db.prepare(`
    INSERT OR REPLACE INTO status_samples
      (captured_at, overall, services_json, node_json, minecraft_json, errors_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    sample.capturedAt,
    sample.overall,
    JSON.stringify(sample.services),
    JSON.stringify(sample.node),
    JSON.stringify(sample.minecraft),
    JSON.stringify(sample.errors),
  ).run()
  await db.prepare('DELETE FROM status_samples WHERE captured_at < ?').bind(Date.now() - STATUS_RETENTION_MS).run()
  return sample
}

function parseSample(row: Record<string, unknown>): StatusHistorySample | null {
  try {
    const capturedAt = Number(row.captured_at)
    if (!Number.isFinite(capturedAt)) return null
    const services = JSON.parse(String(row.services_json))
    const node = JSON.parse(String(row.node_json))
    const minecraft = JSON.parse(String(row.minecraft_json))
    const errors = JSON.parse(String(row.errors_json))
    if (!Array.isArray(services) || !node || !minecraft || !errors) return null
    return {
      capturedAt,
      overall: String(row.overall) as StatusHistorySample['overall'],
      services,
      node,
      minecraft,
      errors,
    }
  } catch {
    return null
  }
}

export async function getStatusHistory(source?: unknown, hours = STATUS_RETENTION_HOURS): Promise<StatusHistorySample[]> {
  const requestedHours = Number(hours)
  const boundedHours = Number.isFinite(requestedHours)
    ? Math.min(STATUS_RETENTION_HOURS, Math.max(1, requestedHours))
    : STATUS_RETENTION_HOURS
  const cutoff = Date.now() - boundedHours * 60 * 60 * 1000
  const db = databaseFrom(source)
  if (db) {
    await ensureSchema(db)
    // History reads are also a cleanup opportunity when a scheduled invocation
    // was delayed or temporarily disabled.
    await db.prepare('DELETE FROM status_samples WHERE captured_at < ?').bind(Date.now() - STATUS_RETENTION_MS).run()
    const result = await db.prepare(`
      SELECT captured_at, overall, services_json, node_json, minecraft_json, errors_json
      FROM status_samples
      WHERE captured_at >= ?
      ORDER BY captured_at ASC
    `).bind(cutoff).all<Record<string, unknown>>()
    return result.results.map(parseSample).filter((sample): sample is StatusHistorySample => sample !== null)
  }
  return getMemoryStatusHistory(boundedHours)
}

export function getMemoryStatusHistory(hours = STATUS_RETENTION_HOURS): StatusHistorySample[] {
  const requestedHours = Number(hours)
  const boundedHours = Number.isFinite(requestedHours)
    ? Math.min(STATUS_RETENTION_HOURS, Math.max(1, requestedHours))
    : STATUS_RETENTION_HOURS
  const cutoff = Date.now() - boundedHours * 60 * 60 * 1000
  pruneMemory(Date.now())
  return [...memorySamples.values()].filter((sample) => sample.capturedAt >= cutoff).sort((a, b) => a.capturedAt - b.capturedAt)
}

export async function getLatestStatusSnapshot(source?: unknown): Promise<StatusSnapshot | null> {
  const db = databaseFrom(source)
  if (db) {
    await ensureSchema(db)
    const cutoff = Date.now() - STATUS_RETENTION_MS
    await db.prepare('DELETE FROM status_samples WHERE captured_at < ?').bind(cutoff).run()
    const result = await db.prepare(`
      SELECT captured_at, overall, services_json, node_json, minecraft_json, errors_json
      FROM status_samples
      WHERE captured_at >= ?
      ORDER BY captured_at DESC
      LIMIT 1
    `).bind(cutoff).all<Record<string, unknown>>()
    const sample = result.results.map(parseSample).find((item): item is StatusHistorySample => item !== null)
    return sample ? snapshotFromSample(sample) : null
  }
  return getLatestMemoryStatusSnapshot()
}

export function getLatestMemoryStatusSnapshot(): StatusSnapshot | null {
  const sample = getMemoryStatusHistory().at(-1)
  return sample ? snapshotFromSample(sample) : null
}

export function historyPoints(samples: StatusHistorySample[], max = 96): { time: number; status: 'online' | 'offline' }[] {
  const limit = Number.isFinite(Number(max)) ? Math.max(0, Math.trunc(Number(max))) : 96
  if (!limit) return []
  const points = samples
    .map((sample) => ({
      time: sample.capturedAt,
      status: sample.node.status === 'operational' || sample.node.status === 'degraded' ? 'online' as const : 'offline' as const,
    }))
  if (points.length <= limit) return points

  // The monitor samples every five minutes (up to 288 samples per day), while
  // the compact charts render 96 bars. Aggregate across the complete requested
  // interval instead of slicing to the last eight hours. A bucket is considered
  // offline when any contained sample was offline, so brief outages stay visible.
  return Array.from({ length: limit }, (_, index) => {
    const start = Math.floor(index * points.length / limit)
    const end = Math.floor((index + 1) * points.length / limit)
    const bucket = points.slice(start, Math.max(start + 1, end))
    return {
      time: bucket[bucket.length - 1]!.time,
      status: bucket.some((point) => point.status === 'offline') ? 'offline' as const : 'online' as const,
    }
  })
}
