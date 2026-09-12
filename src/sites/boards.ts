/**
 * Indeed and Naukri.
 *
 * Both are treated primarily as discovery surfaces rather than apply surfaces,
 * for different reasons:
 *
 * - Indeed fingerprints automation aggressively, and most of its listings
 *   redirect to a real ATS anyway. The happy path is: find the job here, follow
 *   the redirect, apply on Greenhouse or Lever with a proper adapter. Indeed's
 *   own smartapply flow is supported but ships disabled and capped.
 * - Naukri is the opposite: permissive, but its apply flow is often a single
 *   button plus a chatbot that asks follow-up questions in a drawer. The
 *   adapter recognises both.
 */

import type { SiteAdapter } from './types'
import { COMMON_ERROR_SELECTORS, COMMON_SUCCESS_PATTERNS, textOf } from './types'
import type { CanonicalKey } from '@/form/canonical'
import type { FieldDescriptor } from '@/storage/schemas'

export const indeedAdapter: SiteAdapter = {
  id: 'indeed',
  label: 'Indeed',

  matches(url: string): boolean {
    return /indeed\.com$/.test(new URL(url, location.href).hostname)
  },

  detect(doc: Document, url: string) {
    const onSmartApply = /smartapply\.indeed\.com|\/apply\b/.test(url)
    const hasForm = Boolean(doc.querySelector('form, [data-testid*="input"]'))
    const title = textOf(doc.querySelector('[data-testid="jobsearch-JobInfoHeader-title"], h1')) || doc.title
    const company = textOf(doc.querySelector('[data-testid="inlineHeader-companyName"], [data-company-name]'))

    return {
      isApplicationForm: onSmartApply && hasForm,
      confidence: onSmartApply ? 0.7 : 0.15,
      jobTitle: title,
      company,
      multiStep: true,
      detail: onSmartApply ? 'indeed smartapply' : 'indeed listing page',
    }
  },

  canonicalKey(field: FieldDescriptor): CanonicalKey | null {
    const handle = `${field.id} ${field.name}`.toLowerCase()
    if (/first.?name/.test(handle)) return 'firstName'
    if (/last.?name/.test(handle)) return 'lastName'
    if (/email/.test(handle)) return 'email'
    if (/phone/.test(handle)) return 'phone'
    if (/resume/.test(handle)) return 'resume'
    return null
  },

  applyEntrySelectors: [
    '#indeedApplyButton',
    '[data-testid="indeedApplyButton"]',
    'button[aria-label*="Apply" i]',
  ],

  nextStepSelectors: [
    'button[data-testid="continue-button"]',
    'button[type="submit"]:not([data-testid*="submit"])',
  ],

  submitSelectors: ['button[data-testid="submit-application"]', 'button[type="submit"]'],

  successPatterns: [...COMMON_SUCCESS_PATTERNS, /your application has been submitted/i],

  errorSelectors: COMMON_ERROR_SELECTORS,
}

export const naukriAdapter: SiteAdapter = {
  id: 'naukri',
  label: 'Naukri',

  matches(url: string): boolean {
    return /naukri\.com$/.test(new URL(url, location.href).hostname)
  },

  detect(doc: Document, url: string) {
    const applyButton = doc.querySelector('#apply-button, .apply-button, button[id*="apply" i]')
    // The chatbot drawer is where Naukri asks its screening questions.
    const chatbot = doc.querySelector('.chatbot_DrawerContentWrapper, [class*="chatbot"]')
    const title = textOf(doc.querySelector('.styles_jd-header-title__rZwM1, h1')) || doc.title
    const company = textOf(doc.querySelector('.styles_jd-header-comp-name__MvqAI, [class*="comp-name"]'))

    return {
      isApplicationForm: Boolean(chatbot || applyButton),
      confidence: chatbot ? 0.8 : applyButton ? 0.55 : 0.15,
      jobTitle: title,
      company,
      multiStep: Boolean(chatbot),
      detail: chatbot ? 'naukri chatbot questions' : 'naukri listing',
    }
  },

  applyEntrySelectors: ['#apply-button', '.apply-button', 'button[id*="apply" i]'],

  nextStepSelectors: ['.sendMsg', 'button[class*="send" i]', '.chatbot_Chat_Send'],

  submitSelectors: ['#apply-button', '.sendMsg', 'button[class*="send" i]'],

  successPatterns: [
    ...COMMON_SUCCESS_PATTERNS,
    /you have (successfully )?applied/i,
    /applied to this job/i,
    /application sent to recruiter/i,
  ],

  errorSelectors: COMMON_ERROR_SELECTORS,
}
