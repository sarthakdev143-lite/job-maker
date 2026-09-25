/**
 * Greenhouse, Lever and Ashby discovery.
 *
 * All three publish their job boards as public, unauthenticated JSON. Fetching
 * that is strictly better than driving a browser tab: it is faster, it cannot
 * break on a CSS change, it returns the full description in one request, and it
 * places no unusual load on anyone. Tab-driven scraping is reserved for the
 * sources that give us no other option.
 */

import { condenseDescription, detectWorkMode, parsePostedDate, parseSalary } from '@/shared/text'
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
  /** Relative date text from a listing card ("2 days ago"); parsed when postedAt is null. */
  postedText?: string
  salaryText?: string
  recipeId: string
  /** Full posting text arrives in the board JSON; scraped cards carry a snippet. */
  descriptionSource?: 'snippet' | 'hydrated' | 'apply_page'
  /**
   * Set when the board states the work mode itself rather than leaving it to be
   * read out of prose. SmartRecruiters returns `remote` and `hybrid` booleans
   * per posting, which is worth more than any amount of inference.
   */
  workMode?: Job['workMode']
}): Job {
  const description = condenseDescription(input.descriptionText, 12000)
  const salary = parseSalary(input.salaryText || description.slice(0, 1500))
  const postedAt = input.postedAt ?? (input.postedText ? parsePostedDate(input.postedText) : null)
  return {
    id: uid('job'),
    source: input.source,
    vendor: input.vendor,
    url: input.url,
    applyUrl: input.url,
    company: input.company.trim(),
    title: input.title.trim(),
    location: input.location.trim(),
    workMode: input.workMode ?? detectWorkMode(description.slice(0, 1500), input.location, input.title),
    salaryText: input.salaryText ?? '',
    salaryMin: salary.min,
    salaryMax: salary.max,
    postedAt,
    descriptionText: description,
    descriptionSource: input.descriptionSource ?? 'snippet',
    dedupeHash: dedupeHash(input.company, input.title, input.location),
    status: 'new',
    matchScore: null,
    matchReasons: [],
    matchConcerns: [],
    rejectReason: '',
    discoveredAt: Date.now(),
    scoredAt: null,
    recipeId: input.recipeId,
    easyApply: false,
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
    // One board must never be able to end the sweep. A single unreachable or
    // malformed board used to throw out of this loop and return nothing at
    // all, so twenty-three healthy boards were lost to one sick one.
    let data: { jobs?: GreenhouseJob[] } | null = null
    try {
      data = await fetchJson<{ jobs?: GreenhouseJob[] }>(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`
      )
    } catch (e) {
      log.warn(`Greenhouse board ${token} failed: ${(e as Error).message}`)
      continue
    }
    if (!data?.jobs) continue

    for (const j of data.jobs.slice(0, recipe.maxResultsPerRun)) {
      const description = htmlToText(decodeContent(j.content ?? ''))
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
          descriptionSource: 'hydrated',
        })
      )
    }
    log.info(`Greenhouse board ${token}: ${data.jobs.length} posting(s)`)
  }
  return out
}

/**
 * Greenhouse returns HTML-escaped content, percent-encoded on some boards.
 *
 * The previous version percent-decoded anything containing a '%', which is a
 * character job descriptions are full of: "100% remote", "20% travel".
 * `decodeURIComponent` rejects those outright, and because the throw escaped
 * the board loop, one posting advertising itself as fully remote took down the
 * entire Greenhouse sweep -- every board, every run. Decode only what actually
 * looks percent-encoded, and never let a failure lose the text.
 */
function decodeContent(content: string): string {
  if (!content) return ''
  if (!/%[0-9A-Fa-f]{2}/.test(content)) return content
  try {
    return decodeURIComponent(content)
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
    let data: LeverPosting[] | null = null
    try {
      data = await fetchJson<LeverPosting[]>(
        `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`
      )
    } catch (e) {
      log.warn(`Lever board ${token} failed: ${(e as Error).message}`)
      continue
    }
    if (!Array.isArray(data)) {
      log.warn(`Lever board ${token} returned no postings`)
      continue
    }

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
          descriptionSource: 'hydrated',
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
    let data: { jobs?: AshbyJob[] } | null = null
    try {
      data = await fetchJson<{ jobs?: AshbyJob[] }>(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`
      )
    } catch (e) {
      log.warn(`Ashby board ${token} failed: ${(e as Error).message}`)
      continue
    }
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
          descriptionSource: 'hydrated',
        })
      )
    }
    log.info(`Ashby board ${token}: ${data.jobs.length} posting(s)`)
  }
  return out
}

