/**
 * IndexedDB layer.
 *
 * Jobs, applications, answers, documents and logs live here because they grow
 * without bound and chrome.storage.local is a poor fit for querying. Settings
 * and the profile stay in chrome.storage.local (see settings.ts) so they are
 * readable synchronously-ish from every surface and survive a DB wipe.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import {
  AnswerBankEntrySchema,
  ApplicationSchema,
  JobSchema,
  LogEventSchema,
  StoredDocSchema,
  type AnswerBankEntry,
  type Application,
  type Job,
  type LogEvent,
  type StoredDoc,
} from './schemas'

const DB_NAME = 'autoapply'
const DB_VERSION = 1

interface AutoApplyDB extends DBSchema {
  jobs: {
    key: string
    value: Job
    indexes: { byStatus: string; byHash: string; byDiscovered: number; byScore: number }
  }
  applications: {
    key: string
    value: Application
    indexes: { byStatus: string; byJob: string; byUpdated: number }
  }
  answers: {
    key: string
    value: AnswerBankEntry
    indexes: { byQuestion: string; byUsage: number }
  }
  docs: {
    key: string
    value: StoredDoc & { blob: Blob }
    indexes: { byJob: string; byCreated: number }
  }
  logs: {
    key: string
    value: LogEvent
    indexes: { byTime: number; byLevel: string }
  }
}

let dbPromise: Promise<IDBPDatabase<AutoApplyDB>> | null = null

export function getDb(): Promise<IDBPDatabase<AutoApplyDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AutoApplyDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('jobs')) {
          const jobs = db.createObjectStore('jobs', { keyPath: 'id' })
          jobs.createIndex('byStatus', 'status')
          jobs.createIndex('byHash', 'dedupeHash', { unique: false })
          jobs.createIndex('byDiscovered', 'discoveredAt')
          jobs.createIndex('byScore', 'matchScore')
        }
        if (!db.objectStoreNames.contains('applications')) {
          const apps = db.createObjectStore('applications', { keyPath: 'id' })
          apps.createIndex('byStatus', 'status')
          apps.createIndex('byJob', 'jobId')
          apps.createIndex('byUpdated', 'updatedAt')
        }
        if (!db.objectStoreNames.contains('answers')) {
          const answers = db.createObjectStore('answers', { keyPath: 'id' })
          answers.createIndex('byQuestion', 'qNormalized')
          answers.createIndex('byUsage', 'usageCount')
        }
        if (!db.objectStoreNames.contains('docs')) {
          const docs = db.createObjectStore('docs', { keyPath: 'id' })
          docs.createIndex('byJob', 'jobId')
          docs.createIndex('byCreated', 'createdAt')
        }
        if (!db.objectStoreNames.contains('logs')) {
          const logs = db.createObjectStore('logs', { keyPath: 'id' })
          logs.createIndex('byTime', 'at')
          logs.createIndex('byLevel', 'level')
        }
      },
    })
  }
  return dbPromise
}

/**
 * Records are parsed on the way out. A record written by an older build that
 * no longer satisfies the schema is dropped rather than crashing the caller.
 */
function safeParse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, value: unknown): T | null {
  const r = schema.safeParse(value)
  return r.success && r.data !== undefined ? r.data : null
}

/* ------------------------------------------------------------------- jobs */

