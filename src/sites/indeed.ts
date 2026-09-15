/**
 * Indeed, as an apply surface.
 *
 * Indeed is now the agent's primary source, so it needs a real adapter rather
 * than the discovery-only stub it used to have. Two facts shape everything
 * here.
 *
 * The first is that there are two completely different pages under one domain.
 * A `/viewjob` page is an advert: it has a headline, a description, and an
 * apply button, and no form at all. The actual form lives on
 * `smartapply.indeed.com`, reached by pressing that button. Treating the advert
 * as a form is how the old stub ended up harvesting zero fields and then
 * "submitting" nothing.
 *
 * The second is that Easy Apply is a wizard driven by a single button that
 * changes its label. `ia-continueButton` advances the contact step, the resume
 * step, the screening questions and the final review -- and on that last screen
 * the same control sends the application. No selector can distinguish "continue"
 * from "submit", because in the DOM they are the same element. So submission is
 * gated on the step the URL says we are on, via `canSubmit`, and everything
 * else is treated as a next-step control.
 */

import type { SiteAdapter } from './types'
import { COMMON_ERROR_SELECTORS, COMMON_SUCCESS_PATTERNS, textOf } from './types'
import type { CanonicalKey } from '@/form/canonical'
import type { FieldDescriptor } from '@/storage/schemas'

/**
 * The steps of the Easy Apply wizard, as they appear in the URL path.
 *
 * Indeed adds and reorders these freely -- a posting with screening questions
 * has steps a simple one does not -- so this is a classifier, not a sequence.
 * Anything unrecognised is treated as a middle step, which is the safe default:
 * the runner fills it and presses continue rather than trying to submit.
 */
export type ApplyStep = 'contact' | 'resume' | 'questions' | 'review' | 'submitted' | 'other'

export function classifyApplyStep(url: string): ApplyStep {
  let path: string
  try {
    path = new URL(url, 'https://smartapply.indeed.com').pathname.toLowerCase()
  } catch {
    path = url.toLowerCase()
  }

  // Checked before the rest: the post-apply screen is a confirmation, and
  // mistaking it for another step would have the runner press on past it.
  if (/post-apply|application-submitted|\/confirmation/.test(path)) return 'submitted'
  if (/review/.test(path)) return 'review'
  if (/question|qualification|screener/.test(path)) return 'questions'
  if (/resume|document/.test(path)) return 'resume'
  if (/contact-info|contact|profile|name/.test(path)) return 'contact'
  return 'other'
}

/** Is this page Indeed's own application form rather than a job advert? */
export function isSmartApply(url: string): boolean {
  try {
    const u = new URL(url, 'https://www.indeed.com')
    return /smartapply\.indeed\.com$/.test(u.hostname) || /\/(applystart|viewjob\/apply)\b/.test(u.pathname)
  } catch {
    return /smartapply\.indeed\.com/.test(url)
  }
}

