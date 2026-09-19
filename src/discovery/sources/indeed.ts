/**
 * Indeed discovery, tuned for remote roles and for volume.
 *
 * Indeed publishes no usable JSON board, so this drives a tab: open a search
 * URL, scroll it the way a reader would, read the listing cards. That much is
 * unchanged from the older shared scraper. What is different here is that
 * Indeed is now the primary source rather than an afterthought, which makes
 * three things matter that did not before.
 *
 * First, *remote* has to be enforced in the query, not filtered out afterwards.
 * Asking for "software engineer" and discarding the on-site results afterwards
 * wastes the expensive part -- opening each job page to read its description --
 * on listings that were never eligible.
 *
 * Second, a search is not one URL. It is every role phrase, on every domain the
 * user cares about, across several pages of results. One page of one phrase is
 * roughly fifteen jobs; a night's work needs hundreds.
 *
 * Third, whether a listing is *Indeed Easy Apply* changes everything downstream.
 * Easy Apply forms are prefilled from the user's Indeed account and take
 * seconds; everything else redirects to a company ATS and costs a full
 * form-filling pass. Recording which is which on the job lets the runner do the
 * cheap ones first.
 *
 * The scrape functions are injected with chrome.scripting.executeScript, which
 * serialises them to source text -- so they must be entirely self-contained. No
 * imports, no closure variables, no shared helpers. That duplication is
 * deliberate and load-bearing; factoring it out breaks injection at runtime.
 */

import { createLogger } from '@/shared/logger'
import { jitter, pause, sleep } from '@/shared/util'
import { durableSleep } from '@/shared/keepalive'
import { closeWorkerWindow, openWorkerWindow } from '@/shared/windows'
import { activity } from '@/shared/activity'
import type { Job, SearchRecipe } from '@/storage/schemas'
import { makeJob } from './ats-apis'

const log = createLogger('discovery:indeed')

/**
 * The domains searched by default.
 *
 * Indeed partitions its index by country, and a role posted to the Indian site
 * is often absent from the US one even when it is fully remote. Searching both
 * roughly doubles the pool at the cost of some overlap, which the dedupe hash
 * removes for free.
 */
export const INDEED_DOMAINS = ['www.indeed.com', 'in.indeed.com'] as const

/**
 * Indeed's "Remote" refinement.
 *
 * `l=Remote` alone is a location *string*, which Indeed interprets loosely and
 * happily pads out with hybrid and "remote-friendly" postings. The `sc`
 * attribute filter is the real switch behind the Remote checkbox in their UI.
 * Both are sent: the attribute filter does the work, and the location string is
 * a sensible fallback if Indeed changes the attribute code again.
 */
export const REMOTE_ATTR_FILTER = '0kf:attr(DSQF7);'

/** Role families to search when the recipe does not name its own. */
export const DEFAULT_ROLE_PHRASES = [
  'software engineer',
  'senior software engineer',
  'lead engineer',
  'software developer',
  'full stack developer',
  'backend engineer',
  'software architect',
  'solution architect',
  'engineering lead',
  'technical lead',
]

/** Results per Indeed page. Their pagination is a multiple of this. */
const PAGE_SIZE = 10

/**
 * How many challenged pages in a row before abandoning the sweep.
 *
 * Once Indeed has decided to challenge us, every further request confirms the
 * suspicion and risks escalating a soft check into an IP-level block. Two
 * strikes is enough to know.
 */
const MAX_CONSECUTIVE_BLOCKS = 2

export type ScrapedCard = {
  title: string
  company: string
  location: string
  url: string
  postedText: string
  salaryText: string
  snippet: string
  /** Indeed's own "Easily apply" badge: the form is hosted by Indeed. */
  easyApply: boolean
}

/* ------------------------------------------------------------ url building */

export type IndeedUrlOptions = {
  /** Role phrases to search for, one search each. */
  phrases?: string[]
  domains?: readonly string[]
  /** How many pages of results per phrase per domain. */
  pages?: number
  /** Only postings from the last N days. */
  maxAgeDays?: number
}

/**
 * Every search URL for one recipe.
 *
 * One URL per phrase per domain per page, rather than one URL cramming every
 * keyword together. Indeed treats a long multi-phrase query as a conjunction
 * and returns almost nothing for it, which is the same failure the Naukri
 * builder ran into: the query looked thorough and matched no jobs at all.
 */