/** Keyword filter applied after fetching a whole board. */
/** Words too common in a job title to be worth matching on. */
const KEYWORD_NOISE = new Set([
  'and', 'the', 'with', 'for', 'of', 'in', 'an', 'at', 'to', 'on',
  'senior', 'staff', 'principal', 'lead', 'junior', 'role', 'job',
])

/**
 * Split a search phrase into the words worth matching.
 *
 * Keywords arrive from the model as whole phrases -- "principal solution
 * architect distributed systems" -- and no job title ever contains that string.
 * Matching phrases literally discarded every posting from sixty-eight boards
 * and reported an empty search, which looks exactly like a market with no jobs
 * in it.
 */
function keywordTerms(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((w) => w.length >= 2 && !KEYWORD_NOISE.has(w))
}

/** Strip the litter a job board leaves in a location string. */
function cleanLocation(raw: string): string {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !/^(undefined|null|n\/a|unknown)$/i.test(part))
    .join(', ')
}

/* ----------------------------------------------------- smartrecruiters */

type SmartRecruitersPosting = {
  id: string
  name: string
  company?: { identifier?: string; name?: string }
  releasedDate?: string
  location?: { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean }
  applyUrl?: string
  shortLocation?: string
}

/**
 * SmartRecruiters, searched by keyword rather than by board.
 *
 * The other three sources are lists of company boards, because that is all
 * Greenhouse, Lever and Ashby offer. SmartRecruiters runs one public index
 * across every employer on it -- three hundred and fifty thousand postings --
 * so the useful unit here is the search phrase, not the company.
 *
 * Two of its quirks shape this code. Only `keyword` actually filters: `remote`
 * and `country` are accepted and ignored, so geography is left to the prefilter
 * downstream. And each posting states `remote` and `hybrid` outright, which is
 * better evidence than any amount of reading between the lines of a job advert.
 */
