/**
 * Site adapter contract.
 *
 * An adapter encodes what we know about one ATS: how to recognise its
 * application form, which of its fields map to canonical profile keys, how to
 * move to the next step, how to submit, and how to tell that a submission
 * actually landed.
 *
 * Adapters are advisory, never load-bearing. If `canonicalKey` returns nothing
 * the generic label matcher still runs; if `submitSelectors` all miss, the
 * runner falls back to finding a submit-shaped button by its text. A stale
 * adapter degrades the run, it does not break it.
 */

import type { CanonicalKey } from '@/form/canonical'
import type { FieldDescriptor } from '@/storage/schemas'

export type DetectResult = {
  isApplicationForm: boolean
  /** 0-1. Below 0.4 the runner treats the page as "not an application yet". */
  confidence: number
  jobTitle: string
  company: string
  multiStep: boolean
  detail: string
  /**
   * Pressing the entry button submits the application outright, with no form.
   *
   * Naukri's own "Apply" posts the profile already on file and is finished --
   * but the same page can instead carry "Apply on company site", which merely
   * redirects to a real ATS. Only the live page can tell those apart, so this
   * is decided per page by `detect` rather than declared once per adapter.
   *
   * Two things depend on it. The autonomy gate normally runs after filling, on
   * the theory that opening a form commits nothing; where the click is the
   * application, dry run would quietly send real ones, so the gate is consulted
   * BEFORE the click. And "no form appeared" stops meaning the adapter misfired
   * and starts meaning the application is already in.
   */
  entrySubmitsImmediately?: boolean
}

export interface SiteAdapter {
  readonly id: string
  readonly label: string
  /** Host/path test. Cheap, called on every page. */
  matches(url: string): boolean
  detect(doc: Document, url: string): DetectResult
  /** Vendor-specific mapping, consulted before the generic label matcher. */
  canonicalKey?(field: FieldDescriptor, doc?: Document): CanonicalKey | null
  /** Buttons that submit the whole application, most specific first. */
  submitSelectors: string[]
  /**
   * Veto on clicking submit at all, for wizards that reuse one control.
   *
   * Indeed's Easy Apply flow drives every step with the same button, relabelled
   * -- so "the submit button is present" is true on the contact-details page as
   * much as on the final review, and a selector list cannot tell them apart.
   * When this returns false the runner treats the page as having no submit
   * control rather than clicking whatever matched.
   *
   * Optional: an adapter that omits it can always submit, which is the right
   * default for the single-page forms most ATSes use.
   */
  canSubmit?(doc: Document, url: string): boolean
  /** Buttons that advance a multi-step form without submitting. */
  nextStepSelectors?: string[]
  /**
   * Controls that step past a page the normal button refuses to leave.
   *
   * Indeed re-validates the user's saved Indeed profile partway through every
   * Easy Apply -- "Review education", "Review work experience" -- and if any
   * stored item is missing a field it requires, "Save and continue" silently
   * does nothing. Verified live: a profile with two incomplete education
   * entries wedges every application at 63% for ever. Each of those pages ships
   * a "Skip" button beside it, and taking it is the difference between an
   * overnight run that submits and one that parks every job.
   *
   * Only used after a normal advance has been tried and left the page unchanged.
   */
  skipSelectors?: string[]
  /** Elements whose presence proves the submission landed. */
  successSelectors?: string[]
  /** Page text that proves the submission landed. */
  successPatterns: RegExp[]
  /** Text that means the form rejected us (validation errors). */
  errorSelectors?: string[]
  /**
   * A link or button that opens the real application form from a job page
   * ("Apply for this job"). The runner clicks this before harvesting.
   */
  applyEntrySelectors?: string[]
}

/** Shared success phrasing. Every ATS says one of these on the thank-you page. */
export const COMMON_SUCCESS_PATTERNS: RegExp[] = [
  /thank you for (applying|your (interest|application))/i,
  /your application (has been|was) (submitted|received|sent)/i,
  /application (submitted|received|complete)/i,
  /we(?:'| ha)ve received your application/i,
  /successfully (submitted|applied)/i,
]

export const COMMON_ERROR_SELECTORS = [
  '[role="alert"]',
  '.error',
  '[class*="error-message"]',
  '[aria-invalid="true"]',
  '[class*="field_with_errors"]',
]

/** Buttons that look like a submit control when no adapter selector matches. */
/**
 * Indeed's final button reads "Submit your application", which an exact
 * `^submit( application)?$` match missed entirely -- so the fallback found no
 * submit control on the one page where it mattered. The possessive is now
 * optional rather than fatal.
 */
export const GENERIC_SUBMIT_TEXT =
  /^(submit( (your|this) )?( application)?|submit application|send( my)? application|apply( now)?|finish|complete application)$/i

export const GENERIC_NEXT_TEXT = /^(next|continue|save and continue|next step|proceed)$/i

export function textOf(el: Element | null): string {
  return ((el as HTMLElement | null)?.innerText ?? '').trim()
}

export function firstMatch(doc: Document, selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    try {
      const el = doc.querySelector<HTMLElement>(sel)
      if (el) return el
    } catch {
      // Skip selectors this engine cannot parse.
    }
  }
  return null
}
