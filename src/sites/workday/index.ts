/**
 * Workday.
 *
 * The hardest target and the only genuinely multi-step one. Three things make
 * it different from the other adapters:
 *
 * 1. Every meaningful element carries `data-automation-id`, which is stable
 *    across tenants and releases. It is the only selector family worth using.
 * 2. Applying requires an account per employer tenant, created with an email
 *    confirmation the extension cannot read. `requiresAccount` flags this so
 *    the runner parks the application with a clear reason instead of failing
 *    obscurely halfway through.
 * 3. The form is a wizard: My Information, My Experience, Application
 *    Questions, Voluntary Disclosures, Review. The same bottom-navigation
 *    button reads "Next" throughout and "Submit" on the last page, so the
 *    runner distinguishes them by label rather than by selector.
 */

import type { SiteAdapter } from '../types'
import { COMMON_ERROR_SELECTORS, COMMON_SUCCESS_PATTERNS, textOf } from '../types'
import type { CanonicalKey } from '@/form/canonical'
import type { FieldDescriptor } from '@/storage/schemas'

const AUTOMATION_MAP: Record<string, CanonicalKey> = {
  legalNameSection_firstName: 'firstName',
  legalNameSection_lastName: 'lastName',
  email: 'email',
  phone: 'phone',
  phoneNumber: 'phone',
  addressSection_addressLine1: 'addressLine1',
  addressSection_addressLine2: 'addressLine2',
  addressSection_city: 'city',
  addressSection_countryRegion: 'state',
  addressSection_postalCode: 'postalCode',
  countryDropdown: 'country',
  country: 'country',
  resumeUpload: 'resume',
  file_upload_input: 'resume',
  gender: 'eeoGender',
  ethnicity: 'eeoRace',
  veteranStatus: 'eeoVeteran',
  disability: 'eeoDisability',
}

const LINK_HINTS: Array<[RegExp, CanonicalKey]> = [
  [/linkedin/i, 'linkedin'],
  [/github/i, 'github'],
  [/website|portfolio/i, 'portfolio'],
]

export const workdayAdapter: SiteAdapter & { requiresAccount: true } = {
  id: 'workday',
  label: 'Workday',
  requiresAccount: true,

  matches(url: string): boolean {
    const host = new URL(url, location.href).hostname
    return /myworkdayjobs\.com$|myworkdaysite\.com$|\.workday\.com$/.test(host)
  },

  detect(doc: Document, url: string) {
    const wizard = doc.querySelector('[data-automation-id="progressBar"], [data-automation-id="jobPostingPage"]')
    const hasFields = Boolean(doc.querySelector('[data-automation-id="legalNameSection_firstName"], [data-automation-id="email"]'))
    const signInWall = Boolean(
      doc.querySelector('[data-automation-id="signInLink"], [data-automation-id="createAccountLink"]')
    )
    const title = textOf(doc.querySelector('[data-automation-id="jobPostingHeader"], h1, h2')) || doc.title
    const company = companyFromUrl(url)

    return {
      isApplicationForm: hasFields,
      confidence: hasFields ? 0.9 : wizard ? 0.5 : 0.2,
      jobTitle: title,
      company,
      multiStep: true,
      detail: signInWall ? 'sign-in or account creation required' : 'workday wizard',
    }
  },

  canonicalKey(field: FieldDescriptor): CanonicalKey | null {
    // The harvester keeps data-automation-id in the selector; read it back.
    const auto = field.selector.match(/data-automation-id="([^"]+)"/)?.[1] ?? field.id
    if (auto && AUTOMATION_MAP[auto]) return AUTOMATION_MAP[auto] ?? null

    for (const [re, key] of LINK_HINTS) {
      if (re.test(field.label)) return key
    }
    return null
  },

  applyEntrySelectors: [
    '[data-automation-id="adventureButton"]',
    'a[data-automation-id="applyButton"]',
    'button[data-automation-id="applyManually"]',
  ],

  nextStepSelectors: [
    '[data-automation-id="bottom-navigation-next-button"]',
    'button[data-automation-id="pageFooterNextButton"]',
  ],

  submitSelectors: [
    '[data-automation-id="bottom-navigation-next-button"]',
    'button[data-automation-id="submitButton"]',
  ],

  successSelectors: ['[data-automation-id="applicationSubmitted"]', '[data-automation-id="confirmationPage"]'],

  successPatterns: [...COMMON_SUCCESS_PATTERNS, /you have successfully submitted/i, /application submitted/i],

  errorSelectors: [...COMMON_ERROR_SELECTORS, '[data-automation-id="errorMessage"]'],
}

/** True when this Workday page is asking us to sign in or create an account. */
export function workdayNeedsAccount(doc: Document): boolean {
  return Boolean(
    doc.querySelector(
      '[data-automation-id="createAccountLink"], [data-automation-id="signInLink"], [data-automation-id="createAccountCheckbox"]'
    )
  )
}

function companyFromUrl(url: string): string {
  const m = url.match(/\/\/([^.]+)\.(?:wd\d+\.)?myworkdayjobs\.com/)
  return m?.[1]?.replace(/[-_]/g, ' ') ?? ''
}
