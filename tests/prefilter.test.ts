import { describe, expect, it } from 'vitest'
import { enrichJob, prefilter } from '@/matching/prefilter'
import { JobSchema, MatchRulesSchema, type Job, type MatchRules } from '@/storage/schemas'
import { dedupeHash } from '@/discovery/sources/ats-apis'

function job(overrides: Partial<Job> = {}): Job {
  return JobSchema.parse({
    id: 'job_1',
    source: 'greenhouse',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    company: 'Acme',
    title: 'Senior Software Engineer',
    location: 'Bengaluru, India',
    descriptionText: 'We are hiring a senior backend engineer. 6 years of experience with Go and Postgres.',
    dedupeHash: 'abc',
    discoveredAt: Date.now(),
    postedAt: Date.now() - 86400000,
    ...overrides,
  })
}

function rules(overrides: Partial<MatchRules> = {}): MatchRules {
  return MatchRulesSchema.parse(overrides)
}

describe('prefilter', () => {
  it('passes a job that breaks no rule', () => {
    expect(prefilter(job(), rules()).pass).toBe(true)
  })

  it('rejects a blocklisted company regardless of anything else', () => {
    const verdict = prefilter(job(), rules({ companyBlocklist: ['acme'] }))
    expect(verdict.pass).toBe(false)
    expect(verdict.pass === false && verdict.reason).toMatch(/blocklisted/)
  })

  it('treats an allowlist as exclusive', () => {
    expect(prefilter(job(), rules({ companyAllowlist: ['other corp'] })).pass).toBe(false)
    expect(prefilter(job(), rules({ companyAllowlist: ['acme'] })).pass).toBe(true)
  })

  it('applies title includes and excludes', () => {
    expect(prefilter(job(), rules({ titleExcludes: ['senior'] })).pass).toBe(false)
    expect(prefilter(job(), rules({ titleIncludes: ['designer'] })).pass).toBe(false)
    expect(prefilter(job(), rules({ titleIncludes: ['engineer'] })).pass).toBe(true)
  })

  it('filters on description content', () => {
    expect(prefilter(job(), rules({ descriptionExcludes: ['postgres'] })).pass).toBe(false)
    expect(prefilter(job(), rules({ descriptionIncludes: ['kubernetes'] })).pass).toBe(false)
  })

  it('defers must-mention keywords when only a card snippet is available', () => {
    // Volume mode skips hydration, so the description is a one-line teaser.
    // Judging required keywords against it would reject nearly everything;
    // the check runs once the real description is backfilled at apply time.
    const snippet = job({ descriptionText: 'Exciting fintech role, apply now', descriptionSource: 'snippet' })
    expect(prefilter(snippet, rules({ descriptionIncludes: ['kubernetes'] })).pass).toBe(true)
    const hydrated = job({
      descriptionText: 'Exciting fintech role, apply now',
      descriptionSource: 'hydrated',
    })
    expect(prefilter(hydrated, rules({ descriptionIncludes: ['kubernetes'] })).pass).toBe(false)
  })

  it('rejects an excluded work mode', () => {
    const remote = enrichJob(job({ title: 'Remote Senior Engineer', descriptionText: 'Fully remote role' }))
    expect(prefilter(remote, rules({ workModes: ['onsite'] })).pass).toBe(false)
    expect(prefilter(remote, rules({ workModes: ['remote'] })).pass).toBe(true)
  })

  it('ignores the location list for remote roles', () => {
    const remote = enrichJob(job({ location: 'Anywhere', descriptionText: 'Fully remote, work from home' }))
    expect(prefilter(remote, rules({ locations: ['Bengaluru'] })).pass).toBe(true)
  })

  it('enforces the location list for onsite roles', () => {
    const onsite = enrichJob(job({ location: 'Austin, TX', descriptionText: 'On-site role in Austin' }))
    expect(prefilter(onsite, rules({ locations: ['Bengaluru'] })).pass).toBe(false)
  })

  it('rejects a seniority the user excluded', () => {
    expect(prefilter(job(), rules({ seniority: ['junior', 'mid'] })).pass).toBe(false)
  })

  it('rejects a stale posting', () => {
    const old = job({ postedAt: Date.now() - 90 * 86400000 })
    const verdict = prefilter(old, rules({ maxDaysOld: 30 }))
    expect(verdict.pass).toBe(false)
    expect(verdict.pass === false && verdict.reason).toMatch(/days ago/)
  })

  it('enforces a salary floor only when the currencies agree', () => {
    const inr = enrichJob(job({ salaryText: 'INR 12 LPA' }))
    expect(prefilter(inr, rules({ minSalary: 2000000, salaryCurrency: 'INR' })).pass).toBe(false)
    // A USD posting is not compared against an INR floor, because converting is guesswork.
    const usd = enrichJob(job({ salaryText: '$150k' }))
    expect(prefilter(usd, rules({ minSalary: 2000000, salaryCurrency: 'INR' })).pass).toBe(true)
  })

  it('can require that compensation is posted at all', () => {
    expect(prefilter(job(), rules({ requireSalaryPosted: true })).pass).toBe(false)
  })

  it('spots a posting that rules out sponsorship', () => {
    const noSponsor = job({ descriptionText: 'We are unable to sponsor visas for this role.' })
    const verdict = prefilter(noSponsor, rules({ excludeIfSponsorshipUnavailable: true }))
    expect(verdict.pass).toBe(false)
    expect(verdict.pass === false && verdict.reason).toMatch(/sponsorship/)
  })
})

describe('dedupeHash', () => {
  it('collapses the same role listed on two boards', () => {
    expect(dedupeHash('Acme Inc', 'Senior Engineer', 'Bengaluru, India')).toBe(
      dedupeHash('acme  inc', 'senior engineer', 'Bengaluru India')
    )
  })

  it('separates different roles at the same company', () => {
    expect(dedupeHash('Acme', 'Senior Engineer', 'Remote')).not.toBe(dedupeHash('Acme', 'Staff Engineer', 'Remote'))
  })
})

describe('enrichJob', () => {
  it('derives work mode and salary from the text', () => {
    const enriched = enrichJob(job({ salaryText: '$140k - $180k', descriptionText: 'This is a fully remote position.' }))
    expect(enriched.workMode).toBe('remote')
    expect(enriched.salaryMin).toBe(140000)
    expect(enriched.salaryMax).toBe(180000)
  })
})
