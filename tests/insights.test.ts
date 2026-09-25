/**
 * The three questions you can ask about a queue without changing it.
 *
 * Each exists because something was invisible until it had cost a night:
 * scoring could only be observed by letting applications go out, a pile of
 * rejections said nothing about which rule caused it, and a company-hosted form
 * failed with a connection error that reads like a broken extension rather than
 * a missing permission.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  jobs: [] as Array<Record<string, unknown>>,
  applications: [] as Array<Record<string, unknown>>,
  answers: [] as Array<Record<string, unknown>>,
  granted: [] as string[],
  scores: {} as Record<string, { score: number; shouldApply: boolean; reasons: string[]; concerns: string[] }>,
  scoreThrows: '',
  scoreThrowsCode: '' as '' | 'not_logged_in' | 'timeout',
  updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  minMatchScore: 60,
}

vi.mock('@/storage/db', () => ({
  applicationsRepo: { all: vi.fn(async () => state.applications) },
  answersRepo: { all: vi.fn(async () => state.answers) },
  jobsRepo: {
    byStatus: vi.fn(async (status: string) => state.jobs.filter((j) => j.status === status)),
    all: vi.fn(async () => state.jobs),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      state.updates.push({ id, patch })
      const job = state.jobs.find((j) => j.id === id)
      if (job) Object.assign(job, patch)
    }),
  },
}))

vi.mock('@/storage/settings', () => ({
  getSettings: vi.fn(async () => ({ autonomy: { minMatchScore: state.minMatchScore } })),
  getProfile: vi.fn(async () => ({ firstName: 'Nitish' })),
}))

vi.mock('@/llm/driver', async () => await vi.importActual('@/llm/driver'))

vi.mock('@/matching/scorer', () => ({
  scoreJob: vi.fn(async (job: { id: string; title: string }) => {
    if (state.scoreThrowsCode) {
      const { LlmError } = await import('@/llm/driver')
      throw new LlmError('model unavailable', state.scoreThrowsCode)
    }
    if (state.scoreThrows) throw new Error(state.scoreThrows)
    return state.scores[job.title] ?? { score: 50, shouldApply: false, reasons: ['ok'], concerns: [] }
  }),
}))

vi.mock('@/shared/injection', () => ({
  originPattern: (url: string) => `${new URL(url).protocol}//${new URL(url).hostname}/*`,
  hasHostAccess: vi.fn(async (url: string) => state.granted.some((g) => url.includes(g))),
}))

vi.mock('@/discovery', () => ({
  unscoredJobs: vi.fn(async (limit: number) => state.jobs.filter((j) => j.status === 'new').slice(0, limit)),
}))

vi.mock('@/shared/activity', () => ({
  activity: { begin: vi.fn(), relabel: vi.fn(), end: vi.fn(), note: vi.fn() },
}))

const { accessNeeded, bankCoverage, rejectionSummary, scoreQueue, sourceYield } = await import('@/background/insights')

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `job_${Math.random().toString(36).slice(2)}`,
    title: 'Software Architect',
    company: 'Acme',
    status: 'new',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    applyUrl: '',
    rejectReason: '',
    ...overrides,
  }
}

beforeEach(() => {
  state.jobs = []
  state.applications = []
  state.answers = []
  state.granted = ['boards.greenhouse.io']
  state.scores = {}
  state.scoreThrows = ''
  state.scoreThrowsCode = ''
  state.updates = []
  state.minMatchScore = 60
})

describe('scoreQueue', () => {
  it('queues what clears the bar and rejects the rest, applying to nothing', async () => {
    state.jobs = [job({ title: 'Architect' }), job({ title: 'Barista' })]
    state.scores = {
      Architect: { score: 88, shouldApply: true, reasons: ['title matches'], concerns: [] },
      Barista: { score: 12, shouldApply: false, reasons: [], concerns: ['wrong field'] },
    }

    const result = await scoreQueue(10)

    expect(result.scored).toBe(2)
    expect(result.queued).toBe(1)
    expect(state.updates.find((u) => u.patch.matchScore === 88)?.patch.status).toBe('queued')
    expect(state.updates.find((u) => u.patch.matchScore === 12)?.patch.status).toBe('rejected')
  })

  it('respects the score threshold even when the model says apply', async () => {
    state.minMatchScore = 80
    state.jobs = [job({ title: 'Architect' })]
    state.scores = { Architect: { score: 70, shouldApply: true, reasons: [], concerns: [] } }

    const result = await scoreQueue(10)

    expect(result.queued).toBe(0)
    expect(state.updates[0].patch.status).toBe('rejected')
  })

  it('ranks what it found, best first', async () => {
    state.jobs = [job({ title: 'Low' }), job({ title: 'High' })]
    state.scores = {
      Low: { score: 40, shouldApply: false, reasons: ['meh'], concerns: [] },
      High: { score: 90, shouldApply: true, reasons: ['great'], concerns: [] },
    }

    const result = await scoreQueue(10)

    expect(result.top.map((t) => t.title)).toEqual(['High', 'Low'])
  })

  it('carries on when one posting cannot be scored', async () => {
    state.jobs = [job({ title: 'Architect' })]
    state.scoreThrows = 'model unreachable'

    const result = await scoreQueue(10)

    expect(result.failed).toBe(1)
    expect(result.scored).toBe(0)
    // Left untouched, so the next run can try it again.
    expect(state.updates).toHaveLength(0)
  })

  it('stops at the first failure that will repeat for every posting', async () => {
    state.jobs = [job({ title: 'A' }), job({ title: 'B' }), job({ title: 'C' })]
    state.scoreThrowsCode = 'not_logged_in'

    const result = await scoreQueue(10)

    // One attempt, not three: an expired session is not a fact about the job.
    expect(result.failed).toBe(1)
    expect(result.blockedBy).toMatch(/not signed in/)
    // Nothing was written, so the next run resumes where this one gave up.
    expect(state.updates).toHaveLength(0)
  })

  it('works through the rest when one failure is only about that posting', async () => {
    state.jobs = [job({ title: 'A' }), job({ title: 'B' })]
    state.scoreThrowsCode = 'timeout'

    const result = await scoreQueue(10)

    expect(result.failed).toBe(2)
    expect(result.blockedBy).toBeUndefined()
  })

  it('says nothing when there is nothing to score', async () => {
    const result = await scoreQueue(10)
    expect(result).toEqual({ scored: 0, queued: 0, failed: 0, top: [] })
  })
})

describe('rejectionSummary', () => {
  it('counts reasons rather than listing rejections', async () => {
    state.jobs = [
      job({ status: 'rejected', rejectReason: 'work mode onsite excluded' }),
      job({ status: 'rejected', rejectReason: 'work mode onsite excluded' }),
      job({ status: 'rejected', rejectReason: 'remote, but restricted to "Remote - US"' }),
    ]

    const summary = await rejectionSummary()

    expect(summary.total).toBe(3)
    expect(summary.reasons[0]).toEqual({ reason: 'work mode onsite excluded', count: 2 })
  })

  it('collapses reasons that differ only by the name in them', async () => {
    state.jobs = [
      job({ status: 'rejected', rejectReason: 'remote, but restricted to "Remote - US"' }),
      job({ status: 'rejected', rejectReason: 'remote, but restricted to "Remote, Japan"' }),
      job({ status: 'rejected', rejectReason: 'posted 45 days ago' }),
      job({ status: 'rejected', rejectReason: 'posted 60 days ago' }),
    ]

    const summary = await rejectionSummary()

    expect(summary.reasons).toHaveLength(2)
    expect(summary.reasons.every((r) => r.count === 2)).toBe(true)
  })

  it('does not lose a rejection that recorded no reason', async () => {
    state.jobs = [job({ status: 'rejected', rejectReason: '' })]
    const summary = await rejectionSummary()
    expect(summary.reasons[0].reason).toMatch(/no reason recorded/)
  })
})

describe('accessNeeded', () => {
  it('names the sites standing between the queue and an application', async () => {
    state.jobs = [
      job({ status: 'queued', applyUrl: 'https://databricks.com/careers/job?gh_jid=1', title: 'Forward Deployed Engineer' }),
      job({ status: 'queued', applyUrl: 'https://databricks.com/careers/job?gh_jid=2', title: 'Another' }),
      job({ status: 'queued', applyUrl: 'https://boards.greenhouse.io/acme/jobs/9', title: 'Fine' }),
    ]

    const report = await accessNeeded()

    expect(report.blocked).toBe(2)
    expect(report.origins).toEqual([
      { origin: 'https://databricks.com/*', count: 2, example: 'Forward Deployed Engineer' },
    ])
  })

  it('says nothing when every queued job is reachable', async () => {
    state.jobs = [job({ status: 'queued', applyUrl: 'https://boards.greenhouse.io/acme/jobs/9' })]
    const report = await accessNeeded()
    expect(report).toEqual({ blocked: 0, origins: [] })
  })

  it('ignores a job with no URL at all rather than throwing', async () => {
    state.jobs = [job({ status: 'queued', url: '', applyUrl: '' })]
    await expect(accessNeeded()).resolves.toEqual({ blocked: 0, origins: [] })
  })
})

describe('bankCoverage', () => {
  function filled(source: string, n: number): Array<Record<string, unknown>> {
    return Array.from({ length: n }, (_, i) => ({ source, label: `q${i}`, value: 'v' }))
  }

  it('says what share of the filling cost nothing', async () => {
    state.applications = [
      { fillPlan: [...filled('profile', 6), ...filled('answer_bank', 2), ...filled('llm', 2)] },
    ]

    const report = await bankCoverage()

    expect(report.applications).toBe(1)
    expect(report.fields).toBe(10)
    expect(report.freeShare).toBe(0.8)
  })

  it('counts a guess as paid, since it is what the model tier could not answer', async () => {
    state.applications = [{ fillPlan: [...filled('profile', 3), ...filled('guess', 1)] }]
    const report = await bankCoverage()
    expect(report.freeShare).toBe(0.75)
  })

  it('lists tiers cheapest first, whatever order they were filled in', async () => {
    state.applications = [{ fillPlan: [...filled('llm', 1), ...filled('profile', 1), ...filled('answer_bank', 1)] }]
    const report = await bankCoverage()
    expect(report.bySource.map((r) => r.source)).toEqual(['profile', 'answer_bank', 'llm'])
  })

  it('ignores an application that never reached a form', async () => {
    state.applications = [{ fillPlan: [] }, { fillPlan: filled('profile', 2) }]
    const report = await bankCoverage()
    expect(report.applications).toBe(1)
  })

  it('names the entries a wrong answer would propagate through', async () => {
    state.answers = [
      { label: 'Notice period', value: '30 days', usageCount: 9 },
      { label: 'Why us?', value: '…', usageCount: 0 },
    ]
    const report = await bankCoverage()
    expect(report.entries).toBe(2)
    expect(report.unusedEntries).toBe(1)
    expect(report.topEntries).toEqual([{ label: 'Notice period', value: '30 days', usageCount: 9 }])
  })

  it('reports nothing rather than dividing by zero on a fresh install', async () => {
    const report = await bankCoverage()
    expect(report).toMatchObject({ applications: 0, fields: 0, freeShare: 0, bySource: [] })
  })
})

describe('sourceYield', () => {
  it('ranks sources by what survived, not by what they found', async () => {
    state.jobs = [
      ...Array.from({ length: 200 }, () => job({ source: 'greenhouse', status: 'rejected' })),
      ...Array.from({ length: 6 }, () => job({ source: 'workable', status: 'queued' })),
    ]

    const report = await sourceYield()

    expect(report.total).toBe(206)
    expect(report.sources[0].source).toBe('workable')
    expect(report.sources[0].hitRate).toBe(1)
    expect(report.sources[1].hitRate).toBe(0)
  })

  it('does not punish a source whose postings have not been scored yet', async () => {
    state.jobs = [
      job({ source: 'ashby', status: 'queued' }),
      ...Array.from({ length: 50 }, () => job({ source: 'ashby', status: 'new' })),
    ]

    const report = await sourceYield()

    expect(report.sources[0].unscored).toBe(50)
    expect(report.sources[0].hitRate).toBe(1)
  })

  it('counts a failed attempt as a posting worth finding', async () => {
    state.jobs = [job({ source: 'lever', status: 'failed' }), job({ source: 'lever', status: 'rejected' })]
    const report = await sourceYield()
    expect(report.sources[0]).toMatchObject({ applied: 1, rejected: 1, hitRate: 0.5 })
  })

  it('files a posting with no source rather than dropping it', async () => {
    state.jobs = [job({ source: '', status: 'queued' })]
    const report = await sourceYield()
    expect(report.sources[0].source).toBe('unknown')
  })
})
