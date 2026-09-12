/**
 * Greenhouse.
 *
 * The most predictable of the target set: ids are stable (`#first_name`,
 * `#email`), custom questions live under `job_application[answers_attributes]`,
 * and the whole form is one page with a single submit. Companies also embed the
 * board in their own site via an iframe (`#grnhse_app`), which is why the
 * adapter matches on markup as well as hostname.
 */

import type { SiteAdapter } from '../types'
import { COMMON_ERROR_SELECTORS, COMMON_SUCCESS_PATTERNS, textOf } from '../types'
import type { CanonicalKey } from '@/form/canonical'
import type { FieldDescriptor } from '@/storage/schemas'

const FIELD_IDS: Record<string, CanonicalKey> = {
  first_name: 'firstName',
  last_name: 'lastName',
  email: 'email',
  phone: 'phone',
  resume: 'resume',
  cover_letter: 'coverLetter',
  job_application_location: 'city',
}

export const greenhouseAdapter: SiteAdapter = {
  id: 'greenhouse',
  label: 'Greenhouse',

  matches(url: string): boolean {
    return /(^|\.)greenhouse\.io/.test(new URL(url, location.href).hostname)
  },

  detect(doc: Document, url: string) {
    const embedded = doc.querySelector('#grnhse_app, #grnhse_iframe')
    const form = doc.querySelector('#application_form, form[action*="greenhouse"], form#application-form')
    const hasCoreFields = Boolean(doc.querySelector('#first_name, #last_name, input[name*="job_application"]'))
    const title =
      textOf(doc.querySelector('.app-title, h1.app-title, h1')) ||
      doc.title.replace(/\s*[-|]\s*.*$/, '')
    const company =
      textOf(doc.querySelector('.company-name, [class*="company"]')).replace(/^at\s+/i, '') ||
      companyFromUrl(url)

    const isApplicationForm = Boolean(form || hasCoreFields)
    return {
      isApplicationForm,
      confidence: hasCoreFields ? 0.95 : form ? 0.8 : embedded ? 0.5 : 0.2,
      jobTitle: title,
      company,
      multiStep: false,
      detail: embedded ? 'embedded board' : 'hosted board',
    }
  },

  canonicalKey(field: FieldDescriptor): CanonicalKey | null {
    const direct = FIELD_IDS[field.id]
    if (direct) return direct

    // Greenhouse names everything job_application[...]; the inner key is useful.
    const m = field.name.match(/job_application\[(\w+)\]/)
    if (m?.[1] && FIELD_IDS[m[1]]) return FIELD_IDS[m[1]] ?? null

    // Auto-filled location autocomplete.
    if (field.id === 'auto_complete_input' || /location/i.test(field.name)) return 'city'

    // Custom questions carry no semantic name; let the generic matcher decide.
    return null
  },

  applyEntrySelectors: ['#apply_button', 'a[href*="#app"]', 'a.template-btn-submit'],

  submitSelectors: [
    '#submit_app',
    'input[type="submit"][value*="Submit" i]',
    'button#submit_app',
    'form#application_form button[type="submit"]',
    'button[type="submit"]',
  ],

  successSelectors: ['#application_confirmation', '.application-confirmation'],

  successPatterns: [
    ...COMMON_SUCCESS_PATTERNS,
    /your application has been submitted/i,
    /thanks for applying/i,
  ],

  errorSelectors: [...COMMON_ERROR_SELECTORS, '.field_with_errors', '#error_message'],
}

function companyFromUrl(url: string): string {
  const m = url.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([^/?#]+)/)
  return m?.[1]?.replace(/[-_]/g, ' ') ?? ''
}
