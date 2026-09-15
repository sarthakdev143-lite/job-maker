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

/**
 * The step paths observed on a real application, in the order they appeared:
 *
 *   /form/resume-selection-module/resume-selection   pick a stored resume
 *   /form/questions-module/questions/1               employer screening questions
 *   /form/resume-module/profile-education            confirm saved education
 *   /form/resume-module/profile-work-experience      confirm saved experience
 *   /form/review-module                              final review, then submit
 *
 * The entry point is /beta/indeedapply/applybyapplyablejobid, which redirects.
 * Steps are skipped when the account already satisfies them, so this is a set
 * of possibilities rather than a fixed sequence.
 */

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

  // Deliberately narrow. A bare /review/ test also matched
  // `/resume-module/profile-review`, an ordinary mid-flow step for checking
  // saved profile details -- and treating that as the final screen is exactly
  // the mistake `canSubmit` exists to prevent. Verified live: the real last
  // step is `/beta/indeedapply/form/review-module`.
  if (/(^|\/)review-module(\/|$)|\/review$|review-application/.test(path)) return 'review'

  if (/question|qualification|screener/.test(path)) return 'questions'
  // Covers both `resume-selection-module/resume-selection` and the
  // `resume-module/profile-*` profile-confirmation steps.
  if (/resume|document|work-experience|education/.test(path)) return 'resume'
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
      const hasIndeedApply = Boolean(
        doc.querySelector('#indeedApplyButton, [data-testid^="indeedApplyButton"], .jobsearch-IndeedApplyButton')
      )
      return {
        isApplicationForm: false,
        confidence: 0.15,
        jobTitle: title,
        company,
        multiStep: true,
        detail: hasIndeedApply
          ? 'indeed job advert with Easy Apply - the form is behind the apply button'
          : 'indeed job advert - applying redirects to the company site',
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

  /**
   * Verified against a live listing: the control is
   * `<button id="indeedApplyButton" data-testid="indeedApplyButton-test">`
   * labelled "Apply with Indeed". The id is the reliable hook -- an exact
   * `[data-testid="indeedApplyButton"]` match misses because of the `-test`
   * suffix, so the prefix form is used instead.
   */
  applyEntrySelectors: [
    '#indeedApplyButton',
    '[data-testid^="indeedApplyButton"]',
    '.jobsearch-IndeedApplyButton',
    'button[id^="indeedApplyButton"]',
    '#applyButtonLinkContainer button',
    '#applyButtonLinkContainer a',
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
    'button[data-testid="continue-button"]',
    'button[data-testid$="-continue-button"]',
    'button[data-testid$="-save-button"]',
    'button[data-testid="ia-continueButton"]',
    'button[type="submit"]',
  ],

  /**
   * Verified live: every profile-confirmation step ships a Skip beside its
   * "Save and continue", named `<page>-skip-button`. It is the only way past a
   * step whose stored profile data Indeed itself rejects.
   */
  skipSelectors: ['button[data-testid$="-skip-button"]'],

  /**
   * Verified live on the review screen: `submit-application-button`, labelled
   * "Submit your application". The earlier guess of `submit-application` missed
   * it by a suffix, and the generic text fallback missed it too because of the
   * possessive -- so submission failed on the one page that mattered.
   */
  submitSelectors: [
    'button[data-testid="submit-application-button"]',
    'button[data-testid^="submit-application"]',
    'button[aria-label*="Submit" i]',
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
