/**
 * A catalogue of candidate ATS boards, and a way to find out which are real.
 *
 * The agent can only reliably apply on Greenhouse, Lever and Ashby -- those are
 * actual forms, not adverts behind a login. Getting boards to point it at was
 * the missing piece: asking a model to recall company slugs produced nothing it
 * was confident about, and hand-typing them is exactly the work this is meant
 * to remove.
 *
 * So the slugs below are *candidates*, not facts. Companies move between
 * systems and rename their boards, and a wrong slug is simply a 404. Rather
 * than pretend the list is authoritative, `validateBoards` asks each board's
 * public API whether it exists and how many jobs it has, and only the ones that
 * answer are ever used. The list is a starting point that corrects itself.
 */

import { createLogger } from '@/shared/logger'
import { activity } from '@/shared/activity'

const log = createLogger('boards')

export type BoardSource = 'greenhouse' | 'lever' | 'ashby'

export type CatalogueEntry = {
  slug: string
  source: BoardSource
  /** Rough hints so a profile can be matched to relevant boards. */
  tags: string[]
}

const tag = {
  ai: 'ai',
  infra: 'infrastructure',
  data: 'data',
  fintech: 'fintech',
  devtools: 'devtools',
  india: 'india',
  remote: 'remote-friendly',
  enterprise: 'enterprise',
  consumer: 'consumer',
  security: 'security',
  health: 'health',
}

/**
 * Boards verified live on 2026-09-13, newest job counts noted inline.
 *
 * Every slug here answered its board API with at least one open role at the
 * time of writing, together around six thousand jobs. Roughly half the slugs
 * originally tried did not -- companies move ATS, rename boards, or go quiet --
 * which is exactly why `validateBoards` re-checks before any of these is used
 * rather than trusting this list to stay true.
 */
