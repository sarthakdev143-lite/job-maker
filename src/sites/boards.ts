/**
 * Naukri.
 *
 * Naukri is not an ATS and its job pages are not forms, which is why treating
 * them like one produced nothing. There are three distinct outcomes behind the
 * button, and this adapter's whole job is telling them apart:
 *
 * 1. **Internal one-click apply.** `#apply-button` posts the Naukri profile
 *    already on file and the application is finished -- no form, no second
 *    confirmation. The previous adapter classified this page as "not an
 *    application form", so the runner clicked Apply (genuinely submitting) and
 *    then recorded the job as skipped: the application went out and the user
 *    never saw it.
 *
 * 2. **Chatbot screening.** Some postings answer that click by opening a drawer
 *    asking questions one at a time. That drawer IS fillable, and it is a
 *    wizard: one question, one send, repeat.
 *
 * 3. **External redirect.** `#company-site-button` ("Apply on company site")
 *    only forwards to a real ATS, where another adapter takes over. It must
 *    never be mistaken for a one-click apply.
 *
 * All of it needs a signed-in session; signed out, the button is a login prompt
 * wearing an Apply label.
 *
 * Selector caveat: the ids used here are Naukri's long-lived ones
 * (`#apply-button`, `#company-site-button`, `#login_Layer`), but the hashed
 * class names rotate with their builds, so each is paired with an
 * attribute-contains fallback. None of it was verified against a live page in
 * the session that wrote it.
 */

import type { SiteAdapter } from './types'
import { COMMON_ERROR_SELECTORS, COMMON_SUCCESS_PATTERNS, textOf } from './types'
import type { CanonicalKey } from '@/form/canonical'
import type { FieldDescriptor } from '@/storage/schemas'

/** The drawer that asks screening questions, when a posting has any. */
const CHATBOT_SELECTORS = [
  '.chatbot_DrawerContentWrapper',
  '[class*="chatbot_Drawer"]',
  '[class*="chatbot"]',
]

/** Naukri's own apply control -- not the one that leaves for another site. */
const INTERNAL_APPLY_SELECTORS = ['#apply-button', 'button#apply-button', '.apply-button']

/** "Apply on company site": a redirect to a real ATS, not an application. */
const EXTERNAL_APPLY_SELECTORS = ['#company-site-button', '[id*="company-site"]']

const SIGNED_OUT_SELECTORS = ['#login_Layer', '[class*="login-layer"]', 'a[href*="/nlogin/login"]']

/** Naukri marks a job it has already had from you; re-applying is not possible. */
const ALREADY_APPLIED_PATTERNS = [/\bapplied\b/i, /you have already applied/i, /application sent/i]

function has(doc: Document, selectors: string[]): boolean {
  return selectors.some((sel) => {
    try {
      return Boolean(doc.querySelector(sel))
    } catch {
      return false
    }
  })
}

/**
 * Has this job already been applied to?
 *
 * Read from the apply control rather than the page body: "Applied" appears in
 * the recommendations rail on almost every Naukri page, and matching the whole
 * document would mark every job as already done.
 */
function alreadyApplied(doc: Document): boolean {
  for (const sel of INTERNAL_APPLY_SELECTORS) {
    try {
      const label = textOf(doc.querySelector(sel))
      if (label && ALREADY_APPLIED_PATTERNS.some((re) => re.test(label))) return true
    } catch {
      // A selector this engine cannot parse tells us nothing either way.
    }
  }
  try {
    const status = textOf(doc.querySelector('[class*="applied-status"], [class*="already-applied"]'))
    if (status && ALREADY_APPLIED_PATTERNS.some((re) => re.test(status))) return true
  } catch {
    // As above.
  }
  return false
}

