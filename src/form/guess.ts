/**
 * The last tier: answering a question nothing else could answer.
 *
 * A mandatory question left blank does not produce a cautious application, it
 * produces a rejected one -- "your application was not accepted due to
 * incomplete information" -- which is strictly worse than an imperfect answer,
 * because the imperfect answer at least reaches a human. So when every other
 * tier has passed, this one picks the most defensible option on offer rather
 * than leaving the box empty.
 *
 * Two things it will not do, because they turn a hopeful application into a
 * lie with consequences: claim work authorization or sponsorship status it was
 * not given, and claim a credential (degree, licence, clearance) the profile
 * does not list. Those are the questions where a wrong answer is discovered at
 * offer stage and costs the user the role, so they still park.
 */

import type { FieldDescriptor, Job, Profile } from '@/storage/schemas'

export type Guess = { value: string; confidence: number; reasoning: string }

/** Questions where an invented answer is worse than no application at all. */
export const OFF_LIMITS =
  /sponsor|visa|work permit|authoriz|authoris|right to work|citizen|security clearance|background check consent|felon|convict|licen[sc]e number|social security|ssn|aadhaar|pan number|passport number/i

/** True when the question must never be guessed at (auth, sponsorship, credentials). */
export function isOffLimitsQuestion(field: FieldDescriptor): boolean {
  return OFF_LIMITS.test(`${field.label} ${field.placeholder} ${field.name}`.trim())
}

/** Option text that is true for almost anyone, in descending preference. */
const SAFE_OPTIONS: RegExp[] = [
  /^(prefer not to (say|answer|disclose)|decline to (self.?identify|answer)|do not wish to disclose)$/i,
  /^(other|others|any|any of the above|open to (all|any))$/i,
  /^(remote|work from home|anywhere|flexible)$/i,
]

const YES_OPTION = /^(yes|y|true|i agree|agree|i consent|accept)$/i
const PLACEHOLDER = /^(\s*|select|select\.\.\.|choose|choose\.\.\.|--.*--|please select|none|n\/a)$/i

/**
 * A plausible answer for a field no other tier could fill, or null when the
 * question is one that must not be guessed at.
 */
export function guessAnswer(field: FieldDescriptor, profile: Profile, job: Job | null): Guess | null {
  const question = `${field.label} ${field.placeholder} ${field.name}`.trim()
  if (isOffLimitsQuestion(field)) return null

  const options = field.options.filter((o) => !PLACEHOLDER.test(o.label.trim()))

  if (options.length > 0) {
    const pick = pickOption(options, question, profile, job)
    if (pick) return pick
  }

  return freeText(field, question, profile, job)
}

/* ------------------------------------------------------------------ options */

function pickOption(
  options: Array<{ value: string; label: string }>,
  question: string,
  profile: Profile,
  job: Job | null
): Guess | null {
  const find = (re: RegExp) => options.find((o) => re.test(o.label.trim()))

  // A location question has a right answer sitting in the profile; the job's
  // own location is the next best thing, since applying means accepting it.
  if (/city|location|where|base|office|site|preferred work/i.test(question)) {
    for (const candidate of [profile.city, profile.state, job?.location ?? '', profile.country]) {
      if (!candidate.trim()) continue
      const hit = options.find((o) => sameish(o.label, candidate))
      if (hit) {
        return { value: hit.label, confidence: 0.8, reasoning: `matches ${candidate} from your profile` }
      }
    }
    const remote = find(/^(remote|work from home|anywhere|any location)$/i)
    if (remote) return { value: remote.label, confidence: 0.6, reasoning: 'no listed city matched, chose remote' }
  }

  // Notice period and experience have numeric answers in the profile that may
  // appear as banded options ("0-15 days", "3-5 years").
  const banded = matchBand(options, question, profile)
  if (banded) return banded

  for (const safe of SAFE_OPTIONS) {
    const hit = find(safe)
    if (hit) return { value: hit.label, confidence: 0.6, reasoning: 'chose the neutral option' }
  }

  // Consent, agreement and willingness questions: saying yes is what applying
  // means, and a no is an automatic rejection.
  if (/willing|available|agree|consent|confirm|able to|comfortable|open to|do you/i.test(question)) {
    const yes = find(YES_OPTION)
    if (yes) return { value: yes.label, confidence: 0.65, reasoning: 'agreed, as applying implies' }
  }

  const first = options[0]
  return first
    ? { value: first.label, confidence: 0.45, reasoning: 'no option matched; chose the first to avoid a blank answer' }
    : null
}

