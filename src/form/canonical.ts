/**
 * Canonical fields.
 *
 * Roughly eighty percent of what an ATS asks is the same eighty percent every
 * time: name, email, phone, links, location, work authorisation, notice period,
 * compensation. This module recognises those questions from their label alone
 * and answers them straight from the profile -- no answer bank, no model call,
 * no network.
 *
 * The patterns run against `normalizeQuestion` output, so they see lowercased,
 * stop-word-stripped, spelling-normalized text ("are you legally authorized to
 * work in the united states" becomes "legally authorized work united states").
 */

import { normalizeQuestion } from '@/shared/text'
import type { FieldDescriptor, Profile } from '@/storage/schemas'

export type CanonicalKey =
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'preferredName'
  | 'email'
  | 'phone'
  | 'addressLine1'
  | 'addressLine2'
  | 'city'
  | 'state'
  | 'postalCode'
  | 'country'
  | 'linkedin'
  | 'github'
  | 'portfolio'
  | 'currentCompany'
  | 'currentTitle'
  | 'yearsExperience'
  | 'expectedSalary'
  | 'currentSalary'
  | 'noticePeriod'
  | 'availableFrom'
  | 'willingToRelocate'
  | 'requiresSponsorship'
  | 'workAuthorized'
  | 'resume'
  | 'coverLetter'
  | 'coverLetterText'
  | 'howDidYouHear'
  | 'eeoGender'
  | 'eeoRace'
  | 'eeoVeteran'
  | 'eeoDisability'
  | 'eeoHispanic'
  | 'consent'

/**
 * Ordered: the first pattern that matches wins, so more specific questions must
 * come before the generic ones they contain. "current company" must beat
 * "company", "cover letter" must beat "letter".
 */
const PATTERNS: Array<[CanonicalKey, RegExp]> = [
  // Names -- "legal first name", "given name", "first name" all land here.
  ['firstName', /^(legal |preferred |given )?first name$|^first$|^forename$|^given name$/],
  ['lastName', /^(legal |preferred )?last name$|^last$|^surname$|^family name$/],
  ['preferredName', /^preferred name$|^nickname$|^goes by$/],
  ['fullName', /^(legal |full )?name$|^your name$|^candidate name$|^applicant name$/],

  // Contact
  ['email', /email/],
  ['phone', /phone|mobile number|contact number/],

  // Address
  ['addressLine1', /^address$|address line 1|street address|^street$/],
  ['addressLine2', /address line 2|apartment|apt suite|unit number/],
  ['city', /^city$|^town$|city town|^location city$/],
  ['state', /^state$|^province$|state province|^region$/],
  ['postalCode', /postal code|zip code|^zip$|^pincode$|^pin code$/],
  ['country', /^country$|country region|^nationality country$/],

  // Links -- checked before generic "website"
  ['linkedin', /linkedin/],
  ['github', /github|gitlab|bitbucket/],
  ['portfolio', /portfolio|personal website|^website$|personal site|^url$|other website/],

  // Current role
  ['currentCompany', /current company|current employer|present employer|^employer$|^company$|organization currently/],
  ['currentTitle', /current title|current role|current position|current job title|^job title$|^title$|^designation$/],
  ['yearsExperience', /years experience|total experience|^experience years$|years relevant experience|^work experience years$/],

  // Compensation -- expected before current, because "expected current" is rare
  ['expectedSalary', /expected compensation|expected salary|desired compensation|desired salary|compensation expectation|salary expectation|expected ctc/],
  ['currentSalary', /current compensation|current ctc|present compensation|current salary/],

  // Availability
  ['noticePeriod', /notice period|serving notice|how soon join|earliest start|joining time/],
  ['availableFrom', /available start date|start date available|when can you start|availability date|available from/],

  // Yes/no policy questions
  ['willingToRelocate', /willing relocate|open relocation|relocate/],
  ['requiresSponsorship', /require sponsorship|need sponsorship|visa sponsorship|sponsorship employment|will you require|require immigration/],
  ['workAuthorized', /legally authorized|legally authorised|authorized work|authorised work|eligible work|right work|work permit/],

  // Documents
  ['resume', /resume|^cv$|curriculum vitae/],
  ['coverLetterText', /cover letter (text|body)|paste cover letter|cover letter below/],
  ['coverLetter', /cover letter|covering letter|motivation letter/],

  // Sourcing
  ['howDidYouHear', /how did you hear|how did you find|referral source|where did you hear|source/],

  // EEO
  ['eeoGender', /^gender$|gender identity|^sex$/],
  ['eeoHispanic', /hispanic|latino/],
  ['eeoRace', /race|ethnicity|ethnic/],
  ['eeoVeteran', /veteran|military service|protected veteran/],
  ['eeoDisability', /disability|disabled/],

  // Consent checkboxes
  ['consent', /agree|consent|acknowledge|certify|privacy policy|terms conditions|gdpr|data processing/],
]

