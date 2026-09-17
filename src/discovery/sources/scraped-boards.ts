/**
 * Naukri discovery, by driving a tab.
 *
 * Naukri publishes no usable public JSON board, so this opens a search URL in a
 * background tab, scrolls it the way a person would, and reads the listing
 * cards. Indeed used to share this file; it is the primary source now and has
 * its own module, `./indeed`, with remote filtering and Easy Apply detection.
 *
 * The scrape functions below are injected with chrome.scripting.executeScript,
 * which serialises them to source text -- so they must be entirely
 * self-contained. No imports, no closure variables, no shared helpers. That
 * duplication is deliberate and load-bearing; factoring it out breaks injection
 * at runtime with an unhelpful error.
 */

import { createLogger } from '@/shared/logger'
import { pause, sleep } from '@/shared/util'
import { closeWorkerWindow, openWorkerWindow } from '@/shared/windows'
import { activity } from '@/shared/activity'
import type { Job, SearchRecipe } from '@/storage/schemas'
import { makeJob } from './ats-apis'

const log = createLogger('discovery:scrape')

export type ScrapedCard = {
  title: string
  company: string
  location: string
  url: string
  postedText: string
  salaryText: string
  snippet: string
}

/* --------------------------------------------------------- tab utilities */

async function openWorkerTab(url: string): Promise<{ tabId: number; windowId: number }> {
  return openWorkerWindow(url, { minimized: true })
}

async function waitForLoad(tabId: number, timeoutMs = 30000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab) throw new Error('Discovery tab disappeared')
    activity.note(`loading the search page (${Math.round((Date.now() - start) / 1000)}s)`)
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

async function closeWindow(windowId: number): Promise<void> {
  await closeWorkerWindow(windowId)
}

/** Scroll like a reader so lazily-rendered cards actually render. */
async function humanScroll(tabId: number, passes = 4): Promise<void> {
  for (let i = 0; i < passes; i++) {
    activity.note(`scrolling the results (${i + 1} of ${passes})`)
    await chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => window.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' }),
      })
      .catch(() => {})
    await pause({ min: 700, max: 1600 })
  }
}

/* ---------------------------------------------------------------- naukri */

function scrapeNaukriCards(): ScrapedCard[] {
  const text = (el: Element | null | undefined): string =>
    ((el as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim()

  const cards = Array.from(document.querySelectorAll('div.srp-jobtuple-wrapper, article.jobTuple, div.cust-job-tuple'))
  const out: ScrapedCard[] = []

  for (const card of cards) {
    const link = card.querySelector('a.title, a.jobTitle') as HTMLAnchorElement | null
    const title = text(link)
    if (!title) continue
    out.push({
      title,
      company: text(card.querySelector('a.comp-name, a.subTitle, span.comp-name')),
      location: text(card.querySelector('span.locWdth, li.location, span.loc-wrap')),
      url: link?.href ?? '',
      postedText: text(card.querySelector('span.job-post-day, span.fleft.postedDate')),
      salaryText: text(card.querySelector('span.sal-wrap, li.salary')),
      snippet: text(card.querySelector('span.job-desc, ul.tags-gt')),
    })
  }
  return out
}

export async function fetchNaukri(recipe: SearchRecipe): Promise<Job[]> {
  const urls = recipe.customUrls.length > 0 ? recipe.customUrls : buildNaukriUrls(recipe)
  const jobs: Job[] = []

  for (const url of urls) {
    activity.note(`opening ${url.replace('https://www.', '')}`)
    const { tabId, windowId } = await openWorkerTab(url)
    try {
      await waitForLoad(tabId)
      await humanScroll(tabId, 5)
      const cards = (await runInTab(tabId, scrapeNaukriCards)) ?? []
      activity.note(`read ${cards.length} listing(s) from Naukri`)
      log.info(`Naukri: ${cards.length} card(s) from ${url}`)
      for (const card of cards.slice(0, recipe.maxResultsPerRun)) {
        if (!card.url) continue
        jobs.push(
          makeJob({
            source: 'naukri',
            vendor: 'naukri',
            url: card.url,
            company: card.company,
            title: card.title,
            location: card.location,
            descriptionText: card.snippet,
            postedAt: null,
            postedText: card.postedText,
            salaryText: card.salaryText,
            recipeId: recipe.id,
          })
        )
      }
    } finally {
      await closeWindow(windowId)
    }
    await pause({ min: 4000, max: 9000 })
  }
  return jobs
}

/**
 * One URL per role phrase, not one URL containing every phrase.
 *
 * Naukri search paths are slugs, so joining eight keywords produced
 * "principal-software-architect-distributed-systems-solution-architect-..."
 * -- a single query matching almost nothing. Each phrase now gets its own
 * search, which is what a person would actually type.
 */
export function buildNaukriUrls(recipe: SearchRecipe): string[] {
  const slug = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60)
      .replace(/-+$/, '')

  const phrases = recipe.keywords.map(slug).filter(Boolean).slice(0, 3)
  if (phrases.length === 0) phrases.push('software-engineer')

  const location = slug(recipe.location)
  return phrases.map((phrase) =>
    location
      ? `https://www.naukri.com/${phrase}-jobs-in-${location}`
      : `https://www.naukri.com/${phrase}-jobs`
  )
}

/* ------------------------------------------------------- description fill */

/**
 * Listing cards carry a snippet, not a description, and the scorer needs the
 * real text. This opens each job page once and reads the body -- the slowest
 * part of discovery, so it is capped and paced.
 */
export async function hydrateDescriptions(jobs: Job[], limit = 12): Promise<Job[]> {
  const targets = jobs.filter((j) => j.descriptionText.length < 400).slice(0, limit)
  let done = 0
  for (const job of targets) {
    if (!job.url) continue
    activity.note(`reading full description ${++done} of ${targets.length}: ${job.title}`)
    const { tabId, windowId } = await openWorkerTab(job.url)
    try {
      await waitForLoad(tabId)
      const body = await runInTab(tabId, () => {
        const selectors = [
          '#jobDescriptionText',
          '.jobDescriptionContent',
          '[class*="job-desc"]',
          '[class*="JobDescription"]',
          'section[data-testid="job-description"]',
          'main',
        ]
        for (const sel of selectors) {
          const el = document.querySelector(sel) as HTMLElement | null
          const text = (el?.innerText ?? '').trim()
          if (text.length > 400) return text.slice(0, 20000)
        }
        return (document.body?.innerText ?? '').slice(0, 20000)
      })
      if (body && body.length > job.descriptionText.length) {
        job.descriptionText = body
        job.descriptionSource = 'hydrated'
      }
    } catch (e) {
      log.debug(`Could not hydrate ${job.url}`, { error: (e as Error).message })
    } finally {
      await closeWindow(windowId)
    }
    await pause({ min: 2500, max: 6000 })
  }
  return jobs
}
