/**
 * Greenhouse, Lever and Ashby discovery.
 *
 * All three publish their job boards as public, unauthenticated JSON. Fetching
 * that is strictly better than driving a browser tab: it is faster, it cannot
 * break on a CSS change, it returns the full description in one request, and it
 * places no unusual load on anyone. Tab-driven scraping is reserved for the
 * sources that give us no other option.
 */

import { condenseDescription, detectWorkMode, parseSalary } from '@/shared/text'
import { hashString, uid } from '@/shared/util'
import type { Job, SearchRecipe } from '@/storage/schemas'
import { createLogger } from '@/shared/logger'
import { activity } from '@/shared/activity'

const log = createLogger('discovery:ats')

/** Strip HTML from a description without a DOM (the worker has no document). */
function htmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function makeJob(input: {
  source: string
  vendor: string
  url: string
  company: string
  title: string
  location: string
  descriptionText: string
  postedAt: number | null
  salaryText?: string
  recipeId: string
}): Job {
  const description = condenseDescription(input.descriptionText, 12000)
  const salary = parseSalary(input.salaryText || description.slice(0, 1500))
  return {
    id: uid('job'),
    source: input.source,
    vendor: input.vendor,
    url: input.url,
    applyUrl: input.url,
    company: input.company.trim(),
    title: input.title.trim(),
    location: input.location.trim(),
    workMode: detectWorkMode(`${input.title} ${input.location} ${description.slice(0, 1500)}`),
    salaryText: input.salaryText ?? '',
    salaryMin: salary.min,
    salaryMax: salary.max,
    postedAt: input.postedAt,
    descriptionText: description,
    dedupeHash: dedupeHash(input.company, input.title, input.location),
    status: 'new',
    matchScore: null,
    matchReasons: [],
    matchConcerns: [],
    rejectReason: '',
    discoveredAt: Date.now(),
    scoredAt: null,
    recipeId: input.recipeId,
  }
}

/**
 * Dedupe key. Company plus title plus a coarse location: the same role reposted
 * on a second board, or relisted next month, collapses onto one record so the
 * agent never applies twice.
 */
export function dedupeHash(company: string, title: string, location: string): string {
  const norm = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const coarseLocation = norm(location).split(' ').slice(0, 2).join(' ')
  return hashString(`${norm(company)}|${norm(title)}|${coarseLocation}`)
}

async function fetchJson<T>(url: string): Promise<T | null> {
  activity.note(`fetching ${new URL(url).hostname}`)
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) {
      log.warn(`${url} returned ${res.status}`)
      return null
    }
    return (await res.json()) as T
  } catch (e) {
    log.warn(`Could not reach ${url}`, { error: (e as Error).message })
    return null
  }
}

/* ------------------------------------------------------------ greenhouse */

type GreenhouseJob = {
  id: number
  title: string
  absolute_url: string
  updated_at?: string
  content?: string
  location?: { name?: string }
  metadata?: Array<{ name?: string; value?: unknown }>
}

