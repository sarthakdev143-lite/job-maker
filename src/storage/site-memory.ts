/**
 * What the agent has learned about a particular site.
 *
 * The answer bank made answering cheap over time: a question answered once is
 * never sent to the model again. Nothing did the same for *navigation*. Every
 * time the adapter's selectors missed and the model found the apply button, the
 * discovery was used once and thrown away -- so the same site cost the same
 * model call on the next job, and the one after that, for ever.
 *
 * This is the navigation equivalent. A selector the model found and that then
 * actually worked is written here against the host, tried first on the next
 * visit, and retired when it stops working. That last part matters as much as
 * the first: a remembered selector that has gone stale is worse than none,
 * because it fails silently and looks like the site is broken.
 */

import { createLogger } from '@/shared/logger'

const log = createLogger('site-memory')

const KEY = 'site:memory'

/** Past this many consecutive misses the selector is assumed retired. */
export const MAX_CONSECUTIVE_MISSES = 3

export type LearnedSelector = {
  selector: string
  /** The words that were on the control, for the log and for debugging. */
  text: string
  /** How many times it has been used successfully. */
  hits: number
  /** Consecutive failures since the last hit. Reset to 0 on every hit. */
  misses: number
  learnedAt: number
  lastUsedAt: number
}

export type SiteMemory = {
  /** The control that starts an application on this host. */
  applyEntry?: LearnedSelector
}

type Store = Record<string, SiteMemory>

export function hostKey(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

async function read(): Promise<Store> {
  try {
    const stored = await chrome.storage.local.get(KEY)
    const value = stored?.[KEY]
    return value && typeof value === 'object' ? (value as Store) : {}
  } catch (e) {
    log.debug(`Could not read site memory: ${(e as Error).message}`)
    return {}
  }
}

async function write(store: Store): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEY]: store })
  } catch (e) {
    // Losing what was learned costs a model call, never an application.
    log.debug(`Could not persist site memory: ${(e as Error).message}`)
  }
}

/** Everything known about one host. */
export async function forHost(url: string): Promise<SiteMemory> {
  const host = hostKey(url)
  if (!host) return {}
  return (await read())[host] ?? {}
}

/**
 * The remembered apply control for this host, if it is still trusted.
 *
 * Returns nothing once a selector has missed too many times in a row. The
 * alternative -- keeping it and letting it fail -- turns one bad memory into a
 * permanent outage on that site, which is exactly the failure mode hardcoded
 * selectors already have.
 */
export async function rememberedApplyEntry(url: string): Promise<string> {
  const memory = await forHost(url)
  const entry = memory.applyEntry
  if (!entry) return ''
  if (entry.misses >= MAX_CONSECUTIVE_MISSES) return ''
  return entry.selector
}

/** Record a selector that the model found and that then actually worked. */
export async function learnApplyEntry(url: string, selector: string, text: string): Promise<void> {
  const host = hostKey(url)
  if (!host || !selector) return

  const store = await read()
  const existing = store[host]?.applyEntry
  const now = Date.now()

  store[host] = {
    ...store[host],
    applyEntry:
      existing && existing.selector === selector
        ? { ...existing, hits: existing.hits + 1, misses: 0, lastUsedAt: now, text }
        : { selector, text, hits: 1, misses: 0, learnedAt: now, lastUsedAt: now },
  }

  await write(store)
  log.info(`Learned the apply control on ${host}: ${selector} ("${text}")`)
}

/** Record that a remembered selector did not work this time. */
export async function missApplyEntry(url: string): Promise<void> {
  const host = hostKey(url)
  if (!host) return

  const store = await read()
  const existing = store[host]?.applyEntry
  if (!existing) return

  const misses = existing.misses + 1
  store[host] = { ...store[host], applyEntry: { ...existing, misses } }
  await write(store)

  if (misses >= MAX_CONSECUTIVE_MISSES) {
    log.warn(`Forgetting the apply control on ${host}: ${existing.selector} missed ${misses} times running`)
  }
}

/** Everything learned, for the options page and for export. */
export async function allSiteMemory(): Promise<Array<{ host: string } & SiteMemory>> {
  const store = await read()
  return Object.entries(store)
    .map(([host, memory]) => ({ host, ...memory }))
    .sort((a, b) => (b.applyEntry?.lastUsedAt ?? 0) - (a.applyEntry?.lastUsedAt ?? 0))
}

export async function clearSiteMemory(): Promise<void> {
  await write({})
  log.info('Site memory cleared')
}