export async function fetchSmartRecruiters(recipe: SearchRecipe): Promise<Job[]> {
  const out: Job[] = []
  const seen = new Set<string>()
  const phrases = recipe.keywords.length > 0 ? recipe.keywords : ['software engineer']
  const perPhrase = Math.max(20, Math.ceil(recipe.maxResultsPerRun / phrases.length))

  for (const phrase of phrases) {
    // The index runs a relevance search, and the phrases a model writes are
    // long: "principal solution architect distributed systems" matched sixteen
    // postings across the whole platform. Its first two or three words are the
    // part that names the job, so a thin result is retried with those.
    const words = phrase.split(/\s+/).filter(Boolean)
    const attempts = words.length > 3 ? [phrase, words.slice(0, 3).join(' '), words.slice(0, 2).join(' ')] : [phrase]

    for (const attempt of attempts) {
      const before = out.length
      await searchPhrase(qualify(attempt))
      // Enough came back on the fuller phrase; no need to widen it.
      if (out.length - before >= 10) break
    }
  }

  /**
   * Put the place and the work mode into the words, because there is nowhere
   * else to put them.
   *
   * This index takes `keyword` and nothing else: `country`, `location` and
   * `remote` are all accepted and all silently ignored, which was measured
   * against the live API rather than assumed. The keyword is matched against
   * the whole posting, so naming the country in it is the only lever there is,
   * and it is a surprisingly strong one -- "software architect" returned 19
   * Indian postings in a page of 98 and 2 remote ones, while "India remote
   * software engineer" returned 80 and 14 in the same size of page.
   */
  function qualify(phrase: string): string {
    const extra = [recipe.location, recipe.remoteOnly ? 'remote' : '']
      .map((s) => s.trim())
      .filter(Boolean)
      // Don't repeat a word the phrase already uses.
      .filter((s) => !new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(phrase))
    return extra.length === 0 ? phrase : `${extra.join(' ')} ${phrase}`
  }

  async function searchPhrase(phrase: string): Promise<void> {
    for (let offset = 0; offset < perPhrase; offset += 100) {
      let page: { content?: SmartRecruitersPosting[] } | null = null
      try {
        page = await fetchJson<{ content?: SmartRecruitersPosting[] }>(
          `https://jobs.smartrecruiters.com/sr-jobs/search?keyword=${encodeURIComponent(phrase)}&limit=100&offset=${offset}`
        )
      } catch (e) {
        log.warn(`SmartRecruiters search "${phrase}" failed: ${(e as Error).message}`)
        break
      }

      const rows = page?.content ?? []
      if (rows.length === 0) break

      for (const row of rows) {
        const applyUrl = row.applyUrl ?? ''
        if (!applyUrl || seen.has(applyUrl)) continue
        seen.add(applyUrl)

        const where = row.location ?? {}
        out.push(
          makeJob({
            source: 'smartrecruiters',
            vendor: 'smartrecruiters',
            url: applyUrl,
            company: row.company?.name ?? row.company?.identifier ?? '',
            title: row.name ?? '',
            // Their own `shortLocation` sometimes reads "Anywhere, undefined".
            location: cleanLocation(row.shortLocation ?? [where.city, where.region, where.country].join(', ')),
            // The board says so itself; nothing to infer.
            workMode: where.remote ? 'remote' : where.hybrid ? 'hybrid' : 'onsite',
            // Only the card is in the index. The apply machine reads the real
            // description off the posting when it opens it.
            descriptionText: '',
            descriptionSource: 'snippet',
            postedAt: row.releasedDate ? Date.parse(row.releasedDate) : null,
            recipeId: recipe.id,
          })
        )
      }

      if (rows.length < 100) break
    }
  }

  log.info(`SmartRecruiters: ${out.length} posting(s) across ${phrases.length} search phrase(s)`)
  return out.slice(0, recipe.maxResultsPerRun)
}

/* ------------------------------------------------------------- workable */

type WorkableJob = {
  id: string
  title: string
  company?: { title?: string }
  location?: { city?: string; countryName?: string }
  workplace?: string
  url?: string
  description?: string
  created?: string
  state?: string
}

/**
 * Workable, through its own public index of every board on the platform.
 *
 * Per-company boards were the obvious route and a dead end: the account API
 * answers for a slug but returns an empty list unless that company still posts
 * through Workable, so there is no way to build a board list without knowing
 * the answer first. The aggregate index has no such problem -- it is one search
 * across everything, the same shape as SmartRecruiters.
 *
 * It is also the most generous of the four: each record carries the full
 * description and a `workplace` field stating remote, hybrid or on-site, so
 * nothing has to be inferred and the apply machine does not need a second trip
 * to read the advert.
 */