export function buildIndeedUrls(recipe: SearchRecipe, options: IndeedUrlOptions = {}): string[] {
  const phrases = (options.phrases ?? recipe.keywords).map((p) => p.trim()).filter(Boolean)
  const roles = phrases.length > 0 ? phrases : DEFAULT_ROLE_PHRASES
  const domains = options.domains ?? INDEED_DOMAINS
  // Two pages, not three. Every extra URL is another window into Indeed's
  // rate limiter, and page three of a date-sorted search is mostly repeats.
  const pages = Math.max(1, options.pages ?? 2)
  const maxAgeDays = options.maxAgeDays ?? 7

  const urls: string[] = []
  for (const domain of domains) {
    for (const role of roles) {
      for (let page = 0; page < pages; page++) {
        const params = new URLSearchParams({
          q: role,
          l: 'Remote',
          sc: REMOTE_ATTR_FILTER,
          fromage: String(maxAgeDays),
          sort: 'date',
        })
        if (page > 0) params.set('start', String(page * PAGE_SIZE))
        urls.push(`https://${domain}/jobs?${params.toString()}`)
      }
    }
  }
  return urls
}

/** The canonical page for a job key, which is stabler than a card's href. */
export function viewJobUrl(domain: string, jobKey: string): string {
  return `https://${domain}/viewjob?jk=${encodeURIComponent(jobKey)}`
}

/* ---------------------------------------------------------- tab utilities */

async function openWorkerTab(
  url: string,
  options: { visible?: boolean } = {}
): Promise<{ tabId: number; windowId: number }> {
  // Minimized by default so a long run stays out of the way. Chrome throttles
  // timers in hidden windows, though, which can starve a Cloudflare challenge
  // of the very JS it needs to complete -- so the retry path asks for a
  // visible (but unfocused) window instead.
  return openWorkerWindow(url, { minimized: !options.visible })
}

async function waitForLoad(tabId: number, timeoutMs = 30000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab) throw new Error('Discovery tab disappeared')
    if (tab.status === 'complete') {
      await sleep(1200) // client-rendered results land after load completes
      return
    }
    await sleep(400)
  }
  throw new Error('Discovery tab never finished loading')
}

async function runInTab<T>(tabId: number, fn: () => T): Promise<T | null> {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: fn })
  return (result?.result as T | undefined) ?? null
}

/**
 * Scroll like a reader so lazily-rendered cards actually render.
 *
 * Adaptive rather than a fixed count of passes. Indeed renders its whole result
 * set eagerly on most layouts, so four unconditional scrolls with a
 * half-to-one-second pause between them spent five seconds per URL learning
 * nothing -- multiplied by two dozen URLs, that is the several minutes of
 * "opens a window, scrolls, closes it" with no jobs to show for it. Stopping as
 * soon as a pass adds no new cards keeps the slow path for the layouts that
 * genuinely need it and costs one pass on the ones that do not.
 */
async function humanScroll(tabId: number, passes = 4): Promise<void> {
  let lastCount = -1
  for (let i = 0; i < passes; i++) {
    const count = await runInTab(tabId, () => document.querySelectorAll('[data-jk], .job_seen_beacon').length).catch(
      () => null
    )
    // Two passes minimum: the first one is what triggers lazy loading at all,
    // so bailing on the very first unchanged count would under-read a page that
    // does defer its cards.
    if (i > 0 && count !== null && count === lastCount) return
    if (count !== null) lastCount = count

    await chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => window.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' }),
      })
      .catch(() => {})
    await pause({ min: 500, max: 1100 })
  }
}

/* -------------------------------------------------------------- scraping */

/**
 * Read the listing cards on an Indeed search page.
 *
 * Selectors are layered deliberately: Indeed ships several card layouts
 * concurrently and rotates its generated class names, so each field tries a
 * stable `data-testid` first, then an older semantic class, then a structural
 * fallback. A card that matches none of them is skipped rather than stored
 * half-empty.
 */
