/**
 * Is this job even the same line of work?
 *
 * A remote-only sweep for a principal architect came back full of account
 * executives, pre-sales specialists and go-to-market leads. Every one was a
 * real remote posting that passed every rule the user had set, and every one
 * cost a model call to score before being thrown away at 8 out of 100.
 *
 * The scorer is right to reject them; it is just an expensive way to notice
 * something a person sees in the title. This is the cheap version: if a posting
 * is plainly from a different profession than the one the applicant has spent
 * their career in, drop it before paying for judgement.
 *
 * Deliberately conservative. It only fires when the title clearly belongs to
 * another function *and* the applicant has never held a title in that function,
 * because the cost of wrongly dropping a job the user wanted is much higher
 * than the cost of one wasted model call.
 */

import { normalizeText } from '@/shared/text'

export type JobFunction =
  | 'engineering'
  | 'sales'
  | 'marketing'
  | 'finance'
  | 'people'
  | 'legal'
  | 'support'
  | 'design'
  | 'operations'
  | 'annotation'
  | 'unknown'

/**
 * Ordered: the first family whose pattern matches wins.
 *
 * Engineering comes first on purpose. "Solutions Architect" and "Sales
 * Engineer" both contain a sales word, but an architect is an architect; only
 * the unambiguous sales titles below should be read as sales.
 */
const FAMILIES: Array<[JobFunction, RegExp]> = [
  [
    'engineering',
    /\b(engineer|engineering|developer|architect|programmer|sre|devops|data scientist|scientist|cto|technical lead|tech lead)\b/,
  ],
  ['design', /\b(designer|design lead|ux|ui designer|product design)\b/],
  [
    'sales',
    /\b(account executive|account manager|sales|business development|bdr|sdr|quota|revenue|go[- ]to[- ]market|gtm|partnerships?)\b/,
  ],
  ['marketing', /\b(marketing|brand|content strategist|seo|demand generation|communications|copywriter)\b/],
  ['finance', /\b(accountant|accounting|controller|bookkeep|payroll|tax|audit|finops|financial analyst|financial planning|fp&a|finance manager|investment analyst)\b/],
  ['people', /\b(recruiter|recruiting|talent acquisition|human resources|hr business|people operations|people partner)\b/],
  ['legal', /\b(counsel|attorney|paralegal|compliance officer|legal)\b/],
  ['support', /\b(customer success|customer support|support specialist|help desk|service desk|technical support)\b/],
  // The two families below were added after a remote-India sweep. A job-board
  // aggregator posts hundreds of these beside the engineering roles -- "PDF
  // Annotation & Transcription Experts - Bengali", "Operations Specialist" --
  // and every one of them cost a model call to reject at single digits.
  [
    'annotation',
    /\b(annotation|annotator|transcription|transcriber|data entry|data label(l)?(er|ing)|content moderat\w*|captioning|ai train(er|ing))\b/,
  ],
  [
    'operations',
    /\b(operations (specialist|manager|associate|executive)|business operations|executive assistant|virtual assistant|office manager|back office)\b/,
  ],
]

/** Which line of work a title belongs to, as far as the words allow. */
export function detectFunction(title: string): JobFunction {
  const t = normalizeText(title)
  if (!t) return 'unknown'
  for (const [family, pattern] of FAMILIES) if (pattern.test(t)) return family
  return 'unknown'
}

/** Every line of work the applicant has actually held a title in. */
export function functionsOf(titles: string[]): Set<JobFunction> {
  const found = new Set<JobFunction>()
  for (const title of titles) {
    const family = detectFunction(title)
    if (family !== 'unknown') found.add(family)
  }
  return found
}

/**
 * Should this posting be dropped as the wrong profession?
 *
 * Only when all three hold: the title clearly belongs to a family, the
 * applicant has a known family of their own, and they have never held a title
 * in the posting's family. Anything uncertain survives to be scored.
 */
export function wrongProfession(jobTitle: string, applicantTitles: string[]): JobFunction | null {
  const theirs = functionsOf(applicantTitles)
  if (theirs.size === 0) return null

  const family = detectFunction(jobTitle)
  if (family === 'unknown') return null

  return theirs.has(family) ? null : family
}