export async function fetchWorkable(recipe: SearchRecipe): Promise<Job[]> {
  const out: Job[] = []
  const seen = new Set<string>()
  const phrases = recipe.keywords.length > 0 ? recipe.keywords : ['software engineer']
  const perPhrase = Math.max(20, Math.ceil(recipe.maxResultsPerRun / phrases.length))

  for (const phrase of phrases) {
    let token = ''
    for (let got = 0; got < perPhrase; ) {
      // Twenty is the most the index will serve: ask for twenty-five and it
      // answers 400 rather than clamping, which is why a whole sweep returned
      // nothing at all the first time this ran against the real API.
      // `location` and `workplace` are real filters here, unlike on
      // SmartRecruiters where both are accepted and quietly ignored. Verified
      // against the live index: without them a page of twenty came back almost
      // entirely onsite roles in the US and the UK, and with them every row was
      // a remote posting in the requested country. This is the difference
      // between a source that contributes nothing and one that contributes
      // most of the queue, so it is worth stating plainly.
      const url =
        `https://jobs.workable.com/api/v1/jobs?query=${encodeURIComponent(phrase)}&limit=20` +
        (recipe.location ? `&location=${encodeURIComponent(recipe.location)}` : '') +
        (recipe.remoteOnly ? '&workplace=remote' : '') +
        (token ? `&pageToken=${encodeURIComponent(token)}` : '')

      let page: { jobs?: WorkableJob[]; nextPageToken?: string } | null = null
      try {
        page = await fetchJson<{ jobs?: WorkableJob[]; nextPageToken?: string }>(url)
      } catch (e) {
        log.warn(`Workable search "${phrase}" failed: ${(e as Error).message}`)
        break
      }

      const rows = page?.jobs ?? []
      if (rows.length === 0) break

      for (const row of rows) {
        const link = row.url ?? ''
        if (!link || seen.has(link) || (row.state && row.state !== 'published')) continue
        seen.add(link)
        got++

        const where = row.location ?? {}
        out.push(
          makeJob({
            source: 'workable',
            vendor: 'workable',
            url: link,
            company: row.company?.title ?? '',
            title: row.title ?? '',
            location: [where.city, where.countryName].filter(Boolean).join(', '),
            // Stated by the board, not read out of the advert's prose.
            workMode: row.workplace === 'remote' ? 'remote' : row.workplace === 'hybrid' ? 'hybrid' : 'onsite',
            descriptionText: htmlToText(row.description ?? ''),
            descriptionSource: 'hydrated',
            postedAt: row.created ? Date.parse(row.created) : null,
            recipeId: recipe.id,
          })
        )
      }

      token = page?.nextPageToken ?? ''
      if (!token) break
    }
  }

  const where = [recipe.location, recipe.remoteOnly ? 'remote only' : ''].filter(Boolean).join(', ')
  log.info(
    `Workable: ${out.length} posting(s) across ${phrases.length} search phrase(s)${where ? ` (${where})` : ''}`
  )
  return out.slice(0, recipe.maxResultsPerRun)
}

/**
 * Fill in the adverts SmartRecruiters' index leaves out.
 *
 * The index carries the card only, so those postings arrive with an empty
 * description and get scored on their title alone -- which is how a role can be
 * queued or passed over on six words. Each posting's own endpoint has the full
 * advert, so the ones that survived the prefilter are worth one request each.
 *
 * Only what is about to be judged, never the whole sweep: this runs after the
 * cheap rules have already thrown away nineteen postings in twenty.
 */
export async function hydrateSmartRecruiters(jobs: Job[], limit = 40): Promise<void> {
  const thin = jobs.filter((j) => j.source === 'smartrecruiters' && !j.descriptionText.trim()).slice(0, limit)

  for (const job of thin) {
    const id = job.url.match(/\/(\d{6,})(?:-|$)/)?.[1]
    const company = job.url.match(/smartrecruiters\.com\/([^/]+)\//)?.[1]
    if (!id || !company) continue

    try {
      const detail = await fetchJson<{ jobAd?: { sections?: Record<string, { text?: string }> } }>(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${encodeURIComponent(id)}`
      )
      const sections = detail?.jobAd?.sections ?? {}
      const text = ['jobDescription', 'qualifications', 'additionalInformation']
        .map((key) => sections[key]?.text ?? '')
        .filter(Boolean)
        .join('\n\n')
      if (!text) continue

      job.descriptionText = condenseDescription(htmlToText(text), 12000)
      job.descriptionSource = 'hydrated'
    } catch (e) {
      log.debug(`Could not read the SmartRecruiters advert for ${job.title}: ${(e as Error).message}`)
    }
  }
}

export function filterByKeywords(jobs: Job[], recipe: SearchRecipe): Job[] {
  if (recipe.keywords.length === 0 && !recipe.location && !recipe.remoteOnly) return jobs
  const terms = recipe.keywords.flatMap(keywordTerms)
  const location = recipe.location.toLowerCase().trim()

  return jobs.filter((job) => {
    const haystack = `${job.title} ${job.location}`.toLowerCase()
    // Deliberately generous: any one distinctive word is enough. Discovery is
    // the wide end of the funnel, and the prefilter and the scorer downstream
    // are the parts that are supposed to say no.
    if (terms.length > 0 && !terms.some((t) => haystack.includes(t))) return false
    if (recipe.remoteOnly && job.workMode !== 'remote') return false
    if (location && job.workMode !== 'remote' && !job.location.toLowerCase().includes(location)) return false
    return true
  })
}