function scrapeIndeedCards(): ScrapedCard[] {
  const text = (el: Element | null | undefined): string =>
    ((el as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim()

  const pick = (root: Element, selectors: string[]): Element | null => {
    for (const sel of selectors) {
      try {
        const found = root.querySelector(sel)
        if (found) return found
      } catch {
        // Skip selectors this engine cannot parse.
      }
    }
    return null
  }

  const cards = Array.from(
    document.querySelectorAll(
      'div.job_seen_beacon, [data-testid="slider_item"], div.cardOutline, li div.cardOutline'
    )
  )

  const out: ScrapedCard[] = []
  const seen = new Set<string>()

  for (const card of cards) {
    const link = pick(card, ['a[data-jk]', 'h2 a', 'a.jcs-JobTitle', 'a[id^="job_"]']) as HTMLAnchorElement | null
    const title = text(pick(card, ['h2 span[title]', 'h2 a span', '[id^="jobTitle"]', 'h2'])) || text(link)
    if (!title) continue

    // The job key is the only identifier Indeed keeps stable across layouts,
    // and it lets us build a canonical URL rather than trusting a card href
    // that is often a tracking redirect.
    const jobKey =
      link?.getAttribute('data-jk') ??
      card.querySelector('[data-jk]')?.getAttribute('data-jk') ??
      ''

    const url = jobKey ? `${location.origin}/viewjob?jk=${encodeURIComponent(jobKey)}` : (link?.href ?? '')
    if (!url) continue
    if (seen.has(url)) continue
    seen.add(url)

    const cardText = text(card)
    // Verified against live search results: the current card layout carries no
    // Easy Apply badge at all, so this is a best-effort hint only. What settles
    // it is the presence of Indeed's own apply button on the job page, which
    // `hydrateIndeedJobs` checks below.
    const easyApply =
      Boolean(pick(card, ['[data-testid="indeedApply"]', '.ialbl', '.iaLabel', '[class*="indeedApply" i]'])) ||
      /easily apply|apply with indeed/i.test(cardText)

    out.push({
      title,
      company: text(pick(card, ['[data-testid="company-name"]', '.companyName', 'span.companyName'])),
      location: text(pick(card, ['[data-testid="text-location"]', '.companyLocation', '[class*="location" i]'])),
      url,
      // `timing-attribute` is what the live layout uses; the rest are older
      // spellings kept as fallbacks.
      postedText: text(
        pick(card, ['[data-testid="timing-attribute"]', '[data-testid="myJobsStateDate"]', '.date'])
      ),
      // Salary has no test id of its own and lives in the metadata group, which
      // also holds job-type chips. Over-capturing here is harmless: the text is
      // only ever parsed for a number, and a chip without one yields nothing.
      salaryText: text(
        pick(card, [
          '[data-testid="attribute_snippet_testid"]',
          '.salary-snippet-container',
          '.metadataContainer',
          '.jobMetaDataGroup',
        ])
      ),
      snippet: text(pick(card, ['[data-testid="jobsnippet_footer"]', '.job-snippet', 'div.underShelfFooter'])),
      easyApply,
    })
  }
  return out
}

/**
 * Is this search page actually a bot challenge?
 *
 * Indeed answers suspected automation with a Cloudflare interstitial that is a
 * perfectly valid page containing zero job cards. Without this check that is
 * indistinguishable from "no remote jobs today", and the run reports a
 * cheerful nothing for hours.
 */
/**
 * Tell a challenge that is still working itself out from one that has stopped.
 *
 * This distinction is the whole thing. Cloudflare's "Just a moment" page is a
 * *transient* interstitial that clears itself within a few seconds; the first
 * version of this function reported it as a block, and the caller closed the
 * window on the spot -- so a page that was about to load fine was thrown away
 * every time, and the run then hammered the next of forty-eight URLs into an
 * increasingly annoyed rate limiter.
 *
 * 'none' means there are results, or at least no challenge. 'transient' means
 * wait. 'hard' means a person has to intervene and retrying will not help.
 */
export function classifyBlockPage(): 'none' | 'transient' | 'hard' {
  const body = (document.body?.innerText ?? '').slice(0, 2000)

  // A visible, interactive challenge. Not solvable from here, by policy and in
  // practice.
  if (/verify you are human|are you a robot|unusual traffic|access denied/i.test(body)) return 'hard'
  if (document.querySelector('iframe[src*="challenges.cloudflare"], #challenge-stage')) return 'hard'

  // Still settling.
  if (/just a moment|checking your browser|verifying you are/i.test(body)) return 'transient'
  if (document.querySelector('#challenge-form, #challenge-running')) return 'transient'

  // Cards present means we are plainly through.
  if (document.querySelector('div.job_seen_beacon, [data-testid="slider_item"], div.cardOutline')) return 'none'

  // No challenge and no cards: an empty result set, which is a normal outcome.
  return 'none'
}

/**
 * Give a Cloudflare interstitial time to clear before calling it a block.
 *
 * Polls rather than sleeping once, so the common case -- a challenge that
 * passes in three seconds -- costs three seconds rather than the whole timeout.
 */
async function settleChallenge(tabId: number, timeoutMs = 25_000): Promise<'none' | 'hard'> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const verdict = (await runInTab(tabId, classifyBlockPage)) ?? 'transient'
    if (verdict === 'none') return 'none'
    if (verdict === 'hard') return 'hard'
    activity.note('waiting for a browser check to clear')
    await sleep(2000)
  }
  // A challenge that never finishes is, for our purposes, one we cannot pass.
  return 'hard'
}

