/**
 * Deterministic prefilter.
 *
 * Runs before any model call and rejects the majority of scraped postings for
 * free. Two reasons this tier exists rather than scoring everything with the
 * model: the web driver can only do one prompt at a time, so a hundred
 * unfiltered jobs is an hour of wall clock; and the rules the user actually
 * cares about ("never a company on this list", "nothing older than 30 days")
 * are absolute, not probabilistic, and should not be left to a model's
 * judgement.
 */

import { detectSeniority, detectWorkMode, normalizeText, parseSalary } from '@/shared/text'
import type { Job, MatchRules } from '@/storage/schemas'

export type PrefilterVerdict = { pass: true } | { pass: false; reason: string }

function anyMatch(haystack: string, needles: string[]): string | null {
  const h = normalizeText(haystack)
  for (const needle of needles) {
    const n = normalizeText(needle)
    if (n && h.includes(n)) return needle
  }
  return null
}


/** Words that mean "remote from anywhere", with no country attached. */
const GLOBAL_REMOTE = /\b(global|worldwide|anywhere|distributed|international)\b/

/**
 * Could someone living in one of `eligible` take this remote role?
 *
 * A location of plain "Remote" says nothing about geography and is treated as
 * open; one that names places has to name a place the user can work from.
 */
/**
 * Regions that contain a country, so a role open to one is open to the other.
 *
 * "Remote - APAC" is open to someone in India, and rejecting it because the
 * word "India" does not appear loses exactly the postings that suit a candidate
 * outside the usual US and EU hiring zones. Only unambiguous groupings are
 * listed: a region whose boundaries nobody agrees on is worth more as a missed
 * filter than as a wrong one.
 */
const REGIONS: Record<string, string[]> = {
  apac: ['india', 'singapore', 'australia', 'japan', 'indonesia', 'malaysia', 'philippines', 'vietnam', 'new zealand'],
  'asia pacific': ['india', 'singapore', 'australia', 'japan', 'indonesia', 'malaysia', 'philippines', 'vietnam'],
  asia: ['india', 'singapore', 'japan', 'indonesia', 'malaysia', 'philippines', 'vietnam', 'thailand'],
  emea: ['united kingdom', 'germany', 'france', 'spain', 'netherlands', 'poland', 'israel', 'south africa', 'uae'],
  europe: ['united kingdom', 'germany', 'france', 'spain', 'netherlands', 'poland', 'ireland', 'portugal'],
  amer: ['united states', 'canada', 'mexico', 'brazil', 'argentina'],
  americas: ['united states', 'canada', 'mexico', 'brazil', 'argentina'],
  latam: ['brazil', 'argentina', 'mexico', 'colombia', 'chile'],
}

export function remoteOpenTo(location: string, eligible: string[]): boolean {
  const loc = normalizeText(location)
  if (!loc) return true
  if (GLOBAL_REMOTE.test(loc)) return true

  // Strip the remote words and see whether anything geographic is left.
  const rest = loc.replace(/\b(remote|hybrid|on[- ]?site|work from home|wfh)\b/g, ' ').replace(/[(),|/·-]/g, ' ').trim()
  if (!rest) return true

  const places = eligible.map((p) => normalizeText(p)).filter((p) => p.length > 1)
  if (places.some((p) => rest.includes(p))) return true

  // A region the applicant's country belongs to counts as naming it.
  for (const [region, members] of Object.entries(REGIONS)) {
    if (!rest.includes(region)) continue
    if (places.some((p) => members.includes(p))) return true
  }

  return false
}

