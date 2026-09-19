/**
 * Generic adapter.
 *
 * The fallback for a company that hosts its own form, and the safety net for
 * every other adapter: when a vendor's selectors stop matching, detection falls
 * back to "does this page contain a form that looks like a job application",
 * which is answered by the presence of the fields such forms always have.
 *
 * It deliberately reports lower confidence than a real adapter so the runner's
 * gate is stricter about submitting from here unattended.
 */

import type { SiteAdapter } from '../types'
import {
  COMMON_ERROR_SELECTORS,
  COMMON_SUCCESS_PATTERNS,
  GENERIC_NEXT_TEXT,
  GENERIC_SUBMIT_TEXT,
  textOf,
} from '../types'

const APPLICATION_SIGNALS = [
  /upload (your )?(resume|cv)/i,
  /apply for this (job|position|role)/i,
  /submit (your )?application/i,
  /cover letter/i,
  /work authorization/i,
]

/**
 * Does this page carry a control that moves to another step?
 *
 * `multiStep` used to be hard-coded false here, which quietly made every
 * company-hosted wizard unfinishable: the runner filled the first page, never
 * advanced, and went looking for a submit button that lives three pages later.
 * A "Continue" button is the signal, and it is the same one a person uses.
 */
function hasNextControl(doc: Document): boolean {
  const controls = Array.from(
    doc.querySelectorAll<HTMLElement>('button, a[role="button"], div[role="button"], input[type="button"]')
  )
  return controls.some((el) => {
    const label = (textOf(el) || el.getAttribute('aria-label') || (el as HTMLInputElement).value || '').trim()
    return GENERIC_NEXT_TEXT.test(label)
  })
}

export const genericAdapter: SiteAdapter = {
  id: 'generic',
  label: 'Generic form',

  matches(): boolean {
    return true // last in the registry, so this only runs when nothing else matched
  },

  detect(doc: Document) {
    const forms = Array.from(doc.querySelectorAll('form'))
    const text = (doc.body?.innerText ?? '').slice(0, 8000)
    const signalHits = APPLICATION_SIGNALS.filter((re) => re.test(text)).length

    const hasEmail = Boolean(doc.querySelector('input[type="email"], input[name*="email" i]'))
    const hasFile = Boolean(doc.querySelector('input[type="file"]'))
    const hasName = Boolean(doc.querySelector('input[name*="name" i], input[id*="name" i]'))

    const score =
      (hasEmail ? 0.3 : 0) + (hasFile ? 0.25 : 0) + (hasName ? 0.2 : 0) + Math.min(signalHits * 0.12, 0.36)

    return {
      isApplicationForm: forms.length > 0 && score >= 0.5,
      confidence: Math.min(score, 0.75), // never as confident as a real adapter
      jobTitle: textOf(doc.querySelector('h1')) || doc.title,
      company: hostCompany(),
      multiStep: hasNextControl(doc),
      detail: `${forms.length} form(s), ${signalHits} application signal(s)`,
    }
  },

  applyEntrySelectors: ['a[href*="apply" i]', 'button[class*="apply" i]'],

  submitSelectors: ['button[type="submit"]', 'input[type="submit"]'],

  successPatterns: COMMON_SUCCESS_PATTERNS,

  errorSelectors: COMMON_ERROR_SELECTORS,
}

function hostCompany(): string {
  try {
    return location.hostname.replace(/^(www|jobs|careers|apply)\./, '').split('.')[0] ?? ''
  } catch {
    return ''
  }
}

/** Find a submit-shaped button by its text when no selector matched. */
export function findSubmitByText(doc: Document): HTMLElement | null {
  const candidates = Array.from(
    doc.querySelectorAll<HTMLElement>('button, input[type="submit"], a[role="button"], div[role="button"]')
  )
  for (const el of candidates) {
    const label = (
      el instanceof HTMLInputElement ? el.value : (el.innerText ?? el.getAttribute('aria-label') ?? '')
    ).trim()
    if (GENERIC_SUBMIT_TEXT.test(label)) return el
  }
  return null
}