export const indeedAdapter: SiteAdapter = {
  id: 'indeed',
  label: 'Indeed',

  matches(url: string): boolean {
    try {
      const host = new URL(url, 'https://www.indeed.com').hostname
      return /(^|\.)indeed\.com$/.test(host)
    } catch {
      return false
    }
  },

  detect(doc: Document, url: string) {
    const step = classifyApplyStep(url)
    const onForm = isSmartApply(url)

    const title =
      textOf(doc.querySelector('[data-testid="jobsearch-JobInfoHeader-title"], h1')) ||
      textOf(doc.querySelector('.jobsearch-JobInfoHeader-title')) ||
      doc.title
    const company = textOf(
      doc.querySelector('[data-testid="inlineHeader-companyName"], [data-company-name], [data-testid="company-name"]')
    )

    // A fillable step has real inputs. The review screen deliberately has few
    // or none, and must still count as part of the application.
    const inputs = doc.querySelectorAll(
      'input:not([type="hidden"]):not([type="search"]), textarea, select, [role="radiogroup"]'
    )

    if (!onForm) {
      return {
        isApplicationForm: false,
        confidence: 0.15,
        jobTitle: title,
        company,
        multiStep: true,
        detail: 'indeed job advert - the form is behind the apply button',
      }
    }

    return {
      isApplicationForm: step === 'review' || inputs.length > 0,
      confidence: step === 'submitted' ? 0.2 : 0.85,
      jobTitle: title,
      company,
      multiStep: true,
      detail: `indeed easy apply (${step} step)`,
    }
  },

  /**
   * Indeed names its fields predictably, which is worth exploiting: resolving a
   * field from its id costs nothing, while falling through to the model costs a
   * round-trip that, at this volume, is the difference between sixty
   * applications a night and a hundred and fifty.
   */
  canonicalKey(field: FieldDescriptor): CanonicalKey | null {
    const handle = `${field.id} ${field.name} ${field.label}`.toLowerCase()

    if (/first.?name|given.?name/.test(handle)) return 'firstName'
    if (/last.?name|family.?name|surname/.test(handle)) return 'lastName'
    if (/full.?name/.test(handle)) return 'fullName'
    if (/e-?mail/.test(handle)) return 'email'
    if (/phone|mobile|contact.?number/.test(handle)) return 'phone'
    if (/resume|cv\b/.test(handle)) return 'resume'
    if (/cover.?letter/.test(handle)) return 'coverLetter'
    if (/city|town/.test(handle)) return 'city'
    if (/state|province|region/.test(handle)) return 'state'
    if (/country/.test(handle)) return 'country'
    if (/postal|zip|pin.?code/.test(handle)) return 'postalCode'
    if (/linked-?in/.test(handle)) return 'linkedin'
    if (/github/.test(handle)) return 'github'
    if (/portfolio|website|personal.?site/.test(handle)) return 'portfolio'
    return null
  },

  applyEntrySelectors: [
    '#indeedApplyButton',
    '[data-testid="indeedApplyButton"]',
    '.jobsearch-IndeedApplyButton',
    '#applyButtonLinkContainer button',
    '#applyButtonLinkContainer a',
    'button[id^="indeedApplyButton"]',
    'a[href*="/applystart"]',
    'button[aria-label*="Apply now" i]',
  ],

  /**
   * Everything that moves the wizard on.
   *
   * `ia-continueButton` is the workhorse and appears on every step. It is safe
   * to list here precisely because submission is gated separately by
   * `canSubmit` -- pressing continue on the review screen is what submits, and
   * the runner only reaches that point deliberately.
   */
  nextStepSelectors: [
    'button[data-testid="ia-continueButton"]',
    'button[data-testid="continue-button"]',
    '.ia-continueButton',
    'button[type="submit"]',
  ],

  submitSelectors: [
    'button[data-testid="ia-continueButton"]',
    'button[aria-label*="Submit" i]',
    'button[data-testid="submit-application"]',
    'button[type="submit"]',
  ],

  /**
   * Submit only from the review screen.
   *
   * Without this the runner would press the shared continue button on the
   * contact-details page, see no confirmation, and park a half-finished
   * application as "submitted but not confirmed" -- having in fact sent
   * nothing, while consuming a slot in the daily count.
   */
  canSubmit(doc: Document, url: string): boolean {
    if (classifyApplyStep(url) === 'review') return true
    // Indeed sometimes renders the review inline on the last question step, so
    // an explicit submit label is accepted wherever it genuinely appears.
    const buttons = Array.from(doc.querySelectorAll<HTMLElement>('button, [role="button"]'))
    return buttons.some((el) => /submit (your )?application|submit$/i.test((el.innerText ?? '').trim()))
  },

  successSelectors: [
    '[data-testid="post-apply-banner"]',
    '[data-testid="application-submitted"]',
    '.ia-PostApply-Confirmation',
  ],

  successPatterns: [
    ...COMMON_SUCCESS_PATTERNS,
    /your application has been submitted/i,
    /application submitted/i,
    /you(?:'| ha)ve applied to/i,
    /applied on indeed/i,
  ],

  errorSelectors: [...COMMON_ERROR_SELECTORS, '[data-testid*="error" i]', '.css-error', '[id$="-error"]'],
}