/* -------------------------------------------------------------- discovery */

export async function fetchIndeed(recipe: SearchRecipe, options: IndeedUrlOptions = {}): Promise<Job[]> {
  const urls = recipe.customUrls.length > 0 ? recipe.customUrls : buildIndeedUrls(recipe, options)
  const jobs: Job[] = []
  let blocked = 0
  let consecutiveBlocks = 0

  const collect = (cards: ScrapedCard[]): void => {
    for (const card of cards) {
      if (jobs.length >= recipe.maxResultsPerRun) break
      const job = makeJob({
        source: 'indeed',
        vendor: 'indeed',
        url: card.url,
        company: card.company,
        title: card.title,
        location: card.location || 'Remote',
        descriptionText: card.snippet,
        postedAt: null, // parsed from the card's relative date by makeJob
        postedText: card.postedText,
        salaryText: card.salaryText,
        recipeId: recipe.id,
      })
      job.easyApply = card.easyApply
      jobs.push(job)
    }
  }

  for (const [index, url] of urls.entries()) {
    if (jobs.length >= recipe.maxResultsPerRun) break

    const host = new URL(url).hostname
    activity.note(`searching ${host} (${index + 1} of ${urls.length})`)

    let retryWindowId: number | null = null
    const { tabId, windowId } = await openWorkerTab(url)
    try {
      await waitForLoad(tabId)

      // Wait the challenge out rather than treating it as a failure. Most
      // clear in a few seconds and the page then loads normally.
      let verdict = await settleChallenge(tabId)

      // A challenge that will not clear in a minimized window is often just
      // starved: Chrome throttles hidden windows hard enough that Cloudflare's
      // own script cannot finish. Give it one honest try in a visible one
      // before concluding we are actually blocked.
      if (verdict === 'hard') {
        log.info(`${host}: retrying the browser check in a visible window`)
        activity.note('retrying the browser check in a visible window')
        await closeWorkerWindow(windowId)
        const retry = await openWorkerTab(url, { visible: true })
        retryWindowId = retry.windowId
        await waitForLoad(retry.tabId)
        verdict = await settleChallenge(retry.tabId, 30_000)
        if (verdict === 'none') {
          await humanScroll(retry.tabId)
          const retried = (await runInTab(retry.tabId, scrapeIndeedCards)) ?? []
          activity.note(`read ${retried.length} listing(s) from ${host}`)
          collect(retried)
          consecutiveBlocks = 0
          continue
        }
      }

      if (verdict === 'hard') {
        blocked++
        consecutiveBlocks++
        log.warn(`${host}: bot check did not clear (${consecutiveBlocks} in a row)`)

        // Stop early. Forty-eight windows into a rate limiter is what turns a
        // soft challenge into a hard IP block, and none of them would have
        // returned anything anyway.
        if (consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
          log.error(`Indeed is challenging every request; abandoning this sweep after ${blocked} attempt(s)`)
          activity.note('Indeed is asking for human verification; pausing this search')
          break
        }

        activity.note(`${host} served a bot check; backing off`)
        await durableSleep(60_000)
        continue
      }
      consecutiveBlocks = 0

      await humanScroll(tabId)
      const cards = (await runInTab(tabId, scrapeIndeedCards)) ?? []
      activity.note(`read ${cards.length} listing(s) from ${host}`)
      log.info(`Indeed: ${cards.length} card(s) from ${host}`)
      collect(cards)
    } catch (e) {
      // Warn, not debug: a failed search page is a whole domain yielding
      // nothing, and a night of these used to read as "no remote jobs today".
      log.warn(`Indeed search failed for ${host}`, { error: (e as Error).message })
    } finally {
      await closeWorkerWindow(windowId)
      if (retryWindowId !== null) {
        await closeWorkerWindow(retryWindowId)
        retryWindowId = null
      }
    }

    // Paced like a person reading results, not a crawler. The old 2.5-6s gap
    // across dozens of windows is itself what provoked the challenge.
    await durableSleep(jitter(6000, 14000))
  }

  if (blocked > 0 && jobs.length === 0) {
    throw new Error(
      `Indeed asked for human verification on all ${blocked} search page(s) and returned no jobs. ` +
        'Open indeed.com in this browser, complete the check once by hand, then start the agent again. ' +
        'If it keeps happening, reduce the number of searches or wait an hour before retrying.'
    )
  }

  return jobs
}

