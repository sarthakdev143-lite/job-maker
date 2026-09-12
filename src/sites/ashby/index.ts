/**
 * Ashby.
 *
 * A React app with no server-rendered ids worth trusting; the durable handles
 * are the `_systemfield_*` names on the built-in fields. Custom questions are
 * keyed by UUID and carry nothing useful, so they rely entirely on the label
 * cascade -- which works well here because Ashby renders real <label> elements.
 *
 * The form appears under /application on the posting URL and renders after a
 * data fetch, so detection tolerates a brief empty state.
 */

import type { SiteAdapter } from '../types'
import { COMMON_ERROR_SELECTORS, COMMON_SUCCESS_PATTERNS, textOf } from '../types'
import type { CanonicalKey } from '@/form/canonical'
import type { FieldDescriptor } from '@/storage/schemas'

const SYSTEM_FIELDS: Record<string, CanonicalKey> = {
  name: 'fullName',
  email: 'email',
  phone: 'phone',
  resume: 'resume',
  linkedin: 'linkedin',
  github: 'github',
  website: 'portfolio',
  location: 'city',
  cover_letter: 'coverLetter',
}

export const ashbyAdapter: SiteAdapter = {
  id: 'ashby',
  label: 'Ashby',

  matches(url: string): boolean {
    return /ashbyhq\.com$/.test(new URL(url, location.href).hostname)
  },

  detect(doc: Document, url: string) {
    const hasSystemFields = Boolean(doc.querySelector('[name*="_systemfield_"], [id*="_systemfield_"]'))
    const hasForm = Boolean(doc.querySelector('form'))
    const onApplyRoute = /\/application\b/.test(url)
    const title = textOf(doc.querySelector('h1, [class*="job-title"]')) || doc.title
    const company = textOf(doc.querySelector('[class*="companyName"], header img[alt]')) || companyFromUrl(url)

    return {
      isApplicationForm: hasSystemFields || (hasForm && onApplyRoute),
      confidence: hasSystemFields ? 0.93 : onApplyRoute ? 0.6 : 0.2,
      jobTitle: title,
      company,
      multiStep: false,
      detail: 'ashby application',
    }
  },

  canonicalKey(field: FieldDescriptor): CanonicalKey | null {
    const handle = `${field.name} ${field.id}`.toLowerCase()
    const m = handle.match(/_systemfield_(\w+)/)
    if (m?.[1]) return SYSTEM_FIELDS[m[1]] ?? null
    return null
  },

  applyEntrySelectors: [
    'a[href$="/application"]',
    'button[class*="ApplyButton"]',
    'a[class*="ApplyButton"]',
  ],

  submitSelectors: [
    'button[type="submit"]',
    'button[class*="submit" i]',
    'form button:last-of-type',
  ],

  successSelectors: ['[class*="ApplicationSuccess"]', '[class*="submitted" i]'],

  successPatterns: [
    ...COMMON_SUCCESS_PATTERNS,
    /your application (was|has been) sent/i,
    /thanks for your interest/i,
  ],

  errorSelectors: [...COMMON_ERROR_SELECTORS, '[class*="ErrorMessage"]'],
}

function companyFromUrl(url: string): string {
  const m = url.match(/ashbyhq\.com\/([^/?#]+)/)
  return m?.[1]?.replace(/[-_]/g, ' ') ?? ''
}