/**
 * Identify a field from its label. `null` means "not one of the common ones",
 * which pushes the field down to the answer bank and then the model.
 */
export function canonicalKeyFor(field: FieldDescriptor): CanonicalKey | null {
  const label = field.normalizedLabel || normalizeQuestion(field.label)
  const nameHint = normalizeQuestion(field.name.replace(/[_\-\[\]]+/g, ' '))
  const idHint = normalizeQuestion(field.id.replace(/[_\-]+/g, ' '))

  // A file input is a document question regardless of how it is labelled.
  if (field.kind === 'file') {
    const haystack = `${label} ${nameHint} ${idHint}`
    if (/cover/.test(haystack)) return 'coverLetter'
    if (/resume|cv|curriculum/.test(haystack)) return 'resume'
    return 'resume'
  }

  for (const source of [label, nameHint, idHint]) {
    if (!source) continue
    for (const [key, re] of PATTERNS) {
      if (re.test(source)) return key
    }
  }
  return null
}

function yesNo(value: boolean, field: FieldDescriptor): string {
  // Respect the form's own wording when it offers options.
  if (field.options.length > 0) {
    const want = value ? /^y(es)?$|^true$/i : /^n(o)?$|^false$/i
    const hit = field.options.find((o) => want.test(o.label.trim()) || want.test(o.value.trim()))
    if (hit) return hit.label || hit.value
  }
  return value ? 'Yes' : 'No'
}

/** Pick the option that means "prefer not to say", for EEO questions. */
function declineOption(field: FieldDescriptor, fallback: string): string {
  const decline = field.options.find((o) =>
    /decline|prefer not|do not wish|dont wish|not wish to|choose not/i.test(o.label)
  )
  return decline?.label ?? fallback
}

function matchOption(field: FieldDescriptor, value: string): string {
  if (field.options.length === 0) return value
  const lower = value.toLowerCase().trim()
  const exact = field.options.find((o) => o.label.toLowerCase().trim() === lower)
  if (exact) return exact.label
  const partial = field.options.find(
    (o) => o.label.toLowerCase().includes(lower) || lower.includes(o.label.toLowerCase())
  )
  return partial?.label ?? value
}

export type CanonicalAnswer = { value: string; confidence: number; note: string }

/**
 * Answer a canonical field from the profile.
 *
 * `null` means the profile has nothing to say, which is different from an empty
 * answer -- the caller passes it further down the resolution chain instead of
 * filling a blank.
 */