export const jobsRepo = {
  async put(job: Job): Promise<void> {
    const db = await getDb()
    await db.put('jobs', JobSchema.parse(job))
  },

  async putMany(jobs: Job[]): Promise<void> {
    const db = await getDb()
    const tx = db.transaction('jobs', 'readwrite')
    await Promise.all(jobs.map((j) => tx.store.put(JobSchema.parse(j))))
    await tx.done
  },

  async get(id: string): Promise<Job | null> {
    const db = await getDb()
    return safeParse<Job>(JobSchema, await db.get('jobs', id))
  },

  async byHash(hash: string): Promise<Job | null> {
    const db = await getDb()
    const hit = await db.getFromIndex('jobs', 'byHash', hash)
    return hit ? safeParse<Job>(JobSchema, hit) : null
  },

  async exists(hash: string): Promise<boolean> {
    return (await jobsRepo.byHash(hash)) !== null
  },

  async byStatus(status: string, limit = 200): Promise<Job[]> {
    const db = await getDb()
    const rows = await db.getAllFromIndex('jobs', 'byStatus', status)
    return rows
      .map((r) => safeParse<Job>(JobSchema, r))
      .filter((r): r is Job => r !== null)
      .sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1) || b.discoveredAt - a.discoveredAt)
      .slice(0, limit)
  },

  async all(limit = 500): Promise<Job[]> {
    const db = await getDb()
    const rows = await db.getAll('jobs')
    return rows
      .map((r) => safeParse<Job>(JobSchema, r))
      .filter((r): r is Job => r !== null)
      .sort((a, b) => b.discoveredAt - a.discoveredAt)
      .slice(0, limit)
  },

  async update(id: string, patch: Partial<Job>): Promise<Job | null> {
    const existing = await jobsRepo.get(id)
    if (!existing) return null
    const merged = JobSchema.parse({ ...existing, ...patch })
    const db = await getDb()
    await db.put('jobs', merged)
    return merged
  },

  async delete(id: string): Promise<void> {
    const db = await getDb()
    await db.delete('jobs', id)
  },

  async count(): Promise<number> {
    const db = await getDb()
    return db.count('jobs')
  },

  /** Drop rejected/skipped jobs older than `days` so the store stays small. */
  async prune(days = 60): Promise<number> {
    const db = await getDb()
    const cutoff = Date.now() - days * 86400000
    const all = await db.getAll('jobs')
    let removed = 0
    const tx = db.transaction('jobs', 'readwrite')
    for (const row of all) {
      const job = safeParse<Job>(JobSchema, row)
      if (!job) continue
      const disposable = job.status === 'rejected' || job.status === 'skipped'
      if (disposable && job.discoveredAt < cutoff) {
        await tx.store.delete(job.id)
        removed++
      }
    }
    await tx.done
    return removed
  },
}

/* ----------------------------------------------------------- applications */

