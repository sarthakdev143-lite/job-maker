/**
 * One employer must not take the whole sweep.
 *
 * A remote-India search of the Workable index stored forty postings, of which
 * twenty-three came from a single job-board aggregator reposting other
 * companies' vacancies. Nothing was wrong with any of them individually, which
 * is why no filter caught it; the problem was the proportion. The cap runs
 * after the prefilter and before storage, so the rules still decide what is
 * eligible and this only decides how much of one employer to take at a time.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JobSchema, type Job } from '@/storage/schemas'

const state = {
  fetched: [] as Job[],
  stored: [] as Job[],
  rejected: [] as Array<{ title: string; company: string; reason: string }>,
}

vi.mock('@/discovery/sources/ats-apis', () => ({
  fetchGreenhouse: vi.fn(async () => state.fetched),
  fetchLever: vi.fn(async () => state.fetched),
  fetchAshby: vi.fn(async () => state.fetched),
  fetchSmartRecruiters: vi.fn(async () => state.fetched),
  fetchWorkable: vi.fn(async () => state.fetched),
  hydrateSmartRecruiters: vi.fn(async () => undefined),
  filterByKeywords: (jobs: Job[]) => jobs,
}))
vi.mock('@/discovery/sources/scraped-boards', () => ({
  fetchNaukri: vi.fn(async () => []),
  hydrateDescriptions: vi.fn(async () => undefined),
}))
vi.mock('@/discovery/sources/indeed', () => ({
  fetchIndeed: vi.fn(async () => []),
  hydrateIndeedJobs: vi.fn(async () => undefined),
}))

vi.mock('@/storage/db', () => ({
  jobsRepo: {
    exists: vi.fn(async () => false),
    put: vi.fn(async (job: Job) => {
      if (job.status === 'rejected') {
        state.rejected.push({ title: job.title, company: job.company, reason: job.rejectReason })
      } else {
        state.stored.push(job)
      }
    }),
  },
}))

vi.mock('@/storage/settings', async () => {
  // Parsed from the schema rather than hand-written: the prefilter reads fields
  // a partial object silently lacks, and the whole run then fails as "blocked".
  const { MatchRulesSchema } = await vi.importActual<typeof import('@/storage/schemas')>('@/storage/schemas')
  return {
  getSettings: vi.fn(async () => ({
    matchRules: MatchRulesSchema.parse({
      workModes: ['remote'],
      seniority: ['junior', 'mid', 'senior', 'staff', 'lead', 'unknown'],
    }),
    autonomy: { volumeMode: true },
  })),
  getProfile: vi.fn(async () => ({ currentTitle: 'Senior Software Engineer', experience: [] })),
  getRecipes: vi.fn(async () => [
    { id: 'r1', name: 'Workable index', enabled: true, source: 'workable', keywords: [], maxResultsPerRun: 100 },
  ]),
  saveRecipe: vi.fn(async () => undefined),
  }
})

vi.mock('@/background/run-history', () => ({ recordRecipeHealth: vi.fn(async () => undefined) }))
vi.mock('@/shared/activity', () => ({ activity: { relabel: vi.fn(), note: vi.fn(), begin: vi.fn(), end: vi.fn() } }))
vi.mock('@/matching/prefilter', async () => {
  const actual = await vi.importActual<typeof import('@/matching/prefilter')>('@/matching/prefilter')
  // Rules are empty above, so the real prefilter passes everything; keeping it
  // real means the cap is genuinely tested after it, not instead of it.
  return actual
})

const { runDiscovery } = await import('@/discovery')

function posting(company: string, title: string): Job {
  return JobSchema.parse({
    id: `job_${company}_${title}`,
    source: 'workable',
    url: `https://jobs.workable.com/view/${encodeURIComponent(company + title)}`,
    company,
    title,
    location: 'India',
    workMode: 'remote',
    descriptionText: 'A long enough description to be judged on its own merits, several sentences of it.',
    dedupeHash: `${company}|${title}`,
    discoveredAt: Date.now(),
  })
}

beforeEach(() => {
  state.fetched = []
  state.stored = []
  state.rejected = []
})

describe('an employer flooding one run', () => {
  it('takes only the first few from an aggregator', async () => {
    state.fetched = Array.from({ length: 23 }, (_, i) => posting('Weekday AI', `Role ${i}`))

    const result = await runDiscovery()

    expect(result.stored).toBe(5)
    expect(state.rejected).toHaveLength(18)
    expect(state.rejected[0].reason).toContain('Weekday AI')
  })

  it('lets the employers behind it through', async () => {
    state.fetched = [
      ...Array.from({ length: 23 }, (_, i) => posting('Weekday AI', `Role ${i}`)),
      posting('Mrsool', 'SDE III Backend Engineer'),
      posting('Sur', 'Staff Software Engineer'),
      posting('Velsera', 'Technical Lead, Engineering'),
    ]

    await runDiscovery()

    expect(state.stored.map((j) => j.company)).toContain('Mrsool')
    expect(state.stored.map((j) => j.company)).toContain('Sur')
    expect(state.stored.map((j) => j.company)).toContain('Velsera')
  })

  it('does not touch an employer posting a normal number of roles', async () => {
    state.fetched = Array.from({ length: 4 }, (_, i) => posting('Mrsool', `Engineer ${i}`))
    const result = await runDiscovery()
    expect(result.stored).toBe(4)
    expect(state.rejected).toHaveLength(0)
  })

  it('records why it stopped, so the count is not mistaken for a rule', async () => {
    state.fetched = Array.from({ length: 8 }, (_, i) => posting('Weekday AI', `Role ${i}`))
    await runDiscovery()
    expect(state.rejected.every((r) => /already taken this run/.test(r.reason))).toBe(true)
  })

  it('does not group postings that merely have no company name', async () => {
    state.fetched = Array.from({ length: 9 }, (_, i) =>
      JobSchema.parse({ ...posting('', `Role ${i}`), company: '' })
    )
    const result = await runDiscovery()
    expect(result.stored).toBe(9)
  })
})

describe('the same role listed once per city', () => {
  it('keeps one and records why the others went', async () => {
    // Jitterbit advertised one remote SDET role five times, once per office.
    state.fetched = ['Chennai', 'Mumbai', 'Pune', 'Bengaluru', 'Delhi'].map((city) =>
      JobSchema.parse({
        ...posting('Jitterbit', 'SDET - QA Automation(Remote)'),
        id: `job_${city}`,
        location: `${city}, India`,
        dedupeHash: `jitterbit|${city}`,
      })
    )

    const result = await runDiscovery()

    expect(result.stored).toBe(1)
    expect(state.rejected).toHaveLength(4)
    expect(state.rejected[0].reason).toMatch(/same role/)
  })

  it('does not collapse two genuinely different roles at one employer', async () => {
    state.fetched = [
      posting('Mrsool', 'SDE III Backend Engineer'),
      posting('Mrsool', 'Site Reliability Engineer II'),
      posting('Mrsool', 'Data Engineer II'),
    ]
    const result = await runDiscovery()
    expect(result.stored).toBe(3)
  })
})