export function answerCanonical(
  key: CanonicalKey,
  profile: Profile,
  field: FieldDescriptor
): CanonicalAnswer | null {
  const wa = profile.workAuthorization
  const comp = profile.compensation
  const v = (value: string, confidence = 0.97, note = 'profile'): CanonicalAnswer | null =>
    value && value.trim() ? { value: value.trim(), confidence, note } : null

  switch (key) {
    case 'firstName':
      return v(profile.firstName)
    case 'lastName':
      return v(profile.lastName)
    case 'fullName':
      return v(`${profile.firstName} ${profile.lastName}`.trim())
    case 'preferredName':
      return v(profile.preferredName || profile.firstName)
    case 'email':
      return v(profile.email)
    case 'phone': {
      // Some forms take the country code separately; only prefix when the field
      // is plainly a single international number.
      const wantsCode = /country code|international/i.test(field.label)
      if (wantsCode) return v(profile.phoneCountryCode)
      return v(profile.phone)
    }
    case 'addressLine1':
      return v(profile.addressLine1)
    case 'addressLine2':
      return v(profile.addressLine2, 0.9)
    case 'city':
      return v(profile.city)
    case 'state':
      return v(matchOption(field, profile.state))
    case 'postalCode':
      return v(profile.postalCode)
    case 'country':
      return v(matchOption(field, profile.country))
    case 'linkedin':
      return v(profile.linkedin)
    case 'github':
      return v(profile.github)
    case 'portfolio':
      return v(profile.portfolio)
    case 'currentCompany':
      return v(profile.currentCompany || profile.experience[0]?.company || '')
    case 'currentTitle':
      return v(profile.currentTitle || profile.experience[0]?.title || '')
    case 'yearsExperience':
      return profile.yearsExperience > 0 ? v(String(profile.yearsExperience)) : null
    case 'expectedSalary':
      return v(comp.expectedCtc, 0.92)
    case 'currentSalary':
      return v(comp.currentCtc, 0.92)
    case 'noticePeriod':
      return wa.noticePeriodDays > 0 ? v(`${wa.noticePeriodDays} days`, 0.9) : null
    case 'availableFrom':
      return v(wa.availableFrom, 0.9)
    case 'willingToRelocate':
      return { value: yesNo(wa.willingToRelocate, field), confidence: 0.95, note: 'work authorization' }
    case 'requiresSponsorship':
      return { value: yesNo(wa.requiresSponsorship, field), confidence: 0.95, note: 'work authorization' }
    case 'workAuthorized': {
      // "Authorized to work in X" is only answerable when we know which X.
      const countries = wa.authorizedInCountries.map((c) => c.toLowerCase())
      if (countries.length === 0) return null
      const label = field.label.toLowerCase()
      const mentioned = countries.find((c) => label.includes(c))
      const usAsked = /united states|u\.s\.|\bus\b|usa/.test(label)
      const usOk = countries.some((c) => /united states|usa|us$/.test(c))
      if (mentioned) return { value: yesNo(true, field), confidence: 0.95, note: `authorized in ${mentioned}` }
      if (usAsked) return { value: yesNo(usOk, field), confidence: 0.9, note: 'US work authorization' }
      // Unqualified "are you authorized to work here" on an unknown country is
      // exactly the kind of question worth a human glance.
      return { value: yesNo(true, field), confidence: 0.55, note: 'country not identified in question' }
    }
    case 'eeoGender':
      return profile.voluntary.answerEeoQuestions
        ? { value: matchOption(field, profile.voluntary.gender), confidence: 0.9, note: 'voluntary' }
        : { value: declineOption(field, profile.voluntary.gender), confidence: 0.9, note: 'declined by setting' }
    case 'eeoRace':
      return profile.voluntary.answerEeoQuestions
        ? { value: matchOption(field, profile.voluntary.race), confidence: 0.9, note: 'voluntary' }
        : { value: declineOption(field, profile.voluntary.race), confidence: 0.9, note: 'declined by setting' }
    case 'eeoHispanic':
      return profile.voluntary.answerEeoQuestions
        ? { value: matchOption(field, profile.voluntary.hispanicLatino), confidence: 0.9, note: 'voluntary' }
        : { value: declineOption(field, profile.voluntary.hispanicLatino), confidence: 0.9, note: 'declined by setting' }
    case 'eeoVeteran':
      return { value: declineOption(field, profile.voluntary.veteranStatus), confidence: 0.88, note: 'voluntary' }
    case 'eeoDisability':
      return { value: declineOption(field, profile.voluntary.disabilityStatus), confidence: 0.88, note: 'voluntary' }
    case 'consent':
      // Only ever tick an agreement box; never untick one the user set.
      return { value: 'true', confidence: 0.93, note: 'required consent' }
    case 'howDidYouHear':
      return { value: matchOption(field, 'Company website'), confidence: 0.6, note: 'generic answer' }
    case 'resume':
    case 'coverLetter':
    case 'coverLetterText':
      // Documents are attached by the runner, not filled as text.
      return null
    default:
      return null
  }
}

/** True for keys the runner satisfies with a generated document. */
export function isDocumentKey(key: CanonicalKey | null): key is 'resume' | 'coverLetter' | 'coverLetterText' {
  return key === 'resume' || key === 'coverLetter' || key === 'coverLetterText'
}