export function prefilter(job: Job, rules: MatchRules, applicantTitles: string[] = []): PrefilterVerdict {
  const title = job.title ?? ''
  const description = job.descriptionText ?? ''
  const company = job.company ?? ''

  // Allowlist, when set, is exclusive: nothing outside it is considered.
  if (rules.companyAllowlist.length > 0 && !anyMatch(company, rules.companyAllowlist)) {
    return { pass: false, reason: 'company not on allowlist' }
  }

  const blocked = anyMatch(company, rules.companyBlocklist)
  if (blocked) return { pass: false, reason: `company blocklisted (${blocked})` }

  const excludedTitle = anyMatch(title, rules.titleExcludes)
  if (excludedTitle) return { pass: false, reason: `title contains "${excludedTitle}"` }

  if (rules.titleIncludes.length > 0 && !anyMatch(title, rules.titleIncludes)) {
    return { pass: false, reason: 'title matches none of the required keywords' }
  }

  const excludedBody = anyMatch(description, rules.descriptionExcludes)
  if (excludedBody) return { pass: false, reason: `description contains "${excludedBody}"` }

  // A listing-card snippet is not the posting: judging "must mention" keywords
  // against one line of teaser text rejects nearly everything, including roles
  // that mention every keyword in the full description. Defer the check -- the
  // description is backfilled from the live apply page before any question is
  // answered, so nothing is submitted on the basis of the snippet.
  const isThinSnippet = job.descriptionSource === 'snippet' && description.length < 400
  if (!isThinSnippet && rules.descriptionIncludes.length > 0 && !anyMatch(description, rules.descriptionIncludes)) {
    return { pass: false, reason: 'description matches none of the required keywords' }
  }

  const workMode = job.workMode !== 'unknown' ? job.workMode : detectWorkMode(description, job.location, title)
  if (!rules.workModes.includes(workMode)) {
    return { pass: false, reason: `work mode ${workMode} excluded` }
  }

  // Location is only enforced for non-remote roles; a remote job in a city the
  // user did not list is still a remote job.
  if (rules.locations.length > 0 && workMode !== 'remote') {
    if (!anyMatch(job.location || '', rules.locations)) {
      return { pass: false, reason: `location "${job.location}" not in allowed list` }
    }
  }

  // A remote role is usually remote *within somewhere*. Honour that boundary
  // when the user has said where they can work from.
  if (workMode === 'remote' && rules.remoteEligibility.length > 0 && !remoteOpenTo(job.location, rules.remoteEligibility)) {
    return { pass: false, reason: `remote, but restricted to "${job.location}"` }
  }

  const seniority = detectSeniority(title, description)
  if (!rules.seniority.includes(seniority)) {
    return { pass: false, reason: `seniority ${seniority} excluded` }
  }

  if (rules.maxDaysOld > 0 && job.postedAt) {
    const ageDays = (Date.now() - job.postedAt) / 86400000
    if (ageDays > rules.maxDaysOld) {
      return { pass: false, reason: `posted ${Math.round(ageDays)} days ago` }
    }
  }

  // The currency always comes from the posting's own text: a job's stored
  // salaryMin is just a number, and comparing INR against a USD floor (or the
  // reverse) would reject good roles silently.
  const parsed = parseSalary(job.salaryText || job.descriptionText.slice(0, 1500))
  const salaryMin = job.salaryMin ?? parsed.min

  if (rules.requireSalaryPosted && !salaryMin) {
    return { pass: false, reason: 'no compensation posted' }
  }
  if (rules.minSalary !== null && salaryMin) {
    const currencyOk = !parsed.currency || parsed.currency === rules.salaryCurrency
    if (currencyOk && salaryMin < rules.minSalary) {
      return { pass: false, reason: `salary ${salaryMin} below floor ${rules.minSalary}` }
    }
  }

  if (rules.excludeIfSponsorshipUnavailable) {
    const noSponsor =
      /no (visa )?sponsorship|not able to sponsor|unable to sponsor|sponsorship is not available|must be authorized to work without sponsorship/i.test(
        description
      )
    if (noSponsor) return { pass: false, reason: 'posting states sponsorship unavailable' }
  }

  return { pass: true }
}

/** Enrich a scraped job with derived fields before it is stored. */
export function enrichJob(job: Job): Job {
  const workMode =
    job.workMode !== 'unknown'
      ? job.workMode
      : detectWorkMode(job.descriptionText.slice(0, 2000), job.location, job.title)
  const salary = parseSalary(job.salaryText || job.descriptionText.slice(0, 1500))
  return {
    ...job,
    workMode,
    salaryMin: job.salaryMin ?? salary.min,
    salaryMax: job.salaryMax ?? salary.max,
  }
}