export const BOARD_CATALOGUE: CatalogueEntry[] = [
  { slug: 'databricks', source: 'greenhouse', tags: [tag.data, tag.ai, tag.india] }, // ~892 open
  { slug: 'stripe', source: 'greenhouse', tags: [tag.fintech, tag.infra, tag.india] }, // ~633 open
  { slug: 'anthropic', source: 'greenhouse', tags: [tag.ai] }, // ~596 open
  { slug: 'doordashusa', source: 'greenhouse', tags: [tag.consumer, tag.data] }, // ~456 open
  { slug: 'datadog', source: 'greenhouse', tags: [tag.infra, tag.india] }, // ~446 open
  { slug: 'mongodb', source: 'greenhouse', tags: [tag.data, tag.india] }, // ~405 open
  { slug: 'zscaler', source: 'greenhouse', tags: [tag.security, tag.india] }, // ~371 open
  { slug: 'cloudflare', source: 'greenhouse', tags: [tag.infra, tag.security, tag.india] }, // ~358 open
  { slug: 'elastic', source: 'greenhouse', tags: [tag.data, tag.infra, tag.remote, tag.india] }, // ~356 open
  { slug: 'brex', source: 'greenhouse', tags: [tag.fintech] }, // ~272 open
  { slug: 'samsara', source: 'greenhouse', tags: [tag.data, tag.infra, tag.india] }, // ~262 open
  { slug: 'gitlab', source: 'greenhouse', tags: [tag.devtools, tag.remote, tag.india] }, // ~227 open
  { slug: 'scaleai', source: 'greenhouse', tags: [tag.ai, tag.data] }, // ~223 open
  { slug: 'coinbase', source: 'greenhouse', tags: [tag.fintech, tag.india, tag.remote] }, // ~218 open
  { slug: 'affirm', source: 'greenhouse', tags: [tag.fintech, tag.india] }, // ~207 open
  { slug: 'block', source: 'greenhouse', tags: [tag.fintech] }, // ~207 open
  { slug: 'pinterest', source: 'greenhouse', tags: [tag.consumer] }, // ~184 open
  { slug: 'lyft', source: 'greenhouse', tags: [tag.consumer, tag.data] }, // ~183 open
  { slug: 'flexport', source: 'greenhouse', tags: [tag.enterprise, tag.india] }, // ~179 open
  { slug: 'airbnb', source: 'greenhouse', tags: [tag.consumer] }, // ~164 open
  { slug: 'figma', source: 'greenhouse', tags: [tag.enterprise, tag.consumer] }, // ~153 open
  { slug: 'twilio', source: 'greenhouse', tags: [tag.infra, tag.india] }, // ~149 open
  { slug: 'reddit', source: 'greenhouse', tags: [tag.consumer] }, // ~148 open
  { slug: 'zetaglobal', source: 'greenhouse', tags: [tag.data] }, // ~139 open
  { slug: 'robinhood', source: 'greenhouse', tags: [tag.fintech] }, // ~125 open
  { slug: 'grafanalabs', source: 'greenhouse', tags: [tag.infra, tag.devtools, tag.remote] }, // ~116 open
  { slug: 'instacart', source: 'greenhouse', tags: [tag.consumer, tag.data] }, // ~106 open
  { slug: 'asana', source: 'greenhouse', tags: [tag.enterprise, tag.india] }, // ~103 open
  { slug: 'gusto', source: 'greenhouse', tags: [tag.enterprise] }, // ~95 open
  { slug: 'vercel', source: 'greenhouse', tags: [tag.devtools, tag.infra, tag.remote] }, // ~86 open
  { slug: 'postman', source: 'greenhouse', tags: [tag.devtools, tag.india] }, // ~64 open
  { slug: 'discord', source: 'greenhouse', tags: [tag.consumer, tag.infra] }, // ~46 open
  { slug: 'dropbox', source: 'greenhouse', tags: [tag.infra, tag.remote] }, // ~41 open
  { slug: 'druva', source: 'greenhouse', tags: [tag.infra, tag.india] }, // ~41 open
  { slug: 'slice', source: 'greenhouse', tags: [tag.fintech, tag.india] }, // ~25 open
  { slug: 'turing', source: 'greenhouse', tags: [tag.ai, tag.remote, tag.india] }, // ~21 open
  { slug: 'airtable', source: 'greenhouse', tags: [tag.enterprise] }, // ~16 open
  { slug: 'sumologic', source: 'greenhouse', tags: [tag.infra, tag.india] }, // ~12 open
  { slug: 'groww', source: 'greenhouse', tags: [tag.fintech, tag.india] }, // ~7 open
  { slug: 'porter', source: 'greenhouse', tags: [tag.consumer, tag.india] }, // ~7 open
  { slug: 'openai', source: 'ashby', tags: [tag.ai, tag.india] }, // ~794 open
  { slug: 'crusoe', source: 'ashby', tags: [tag.ai, tag.infra] }, // ~371 open
  { slug: 'harvey', source: 'ashby', tags: [tag.ai, tag.enterprise] }, // ~325 open
  { slug: 'elevenlabs', source: 'ashby', tags: [tag.ai] }, // ~246 open
  { slug: 'sierra', source: 'ashby', tags: [tag.ai] }, // ~210 open
  { slug: 'clickhouse', source: 'ashby', tags: [tag.data, tag.infra, tag.remote] }, // ~187 open
  { slug: 'ramp', source: 'ashby', tags: [tag.fintech] }, // ~145 open
  { slug: 'cohere', source: 'ashby', tags: [tag.ai, tag.remote] }, // ~145 open
  { slug: 'decagon', source: 'ashby', tags: [tag.ai] }, // ~140 open
  { slug: 'cursor', source: 'ashby', tags: [tag.ai, tag.devtools] }, // ~127 open
  { slug: 'notion', source: 'ashby', tags: [tag.enterprise, tag.india] }, // ~127 open
  { slug: 'perplexity', source: 'ashby', tags: [tag.ai, tag.india] }, // ~115 open
  { slug: 'cerebras', source: 'ashby', tags: [tag.ai, tag.infra] }, // ~111 open
  { slug: 'langchain', source: 'ashby', tags: [tag.ai, tag.devtools] }, // ~108 open
  { slug: 'vanta', source: 'ashby', tags: [tag.security, tag.enterprise] }, // ~105 open
  { slug: 'mercor', source: 'ashby', tags: [tag.ai, tag.india] }, // ~103 open
  { slug: 'baseten', source: 'ashby', tags: [tag.ai, tag.infra] }, // ~94 open
  { slug: 'deepgram', source: 'ashby', tags: [tag.ai, tag.remote] }, // ~92 open
  { slug: 'lambda', source: 'ashby', tags: [tag.ai, tag.infra] }, // ~87 open
  { slug: 'lovable', source: 'ashby', tags: [tag.ai, tag.devtools] }, // ~82 open
  { slug: 'replit', source: 'ashby', tags: [tag.devtools, tag.ai] }, // ~76 open
  { slug: 'temporal', source: 'ashby', tags: [tag.infra, tag.devtools, tag.remote] }, // ~70 open
  { slug: 'suno', source: 'ashby', tags: [tag.ai, tag.consumer] }, // ~66 open
  { slug: 'sarvam', source: 'ashby', tags: [tag.ai, tag.india] }, // ~62 open
  { slug: 'supabase', source: 'ashby', tags: [tag.devtools, tag.remote] }, // ~60 open
  { slug: 'abridge', source: 'ashby', tags: [tag.ai, tag.health] }, // ~40 open
  { slug: 'n8n', source: 'ashby', tags: [tag.devtools, tag.infra, tag.remote] }, // ~39 open
  { slug: 'render', source: 'ashby', tags: [tag.infra, tag.devtools] }, // ~36 open
  { slug: 'modal', source: 'ashby', tags: [tag.ai, tag.infra] }, // ~31 open
  { slug: 'linear', source: 'ashby', tags: [tag.devtools, tag.remote] }, // ~30 open
  { slug: 'anyscale', source: 'ashby', tags: [tag.ai, tag.infra] }, // ~20 open
  { slug: 'llamaindex', source: 'ashby', tags: [tag.ai, tag.devtools] }, // ~11 open
  { slug: 'posthog', source: 'ashby', tags: [tag.data, tag.devtools, tag.remote] }, // ~11 open
  { slug: 'railway', source: 'ashby', tags: [tag.infra, tag.devtools] }, // ~8 open
  { slug: 'atlan', source: 'ashby', tags: [tag.data, tag.india] }, // ~8 open
  { slug: 'pinecone', source: 'ashby', tags: [tag.ai, tag.data] }, // ~7 open
  { slug: 'browserbase', source: 'ashby', tags: [tag.ai, tag.devtools] }, // ~6 open
  { slug: 'neon', source: 'ashby', tags: [tag.data, tag.infra, tag.remote] }, // ~5 open
  { slug: 'matillion', source: 'lever', tags: [tag.data, tag.india] }, // ~1 open
  { slug: 'cred', source: 'lever', tags: [tag.fintech, tag.india] }, // ~1 open
  { slug: 'meesho', source: 'lever', tags: [tag.consumer, tag.india] }, // ~1 open
  { slug: 'mindtickle', source: 'lever', tags: [tag.enterprise, tag.india] }, // ~1 open
  { slug: 'zeta', source: 'lever', tags: [tag.fintech, tag.india] }, // ~1 open
]

