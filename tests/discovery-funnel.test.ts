/**
 * The discovery funnel, end to end, over postings shaped like the real ones.
 *
 * Every bug this file guards against was silent. The unit tests were green, the
 * logs said boards had been fetched, and the queue was empty:
 *
 *   - search keywords arrive from the model as whole phrases, and were matched
 *     against titles as literal substrings, so a sweep of sixty-eight verified
 *     boards fetched 2,600 postings and kept none of them;
 *   - work mode was read from the whole description, so any company calling
 *     itself "a distributed team" made its San Francisco roles look remote;
 *   - "remote" was treated as "remote for you", so a queue for an applicant in
 *     India filled with roles open only in the US, Japan and the Netherlands.
 *
 * The postings below are trimmed copies of what Greenhouse, Lever and Ashby
 * actually returned, including the wording that caused each failure.
 */

import { describe, expect, it } from 'vitest'
import { filterByKeywords } from '@/discovery/sources/ats-apis'
import { enrichJob, prefilter } from '@/matching/prefilter'
import { JobSchema, MatchRulesSchema, SearchRecipeSchema, type Job } from '@/storage/schemas'

/** What the model writes when asked for search keywords. */
const MODEL_KEYWORDS = [
  'principal solution architect distributed systems',
  'software architect polyglot microservices',
  'ai genai architect llm platform',
  'staff engineer low latency backend',
]

function posting(title: string, location: string, descriptionText = 'Backend engineering role.'): Job {
  return JobSchema.parse({
    id: `job_${title}_${location}`,
    source: 'greenhouse',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    company: 'acme',
    title,
    location,
    descriptionText,
    dedupeHash: `${title}|${location}`,
    discoveredAt: Date.now(),
  })
}

const recipe = SearchRecipeSchema.parse({
  id: 'r1',
  name: 'Verified greenhouse boards',
  source: 'greenhouse',
  keywords: MODEL_KEYWORDS,
})

/** The rules an India-based architect who will only work remotely ends up with. */
const rules = MatchRulesSchema.parse({
  workModes: ['remote'],
  remoteEligibility: ['India'],
  seniority: ['junior', 'mid', 'senior', 'staff', 'lead', 'unknown'],
})

function survives(job: Job): boolean {
  const kept = filterByKeywords([job], recipe)
  if (kept.length === 0) return false
  return prefilter(enrichJob(kept[0]), rules).pass
}

describe('the discovery funnel', () => {
  it('keeps a remote role in the applicant’s own country', () => {
    expect(survives(posting('Software Architect (L6)', 'Remote - India'))).toBe(true)
    expect(survives(posting('Staff Software Engineer', 'India - Remote'))).toBe(true)
  })

  it('keeps a role open to the whole world', () => {
    expect(survives(posting('Platform Engineer, Edge & Networking', 'Remote, Global'))).toBe(true)
  })

  it('drops a remote role the applicant cannot legally take', () => {
    expect(survives(posting('Staff Software Engineer', 'Remote - US'))).toBe(false)
    expect(survives(posting('Senior Customer Success Engineer', 'Remote, Japan'))).toBe(false)
    expect(survives(posting('Senior Observability Architect', 'Australia (Remote)'))).toBe(false)
  })

  it('drops an office role whose advert boasts about being distributed', () => {
    const anyscale = posting(
      'Staff Software Engineer, Ray Core',
      'San Francisco',
      'We are a distributed team working remote-first across many time zones. Join us in our SF office.'
    )
    expect(survives(anyscale)).toBe(false)
  })

  it('keeps a Bengaluru posting that says the role itself is fully remote', () => {
    const job = posting(
      'Senior Staff Software Engineer, Distributed Filesystem',
      'Bengaluru, India',
      'This is a fully remote position open to candidates across India.'
    )
    expect(survives(job)).toBe(true)
  })

  it('does not let one unmatched phrase discard the whole sweep', () => {
    // Not one of these titles contains any keyword phrase verbatim.
    const titles = [
      'Software Architect (L6)',
      'Staff Software Engineer',
      'Principal Engineer, Duo Agent Platform',
      'Senior Backend Engineer',
    ]
    const jobs = titles.map((t) => posting(t, 'Remote - India'))
    expect(filterByKeywords(jobs, recipe)).toHaveLength(titles.length)
  })

  it('still discards a posting from another profession entirely', () => {
    expect(survives(posting('Registered Nurse, Night Shift', 'Remote - India'))).toBe(false)
    expect(survives(posting('Warehouse Associate', 'Remote - India'))).toBe(false)
  })
})