export const naukriAdapter: SiteAdapter = {
  id: 'naukri',
  label: 'Naukri',

  matches(url: string): boolean {
    try {
      return /(^|\.)naukri\.com$/.test(new URL(url, 'https://www.naukri.com').hostname)
    } catch {
      return false
    }
  },

  detect(doc: Document, _url: string) {
    const title =
      textOf(doc.querySelector('.styles_jd-header-title__rZwM1, [class*="jd-header-title"], h1')) ||
      doc.title
    const company = textOf(
      doc.querySelector('.styles_jd-header-comp-name__MvqAI, [class*="jd-header-comp-name"]')
    )
    const base = { jobTitle: title, company }

    if (has(doc, SIGNED_OUT_SELECTORS)) {
      return {
        ...base,
        isApplicationForm: false,
        confidence: 0,
        multiStep: false,
        detail: 'not signed in to Naukri - applying needs a logged-in session',
      }
    }

    if (alreadyApplied(doc)) {
      return {
        ...base,
        isApplicationForm: false,
        confidence: 0,
        multiStep: false,
        detail: 'already applied to this job on Naukri',
      }
    }

    // Checked first: once the drawer is open, the questions in it are the
    // application, and it is the only genuinely fillable surface Naukri has.
    if (has(doc, CHATBOT_SELECTORS)) {
      const fields = doc.querySelectorAll(
        'input:not([type="hidden"]):not([type="search"]), textarea, select'
      )
      return {
        ...base,
        isApplicationForm: true,
        confidence: 0.8,
        // One question per send, so the runner drives it as a wizard.
        multiStep: true,
        detail: `naukri chatbot screening (${fields.length} field(s) on this question)`,
      }
    }

    if (has(doc, INTERNAL_APPLY_SELECTORS)) {
      // Not a form, and never will be: pressing this sends the application. The
      // runner reads entrySubmitsImmediately, consults the autonomy gate BEFORE
      // clicking, and verifies afterwards rather than skipping.
      return {
        ...base,
        isApplicationForm: false,
        confidence: 0.7,
        multiStep: false,
        entrySubmitsImmediately: true,
        detail: 'naukri one-click apply - the button submits the profile on file',
      }
    }

    if (has(doc, EXTERNAL_APPLY_SELECTORS)) {
      return {
        ...base,
        isApplicationForm: false,
        confidence: 0.3,
        multiStep: false,
        detail: 'naukri advert that redirects to the company site',
      }
    }

    return {
      ...base,
      isApplicationForm: false,
      confidence: 0.1,
      multiStep: false,
      detail: 'naukri job advert with no apply control',
    }
  },

  /**
   * Map the questions the chatbot actually asks.
   *
   * It phrases them conversationally rather than as form labels, so the generic
   * matcher -- which expects "Expected CTC" -- misses "What is your expected
   * CTC?". These are the recurring ones on Indian job boards, where CTC and
   * notice period are asked on nearly every application.
   */
  canonicalKey(field: FieldDescriptor): CanonicalKey | null {
    const label = `${field.label ?? ''} ${field.placeholder ?? ''}`.toLowerCase()
    if (!label.trim()) return null

    if (/\bexpected\b.*\b(ctc|salary|compensation|package)\b/.test(label)) return 'expectedSalary'
    if (/\b(current|present)\b.*\b(ctc|salary|compensation|package)\b/.test(label)) {
      return 'currentSalary'
    }
    if (/\bnotice period\b|\bhow soon can you (join|start)\b|\bjoining time\b/.test(label)) {
      return 'noticePeriod'
    }
    if (/\b(total|overall)\b.*\bexperience\b|\byears of experience\b/.test(label)) {
      return 'yearsExperience'
    }
    if (/\b(current|present)\b.*\b(company|employer|organisation|organization)\b/.test(label)) {
      return 'currentCompany'
    }
    if (/\b(current|present)\b.*\b(designation|title|role)\b/.test(label)) return 'currentTitle'
    if (/\b(current|present|preferred)\b.*\b(location|city)\b/.test(label)) return 'city'
    if (/\b(willing|open) to relocate\b|\brelocation\b/.test(label)) return 'willingToRelocate'
    return null
  },

  applyEntrySelectors: [...INTERNAL_APPLY_SELECTORS, 'button[id*="apply" i]'],

  /**
   * In the drawer, advancing and submitting are the same control -- whether a
   * send is the last one depends on whether another question follows, which
   * only the page knows.
   */
  nextStepSelectors: [
    '.sendMsg',
    '[class*="sendMsg"]',
    '.chatbot_Chat_Send',
    '[class*="chatbot"] button[type="submit"]',
    'button[class*="send" i]',
  ],

  submitSelectors: [
    '.sendMsg',
    '[class*="sendMsg"]',
    '.chatbot_Chat_Send',
    'button[class*="send" i]',
  ],

  successSelectors: ['[class*="apply-status-success"]', '[class*="applied-status"]'],

  successPatterns: [
    ...COMMON_SUCCESS_PATTERNS,
    /you have (successfully )?applied/i,
    /applied to this job/i,
    /application sent to recruiter/i,
    /applied successfully/i,
  ],

  errorSelectors: COMMON_ERROR_SELECTORS,
}