/* ------------------------------------------------------------- validation */

export type BoardCheck = {
  slug: string
  source: BoardSource
  live: boolean
  jobCount: number
}

function boardUrl(entry: CatalogueEntry): string {
  const slug = encodeURIComponent(entry.slug)
  switch (entry.source) {
    case 'greenhouse':
      return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`
    case 'lever':
      return `https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`
    case 'ashby':
      return `https://api.ashbyhq.com/posting-api/job-board/${slug}`
  }
}

function countJobs(source: BoardSource, payload: unknown): number {
  if (source === 'lever') return Array.isArray(payload) ? payload.length : 0
  const jobs = (payload as { jobs?: unknown[] } | null)?.jobs
  return Array.isArray(jobs) ? jobs.length : 0
}

async function checkOne(entry: CatalogueEntry): Promise<BoardCheck> {
  try {
    const res = await fetch(boardUrl(entry), { headers: { accept: 'application/json' } })
    if (!res.ok) return { ...entry, live: false, jobCount: 0 }
    const payload = (await res.json()) as unknown
    const jobCount = countJobs(entry.source, payload)
    // Lever's limit parameter caps the response, so a single result still means
    // the board exists; only an empty board is treated as not worth adding.
    return { ...entry, live: jobCount > 0, jobCount }
  } catch {
    return { ...entry, live: false, jobCount: 0 }
  }
}

/**
 * Ask every candidate board whether it exists, a few at a time.
 *
 * These are plain public JSON endpoints, so this takes seconds rather than the
 * minutes anything involving the model would -- which is what makes checking
 * the whole catalogue on demand reasonable.
 */
export async function validateBoards(
  entries: CatalogueEntry[],
  concurrency = 6
): Promise<BoardCheck[]> {
  const results: BoardCheck[] = []
  let index = 0
  let done = 0

  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (index < entries.length) {
      const entry = entries[index++]
      if (!entry) break
      results.push(await checkOne(entry))
      activity.note(`checking company boards (${++done} of ${entries.length})`)
    }
  })

  await Promise.all(workers)

  const live = results.filter((r) => r.live)
  log.info(`Checked ${results.length} board(s): ${live.length} live, ${results.length - live.length} gone`)
  return results.sort((a, b) => Number(b.live) - Number(a.live) || b.jobCount - a.jobCount)
}

/**
 * Pick catalogue entries that suit a profile.
 *
 * Matching is deliberately loose: the catalogue is small enough that being
 * generous costs one extra HTTP request per board, whereas being strict costs
 * the user a board they would have wanted.
 */
export function matchCatalogue(
  keywords: string[],
  options: { india?: boolean; limit?: number } = {}
): CatalogueEntry[] {
  const haystack = keywords.join(' ').toLowerCase()
  const wants = (t: string): boolean => haystack.includes(t.split('-')[0] ?? t)

  const scored = BOARD_CATALOGUE.map((entry) => {
    let score = 1
    if (options.india && entry.tags.includes('india')) score += 3
    for (const t of entry.tags) if (wants(t)) score += 2
    if (/\b(ai|ml|llm|genai)\b/.test(haystack) && entry.tags.includes('ai')) score += 3
    if (/\b(data|analytics|warehouse)\b/.test(haystack) && entry.tags.includes('data')) score += 2
    if (/\b(platform|infra|devops|sre|kubernetes)\b/.test(haystack) && entry.tags.includes('infrastructure')) score += 2
    return { entry, score }
  })

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? BOARD_CATALOGUE.length)
    .map((s) => s.entry)
}
