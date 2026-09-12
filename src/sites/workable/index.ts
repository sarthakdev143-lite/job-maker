/**
 * Workable.
 *
 * Field names are lowercase and unpunctuated (`firstname`, `lastname`), and the
 * whole UI is keyed by `data-ui` attributes, which are the most durable handles
 * on the page and are what the submit selectors use.
 */

import type { SiteAdapter } from '../types'
import { COMMON_ERROR_SELECTORS, COMMON_SUCCESS_PATTERNS, textOf } from '../types'
import type { CanonicalKey } from '@/form/canonical'
import type { FieldDescriptor } from '@/storage/schemas'

const NAME_MAP: Record<string, CanonicalKey> = {
  firstname: 'firstName',
  lastname: 'lastName',
  email: 'email',
  phone: 'phone',
  resume: 'resume',
  cover_letter: 'coverLetter',
  coverletter: 'coverLetter',
  address: 'addressLine1',
  headline: 'currentTitle',
  summary: 'coverLetterText',
  linkedin_url: 'linkedin',
  github_url: 'github',
  portfolio_url: 'portfolio',
}

export const workableAdapter: SiteAdapter = {
  id: 'workable',
  label: 'Workable',

  matches(url: string): boolean {
    return /workable\.com$/.test(new URL(url, location.href).hostname)
  },

  detect(doc: Document, url: string) {
    const hasCore = Boolean(doc.querySelector('input[name="firstname"], input[name="lastname"]'))
    const hasForm = Boolean(doc.querySelector('form[data-ui="application-form"], form'))
    const title = textOf(doc.querySelector('[data-ui="job-title"], h1')) || doc.title
    const company = textOf(doc.querySelector('[data-ui="company-name"]')) || companyFromUrl(url)

    return {
      isApplicationForm: hasCore || (hasForm && /\/apply\b/.test(url)),
      confidence: hasCore ? 0.93 : /\/apply\b/.test(url) ? 0.6 : 0.2,
      jobTitle: title,
      company,
      multiStep: false,
      detail: 'workable application',
    }
  },

  canonicalKey(field: FieldDescriptor): CanonicalKey | null {
    const name = field.name.toLowerCase().replace(/[\s-]/g, '_')
    return NAME_MAP[name] ?? null
  },

  applyEntrySelectors: ['a[data-ui="apply-button"]', 'button[data-ui="apply-button"]', 'a[href*="/apply"]'],

  submitSelectors: [
    'button[data-ui="submit-application"]',
    'button[type="submit"]',
    'form button:last-of-type',
  ],

  successSelectors: ['[data-ui="application-success"]', '[data-ui="thank-you"]'],

  successPatterns: [...COMMON_SUCCESS_PATTERNS, /application sent/i],

  errorSelectors: [...COMMON_ERROR_SELECTORS, '[data-ui="error"]'],
}

function companyFromUrl(url: string): string {
  const m = url.match(/apply\.workable\.com\/([^/?#]+)/)
  return m?.[1]?.replace(/[-_]/g, ' ') ?? ''
}