/**
 * Fill in each job's description and real apply destination.
 *
 * Listing cards carry a one-line snippet, and the runner needs two things the
 * card cannot give it: enough description to answer questions with, and where
 * applying actually goes. For an Easy Apply listing that is Indeed's own form;
 * for everything else it is a company ATS, and resolving it here means the
 * apply machine opens the real form directly instead of landing on an advert
 * and giving up.
 */
export async function hydrateIndeedJobs(jobs: Job[], limit = 40): Promise<Job[]> {
  const targets = jobs.slice(0, limit)
  let done = 0

  for (const job of targets) {
    if (!job.url) continue
    activity.note(`reading ${++done} of ${targets.length}: ${job.title}`)

    const { tabId, windowId } = await openWorkerTab(job.url)
    try {
      await waitForLoad(tabId)
      const detail = await runInTab(tabId, () => {
        const text = (el: Element | null): string => ((el as HTMLElement | null)?.innerText ?? '').trim()

        const descSelectors = [
          '#jobDescriptionText',
          '.jobsearch-JobComponent-description',
          '[data-testid="jobDescriptionText"]',
          '.jobDescriptionContent',
        ]
        let description = ''
        for (const sel of descSelectors) {
          const found = text(document.querySelector(sel))
          if (found.length > description.length) description = found
        }
        if (description.length < 200) description = (document.body?.innerText ?? '').slice(0, 20000)

        // The apply control tells us where this really goes. An Indeed-hosted
        // form keeps us on indeed.com; anything else is a company ATS.
        // Verified live: the real control is a <button id="indeedApplyButton">
        // labelled "Apply with Indeed", carrying data-testid
        // "indeedApplyButton-test" -- note the suffix, which an exact-match
        // selector misses. Only a company ATS gives us an href to follow.
        const applyEl = document.querySelector(
          '#indeedApplyButton, [data-testid^="indeedApplyButton"], .jobsearch-IndeedApplyButton, #applyButtonLinkContainer a, a[href*="/applystart"]'
        ) as HTMLAnchorElement | null

        const applyHref = applyEl instanceof HTMLAnchorElement ? applyEl.href : ''
        const pageText = (document.body?.innerText ?? '').slice(0, 4000)
        const easyApply =
          Boolean(
            document.querySelector(
              '#indeedApplyButton, [data-testid^="indeedApplyButton"], .jobsearch-IndeedApplyButton'
            )
          ) || /easily apply|apply with indeed/i.test(pageText)

        return {
          description: description.slice(0, 20000),
          applyHref,
          easyApply,
          company: text(document.querySelector('[data-testid="inlineHeader-companyName"], [data-company-name]')),
          title: text(document.querySelector('[data-testid="jobsearch-JobInfoHeader-title"], h1')),
        }
      })

      if (!detail) continue
      if (detail.description.length > job.descriptionText.length) {
        job.descriptionText = detail.description
        job.descriptionSource = 'hydrated'
      }
      if (!job.company && detail.company) job.company = detail.company
      job.easyApply = detail.easyApply

      // An off-Indeed apply link is the company's real form; prefer it.
      if (detail.applyHref && !/indeed\.com/.test(new URL(detail.applyHref, job.url).hostname)) {
        job.applyUrl = detail.applyHref
      }
    } catch (e) {
      log.debug(`Could not hydrate ${job.url}`, { error: (e as Error).message })
    } finally {
      await closeWorkerWindow(windowId)
    }

    await pause({ min: 1500, max: 3500 })
  }

  return jobs
}
