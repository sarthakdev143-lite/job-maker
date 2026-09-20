/**
 * What the page looked like when something went wrong.
 *
 * Until now a failed application recorded a sentence. "no application form
 * found on this page" is true and completely useless: it does not say what was
 * on the page, which controls existed, or which selector was expected and
 * missed. Diagnosing a breakage meant opening the site by hand and guessing at
 * what the agent had seen -- which, on a job that only appears once, is not
 * possible at all.
 *
 * So every failure keeps the outline of the page that produced it. Not the raw
 * HTML: half a megabyte per failure would fill the user's storage in a night,
 * and almost all of it is framework noise. The outline is the part a person
 * would actually read -- the controls, their labels, the headings, the visible
 * text -- at a few kilobytes each.
 *
 * Kept deliberately small and short-lived. This is a debugging aid, not an
 * archive, and it holds page content from sites the user was signed in to.
 */

import { createLogger } from '@/shared/logger'
import { uid } from '@/shared/util'
import type { PageOutline } from '@/form/outline'

const log = createLogger('evidence')

const KEY = 'evidence:failures'

/** Past this, the oldest are dropped. Roughly a night's worth of failures. */
export const MAX_ENTRIES = 25

/** Anything older than this is dropped on the next write. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type Evidence = {
  id: string
  at: number
  jobId: string
  applicationId: string
  /** What the runner was trying to do: 'detect', 'submit', 'verify'. */
  stage: string
  /** The failure as the user would see it. */
  reason: string
  url: string
  title: string
  headings: string[]
  /** The controls that were on screen, already compacted. */
  controls: Array<{ role: string; text: string; selector: string; disabled?: boolean }>
  /** Leading page text, truncated. */
  text: string
}

async function read(): Promise<Evidence[]> {
  try {
    const stored = await chrome.storage.local.get(KEY)
    const value = stored?.[KEY]
    return Array.isArray(value) ? (value as Evidence[]) : []
  } catch {
    return []
  }
}

/**
 * Record what the page looked like at the moment of a failure.
 *
 * Never throws. Evidence is worth having and never worth failing an
 * application over, so every path here swallows its own errors.
 */
export async function recordEvidence(entry: {
  jobId: string
  applicationId: string
  stage: string
  reason: string
  outline: PageOutline | null
}): Promise<void> {
  if (!entry.outline) return

  try {
    const now = Date.now()
    const existing = await read()

    const fresh: Evidence = {
      id: uid(),
      at: now,
      jobId: entry.jobId,
      applicationId: entry.applicationId,
      stage: entry.stage,
      reason: entry.reason.slice(0, 500),
      url: entry.outline.url,
      title: entry.outline.title,
      headings: entry.outline.headings,
      controls: entry.outline.elements.slice(0, 60).map((e) => ({
        role: e.role,
        text: e.text,
        selector: e.selector,
        ...(e.disabled ? { disabled: true } : {}),
      })),
      text: entry.outline.text.slice(0, 2000),
    }

    const kept = [fresh, ...existing.filter((e) => now - e.at < MAX_AGE_MS)].slice(0, MAX_ENTRIES)
    await chrome.storage.local.set({ [KEY]: kept })
    log.debug(`Kept a page snapshot for the ${entry.stage} failure on ${fresh.url}`)
  } catch (e) {
    log.debug(`Could not record evidence: ${(e as Error).message}`)
  }
}

export async function allEvidence(): Promise<Evidence[]> {
  return (await read()).sort((a, b) => b.at - a.at)
}

export async function clearEvidence(): Promise<void> {
  try {
    await chrome.storage.local.remove(KEY)
    log.info('Failure snapshots cleared')
  } catch {
    // Nothing to do; the next write prunes anyway.
  }
}

/**
 * One failure as plain text, ready to paste into a bug report.
 *
 * The point of the whole module: a user who hits a breakage can copy this and
 * it contains everything needed to write the selector that fixes it.
 */
export function formatEvidence(e: Evidence): string {
  const lines = [
    `Stage: ${e.stage}`,
    `Reason: ${e.reason}`,
    `URL: ${e.url}`,
    `Title: ${e.title}`,
    `When: ${new Date(e.at).toISOString()}`,
  ]
  if (e.headings.length > 0) lines.push(`Headings: ${e.headings.join(' | ')}`)
  lines.push('', 'Controls on screen:')
  for (const c of e.controls) {
    lines.push(`  ${c.role}${c.disabled ? ' (disabled)' : ''} "${c.text || '(no label)'}"  ->  ${c.selector}`)
  }
  lines.push('', 'Page text:', e.text)
  return lines.join('\n')
}