export async function fetchGreenhouse(recipe: SearchRecipe): Promise<Job[]> {
  const out: Job[] = []
  for (const board of recipe.boards) {
    const token = board.trim().toLowerCase()
    if (!token) continue
    const data = await fetchJson<{ jobs?: GreenhouseJob[] }>(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`
    )
    if (!data?.jobs) continue

    for (const j of data.jobs.slice(0, recipe.maxResultsPerRun)) {
      const description = htmlToText(decodeURIComponent(escapeSafe(j.content ?? '')))
      out.push(
        makeJob({
          source: 'greenhouse',
          vendor: 'greenhouse',
          url: j.absolute_url,
          company: token.replace(/[-_]/g, ' '),
          title: j.title,
          location: j.location?.name ?? '',
          descriptionText: description,
          postedAt: j.updated_at ? Date.parse(j.updated_at) : null,
          recipeId: recipe.id,
        })
      )
    }
    log.info(`Greenhouse board ${token}: ${data.jobs.length} posting(s)`)
  }
  return out
}

/** Greenhouse returns HTML-escaped, percent-encoded content in some boards. */
function escapeSafe(content: string): string {
  try {
    // Round-trips cleanly for plain content and rescues percent-encoded content.
    return content.includes('%') ? content : encodeURIComponent(content)
  } catch {
    return content
  }
}

/* ----------------------------------------------------------------- lever */

type LeverPosting = {
  id: string
  text: string
  hostedUrl: string
  applyUrl?: string
  createdAt?: number
  categories?: { location?: string; team?: string; commitment?: string }
  descriptionPlain?: string
  lists?: Array<{ text?: string; content?: string }>
  additionalPlain?: string
}

export async function fetchLever(recipe: SearchRecipe): Promise<Job[]> {
  const out: Job[] = []
  for (const board of recipe.boards) {
    const token = board.trim().toLowerCase()
    if (!token) continue
    const data = await fetchJson<LeverPosting[]>(
      `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`
    )
    if (!Array.isArray(data)) continue

    for (const p of data.slice(0, recipe.maxResultsPerRun)) {
      const lists = (p.lists ?? []).map((l) => `${l.text ?? ''}\n${htmlToText(l.content ?? '')}`).join('\n\n')
      const description = [p.descriptionPlain ?? '', lists, p.additionalPlain ?? ''].filter(Boolean).join('\n\n')
      out.push(
        makeJob({
          source: 'lever',
          vendor: 'lever',
          url: p.applyUrl || p.hostedUrl,
          company: token.replace(/[-_]/g, ' '),
          title: p.text,
          location: p.categories?.location ?? '',
          descriptionText: description,
          postedAt: p.createdAt ?? null,
          recipeId: recipe.id,
        })
      )
    }
    log.info(`Lever board ${token}: ${data.length} posting(s)`)
  }
  return out
}

/* ----------------------------------------------------------------- ashby */

type AshbyJob = {
  id: string
  title: string
  location?: string
  jobUrl?: string
  applyUrl?: string
  publishedAt?: string
  descriptionPlain?: string
  descriptionHtml?: string
  isRemote?: boolean
  compensation?: { compensationTierSummary?: string }
}

export async function fetchAshby(recipe: SearchRecipe): Promise<Job[]> {
  const out: Job[] = []
  for (const board of recipe.boards) {
    const token = board.trim()
    if (!token) continue
    const data = await fetchJson<{ jobs?: AshbyJob[] }>(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`
    )
    if (!data?.jobs) continue

    for (const j of data.jobs.slice(0, recipe.maxResultsPerRun)) {
      out.push(
        makeJob({
          source: 'ashby',
          vendor: 'ashby',
          url: j.applyUrl || j.jobUrl || '',
          company: token.replace(/[-_]/g, ' '),
          title: j.title,
          location: j.location ?? (j.isRemote ? 'Remote' : ''),
          descriptionText: j.descriptionPlain || htmlToText(j.descriptionHtml ?? ''),
          postedAt: j.publishedAt ? Date.parse(j.publishedAt) : null,
          salaryText: j.compensation?.compensationTierSummary ?? '',
          recipeId: recipe.id,
        })
      )
    }
    log.info(`Ashby board ${token}: ${data.jobs.length} posting(s)`)
  }
  return out
}

/** Keyword filter applied after fetching a whole board. */
export function filterByKeywords(jobs: Job[], recipe: SearchRecipe): Job[] {
  if (recipe.keywords.length === 0 && !recipe.location && !recipe.remoteOnly) return jobs
  const keywords = recipe.keywords.map((k) => k.toLowerCase()).filter(Boolean)
  const location = recipe.location.toLowerCase().trim()

  return jobs.filter((job) => {
    const haystack = `${job.title} ${job.location}`.toLowerCase()
    if (keywords.length > 0 && !keywords.some((k) => haystack.includes(k))) return false
    if (recipe.remoteOnly && job.workMode !== 'remote') return false
    if (location && job.workMode !== 'remote' && !job.location.toLowerCase().includes(location)) return false
    return true
  })
}