export const applicationsRepo = {
  async put(app: Application): Promise<void> {
    const db = await getDb()
    await db.put('applications', ApplicationSchema.parse({ ...app, updatedAt: Date.now() }))
  },

  async get(id: string): Promise<Application | null> {
    const db = await getDb()
    return safeParse<Application>(ApplicationSchema, await db.get('applications', id))
  },

  async byJob(jobId: string): Promise<Application | null> {
    const db = await getDb()
    const hit = await db.getFromIndex('applications', 'byJob', jobId)
    return hit ? safeParse<Application>(ApplicationSchema, hit) : null
  },

  async byStatus(status: string, limit = 200): Promise<Application[]> {
    const db = await getDb()
    const rows = await db.getAllFromIndex('applications', 'byStatus', status)
    return rows
      .map((r) => safeParse<Application>(ApplicationSchema, r))
      .filter((r): r is Application => r !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
  },

  async all(limit = 500): Promise<Application[]> {
    const db = await getDb()
    const rows = await db.getAll('applications')
    return rows
      .map((r) => safeParse<Application>(ApplicationSchema, r))
      .filter((r): r is Application => r !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
  },

  async update(id: string, patch: Partial<Application>): Promise<Application | null> {
    const existing = await applicationsRepo.get(id)
    if (!existing) return null
    const merged = ApplicationSchema.parse({ ...existing, ...patch, updatedAt: Date.now() })
    const db = await getDb()
    await db.put('applications', merged)
    return merged
  },

  /** Append a timeline entry without rewriting the caller's whole record. */
  async addTimeline(id: string, step: string, detail = '', level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    const existing = await applicationsRepo.get(id)
    if (!existing) return
    existing.timeline.push({ at: Date.now(), step, detail, level })
    // Keep timelines bounded; the log store holds the full history.
    if (existing.timeline.length > 200) existing.timeline = existing.timeline.slice(-200)
    await applicationsRepo.put(existing)
  },

  async delete(id: string): Promise<void> {
    const db = await getDb()
    await db.delete('applications', id)
  },

  async submittedSince(ts: number): Promise<Application[]> {
    const rows = await applicationsRepo.byStatus('submitted', 1000)
    return rows.filter((a) => (a.submittedAt ?? 0) >= ts)
  },

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await applicationsRepo.all(5000)
    const out: Record<string, number> = {}
    for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1
    return out
  },
}

/* ------------------------------------------------------------- answer bank */

export const answersRepo = {
  async put(entry: AnswerBankEntry): Promise<void> {
    const db = await getDb()
    await db.put('answers', AnswerBankEntrySchema.parse(entry))
  },

  async get(id: string): Promise<AnswerBankEntry | null> {
    const db = await getDb()
    return safeParse<AnswerBankEntry>(AnswerBankEntrySchema, await db.get('answers', id))
  },

  async byQuestion(qNormalized: string): Promise<AnswerBankEntry | null> {
    const db = await getDb()
    const hit = await db.getFromIndex('answers', 'byQuestion', qNormalized)
    return hit ? safeParse<AnswerBankEntry>(AnswerBankEntrySchema, hit) : null
  },

  async all(): Promise<AnswerBankEntry[]> {
    const db = await getDb()
    const rows = await db.getAll('answers')
    return rows
      .map((r) => safeParse<AnswerBankEntry>(AnswerBankEntrySchema, r))
      .filter((r): r is AnswerBankEntry => r !== null)
      .sort((a, b) => b.usageCount - a.usageCount)
  },

  async delete(id: string): Promise<void> {
    const db = await getDb()
    await db.delete('answers', id)
  },

  async touch(id: string): Promise<void> {
    const entry = await answersRepo.get(id)
    if (!entry) return
    entry.usageCount += 1
    entry.lastUsed = Date.now()
    await answersRepo.put(entry)
  },

  async count(): Promise<number> {
    const db = await getDb()
    return db.count('answers')
  },
}

/* -------------------------------------------------------------- documents */

export const docsRepo = {
  async put(meta: StoredDoc, blob: Blob): Promise<void> {
    const db = await getDb()
    await db.put('docs', { ...StoredDocSchema.parse({ ...meta, sizeBytes: blob.size }), blob })
  },

  async get(id: string): Promise<{ meta: StoredDoc; blob: Blob } | null> {
    const db = await getDb()
    const row = await db.get('docs', id)
    if (!row) return null
    const { blob, ...meta } = row
    const parsed = safeParse<StoredDoc>(StoredDocSchema, meta)
    return parsed ? { meta: parsed, blob } : null
  },

  async byJob(jobId: string): Promise<StoredDoc[]> {
    const db = await getDb()
    const rows = await db.getAllFromIndex('docs', 'byJob', jobId)
    return rows
      .map(({ blob: _blob, ...meta }) => safeParse<StoredDoc>(StoredDocSchema, meta))
      .filter((r): r is StoredDoc => r !== null)
  },

  async delete(id: string): Promise<void> {
    const db = await getDb()
    await db.delete('docs', id)
  },

  async prune(days = 90): Promise<number> {
    const db = await getDb()
    const cutoff = Date.now() - days * 86400000
    const rows = await db.getAll('docs')
    let removed = 0
    const tx = db.transaction('docs', 'readwrite')
    for (const row of rows) {
      if (row.createdAt < cutoff) {
        await tx.store.delete(row.id)
        removed++
      }
    }
    await tx.done
    return removed
  },
}

/* ------------------------------------------------------------------- logs */

export const logsRepo = {
  async put(event: LogEvent): Promise<void> {
    const db = await getDb()
    await db.put('logs', LogEventSchema.parse(event))
  },

  async recent(limit = 300): Promise<LogEvent[]> {
    const db = await getDb()
    const rows = await db.getAllFromIndex('logs', 'byTime')
    return rows
      .map((r) => safeParse<LogEvent>(LogEventSchema, r))
      .filter((r): r is LogEvent => r !== null)
      .reverse()
      .slice(0, limit)
  },

  async clear(): Promise<void> {
    const db = await getDb()
    await db.clear('logs')
  },

  /** Keep the log store from growing forever; called after each run. */
  async trim(max = 3000): Promise<void> {
    const db = await getDb()
    const count = await db.count('logs')
    if (count <= max) return
    const rows = await db.getAllFromIndex('logs', 'byTime')
    const excess = rows.slice(0, count - max)
    const tx = db.transaction('logs', 'readwrite')
    for (const row of excess) await tx.store.delete(row.id)
    await tx.done
  },
}

/* ------------------------------------------------------------ maintenance */

export async function wipeAll(): Promise<void> {
  const db = await getDb()
  await Promise.all([
    db.clear('jobs'),
    db.clear('applications'),
    db.clear('answers'),
    db.clear('docs'),
    db.clear('logs'),
  ])
}

export async function dbStats(): Promise<Record<string, number>> {
  const db = await getDb()
  const [jobs, applications, answers, docs, logs] = await Promise.all([
    db.count('jobs'),
    db.count('applications'),
    db.count('answers'),
    db.count('docs'),
    db.count('logs'),
  ])
  return { jobs, applications, answers, docs, logs }
}
