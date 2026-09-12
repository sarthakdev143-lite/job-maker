/**
 * Lever.
 *
 * Names are flat and stable (`name`, `email`, `org`), links are namespaced as
 * `urls[LinkedIn]`, and custom questions arrive as `cards[uuid][field0]` which
 * carry no meaning -- those fall through to the generic matcher and the model.
 *
 * Lever takes one combined `name` field rather than first/last, which is why
 * the adapter maps it to `fullName`.
 */

import type { SiteAdapter } from '../types'
import { COMMON_ERROR_SELECTORS, COMMON_SUCCESS_PATTERNS, textOf } from '../types'
import type { CanonicalKey } from '@/form/canonical'
import type { FieldDescriptor } from '@/storage/schemas'

const NAME_MAP: Record<string, CanonicalKey> = {
  name: 'fullName',
  email: 'email',
  phone: 'phone',
  org: 'currentCompany',
  resume: 'resume',
  comments: 'coverLetterText',
  location: 'city',
}

const URL_MAP: Record<string, CanonicalKey> = {
  linkedin: 'linkedin',
  github: 'github',
  portfolio: 'portfolio',
  twitter: 'portfolio',
  other: 'portfolio',
}

export const leverAdapter: SiteAdapter = {
  id: 'lever',
  label: 'Lever',

  matches(url: string): boolean {
    return /(^|\.)lever\.co$/.test(new URL(url, location.href).hostname)
  },

  detect(doc: Document, url: string) {
    const form = doc.querySelector('form[action*="apply"], .application-form, form.application-form')
    const hasCore = Boolean(doc.querySelector('input[name="name"], input[name="email"]'))
    const title = textOf(doc.querySelector('.posting-headline h2, h2')) || doc.title
    const company =
      textOf(doc.querySelector('.main-header-logo img, .posting-headline .sort-by-time')) ||
      companyFromUrl(url)

    return {
      isApplicationForm: Boolean(form || hasCore),
      confidence: hasCore ? 0.95 : form ? 0.75 : 0.2,
      jobTitle: title,
      company,
      multiStep: false,
      detail: 'lever hosted posting',
    }
  },

  canonicalKey(field: FieldDescriptor): CanonicalKey | null {
    const name = field.name.trim()
    if (NAME_MAP[name]) return NAME_MAP[name] ?? null

    const urlMatch = name.match(/^urls\[([^\]]+)\]$/i)
    if (urlMatch?.[1]) {
      const key = urlMatch[1].toLowerCase()
      return URL_MAP[key] ?? 'portfolio'
    }

    // Consent and EEO blocks use `eeo[...]`; let the generic matcher read the
    // label, which is far more informative than the index-based name.
    return null
  },

  applyEntrySelectors: ['a.postings-btn[href*="apply"]', 'a[href$="/apply"]', '.template-btn-submit'],

  submitSelectors: [
    'button[type="submit"].template-btn-submit',
    '.template-btn-submit',
    'button[data-qa="btn-submit"]',
    'form button[type="submit"]',
  ],

  successSelectors: ['.application-confirmation', '[data-qa="confirmation"]'],

  successPatterns: [...COMMON_SUCCESS_PATTERNS, /thank you for applying/i, /application received/i],

  errorSelectors: [...COMMON_ERROR_SELECTORS, '.application-error'],
}

function companyFromUrl(url: string): string {
  const m = url.match(/jobs\.lever\.co\/([^/?#]+)/)
  return m?.[1]?.replace(/[-_]/g, ' ') ?? ''
}
