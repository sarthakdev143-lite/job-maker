/**
 * SmartRecruiters.
 *
 * Camel-cased ids on the core fields and `data-test` attributes on the
 * controls. The job page and the application live at the same URL with the form
 * revealed by an apply button, so `applyEntrySelectors` matters more here than
 * on the other boards.
 */

import type { SiteAdapter } from '../types'
import { COMMON_ERROR_SELECTORS, COMMON_SUCCESS_PATTERNS, textOf } from '../types'
import type { CanonicalKey } from '@/form/canonical'
import type { FieldDescriptor } from '@/storage/schemas'

const ID_MAP: Record<string, CanonicalKey> = {
  firstname: 'firstName',
  lastname: 'lastName',
  email: 'email',
  phonenumber: 'phone',
  phone: 'phone',
  location: 'city',
  city: 'city',
  country: 'country',
  linkedinprofileurl: 'linkedin',
  web: 'portfolio',
  resume: 'resume',
  coverletter: 'coverLetter',
}

export const smartRecruitersAdapter: SiteAdapter = {
  id: 'smartrecruiters',
  label: 'SmartRecruiters',

  matches(url: string): boolean {
    return /smartrecruiters\.com$/.test(new URL(url, location.href).hostname)
  },

  detect(doc: Document, url: string) {
    const hasCore = Boolean(doc.querySelector('#firstName, #lastName, [data-test="form-field-firstName"]'))
    const title = textOf(doc.querySelector('[data-test="job-title"], h1')) || doc.title
    const company = textOf(doc.querySelector('[data-test="company-name"]')) || companyFromUrl(url)

    return {
      isApplicationForm: hasCore,
      confidence: hasCore ? 0.9 : 0.25,
      jobTitle: title,
      company,
      multiStep: false,
      detail: 'smartrecruiters application',
    }
  },

  canonicalKey(field: FieldDescriptor): CanonicalKey | null {
    const key = (field.id || field.name).toLowerCase().replace(/[^a-z]/g, '')
    return ID_MAP[key] ?? null
  },

  applyEntrySelectors: [
    'button[data-test="apply-button"]',
    'a[data-test="apply-button"]',
    'button.js-app-apply',
  ],

  submitSelectors: [
    'button[data-test="form-submit"]',
    'button[type="submit"]',
    '#submit-application',
  ],

  successSelectors: ['[data-test="application-submitted"]'],

  successPatterns: [...COMMON_SUCCESS_PATTERNS, /application was sent/i],

  errorSelectors: [...COMMON_ERROR_SELECTORS, '[data-test*="error"]'],
}

function companyFromUrl(url: string): string {
  const m = url.match(/smartrecruiters\.com\/([^/?#]+)/)
  return m?.[1]?.replace(/[-_]/g, ' ') ?? ''
}