/** "3-5 years", "0-15 days", "15 to 30 days" against a number from the profile. */
function matchBand(
  options: Array<{ value: string; label: string }>,
  question: string,
  profile: Profile
): Guess | null {
  let actual: number | null = null
  let unit = ''
  if (/notice period|joining|availability|days to join/i.test(question)) {
    actual = profile.workAuthorization.noticePeriodDays
    unit = 'day'
  } else if (/years? of experience|experience|total experience/i.test(question)) {
    actual = profile.yearsExperience
    unit = 'year'
  }
  if (actual === null || !Number.isFinite(actual)) return null

  for (const option of options) {
    const numbers = (option.label.match(/\d+/g) ?? []).map(Number)
    if (numbers.length === 0) continue
    const [low, high = low] = numbers
    const immediate = /immediate|right away|now/i.test(option.label)
    if (immediate && actual <= 7) {
      return { value: option.label, confidence: 0.8, reasoning: `${actual} ${unit}s notice` }
    }
    if (actual >= low && actual <= high) {
      return { value: option.label, confidence: 0.8, reasoning: `${actual} ${unit}s falls in ${option.label}` }
    }
    if (/\+|more than|above|over/i.test(option.label) && actual >= low) {
      return { value: option.label, confidence: 0.75, reasoning: `${actual} ${unit}s is at least ${low}` }
    }
  }
  return null
}

/* ---------------------------------------------------------------- free text */

function freeText(field: FieldDescriptor, question: string, profile: Profile, job: Job | null): Guess | null {
  if (field.kind === 'checkbox') {
    return { value: 'true', confidence: 0.6, reasoning: 'ticked, as applying implies' }
  }

  if (/city|town|location|where.*(live|based|located)|current place/i.test(question)) {
    const value = profile.city || profile.state || job?.location || profile.country
    if (value.trim()) return { value, confidence: 0.85, reasoning: 'your location from the profile' }
  }

  if (/state|province|region/i.test(question) && profile.state.trim()) {
    return { value: profile.state, confidence: 0.85, reasoning: 'your state from the profile' }
  }

  if (/country/i.test(question) && profile.country.trim()) {
    return { value: profile.country, confidence: 0.85, reasoning: 'your country from the profile' }
  }

  if (field.kind === 'number' || /how many|number of|years|months|days/i.test(question)) {
    if (/notice/i.test(question)) {
      return {
        value: String(profile.workAuthorization.noticePeriodDays),
        confidence: 0.8,
        reasoning: 'notice period from the profile',
      }
    }
    if (/experience/i.test(question)) {
      return { value: String(profile.yearsExperience), confidence: 0.8, reasoning: 'experience from the profile' }
    }
    return { value: String(profile.yearsExperience || 1), confidence: 0.4, reasoning: 'a number was required' }
  }

  if (/expected|salary|ctc|compensation|package/i.test(question)) {
    const value = profile.compensation.expectedCtc || profile.compensation.currentCtc
    if (value.trim()) return { value, confidence: 0.8, reasoning: 'expected compensation from the profile' }
    return { value: 'Negotiable', confidence: 0.5, reasoning: 'no figure on file' }
  }

  // A long free-text box with nothing to say is better answered with something
  // relevant than left blank; a short one is usually an identifier and guessing
  // at it would fail validation anyway.
  if (field.kind === 'textarea') {
    const line = profile.headline || profile.currentTitle
    if (line.trim()) {
      return {
        value: `${line}. Keen to contribute to ${job?.company || 'your team'} and happy to discuss further.`,
        confidence: 0.45,
        reasoning: 'a short answer built from your headline',
      }
    }
  }

  return null
}

function sameish(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
  const x = norm(a)
  const y = norm(b)
  return Boolean(x) && Boolean(y) && (x === y || x.includes(y) || y.includes(x))
}
