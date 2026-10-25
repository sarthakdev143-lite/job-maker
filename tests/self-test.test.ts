/**
 * The self-test has to be trustworthy before it is useful.
 *
 * Two ways it could do harm, and both are tested here. It could pass by
 * omission -- a check that throws, or silently skips, reading as a green light
 * when nothing was actually verified. Or its report could leave out the one
 * detail that would have made a failure fixable, which is the whole reason it
 * exists.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { formatSelfTest, runSelfTest, type SelfTestReport } from '@/background/self-test'
import { LlmError } from '@/llm/driver'

const state = {
  allSitesGranted: true,
  alarms: [{ name: 'autoapply:cycle' }, { name: 'autoapply:maintenance' }],
  contentScripts: [
    { matches: ['https://deepai.org/*', 'https://chat.deepseek.com/*'], js: ['assets/chat-bridge.js'] },
    { matches: ['https://boards.greenhouse.io/*'], js: ['assets/form-agent.js'] },
  ] as Array<{ matches: string[]; js: string[] }>,
  modelAnswer: { answer: 'ready', count: 3 } as unknown,
  modelThrows: '',
  halted: false,
  profileOk: true,
  queued: [] as Array<{ url: string; applyUrl: string }>,
  recipes: [{ enabled: true }],
  modelError: null as Error | null,
  recipeHealth: {} as Record<string, { lastRunAt: number | null; lastFetched: number; lastStored: number; lastError: string }>,
}

vi.mock('@/llm/broker', () => ({
  llm: {
    completeStructured: vi.fn(async () => {
      // An Error instance, when the test cares which *kind* of failure it was.
      if (state.modelError) throw state.modelError
      if (state.modelThrows) throw new Error(state.modelThrows)
      return state.modelAnswer
    }),
  },
}))

vi.mock('@/storage/settings', () => ({
  getProfile: vi.fn(async () => ({ firstName: 'Ada', lastName: 'Lovelace' })),
  getRecipes: vi.fn(async () => state.recipes),
  profileIsUsable: vi.fn(() => (state.profileOk ? { ok: true, missing: [] } : { ok: false, missing: ['email'] })),
}))

vi.mock('@/storage/db', () => ({
  jobsRepo: { byStatus: vi.fn(async () => state.queued) },
}))

vi.mock('@/storage/site-memory', () => ({ allSiteMemory: vi.fn(async () => []) }))
vi.mock('@/background/run-history', () => ({ getRecipeHealth: vi.fn(async () => state.recipeHealth) }))
vi.mock('@/background/run-state', () => ({ isHalted: vi.fn(async () => state.halted) }))
vi.mock('@/shared/injection', () => ({
  formAgentFiles: vi.fn(() => state.contentScripts[1]?.js ?? []),
  // Also stubbed because the chat-bridge check calls it. Leaving it out makes
  // the check throw, which the harness records as a failure -- the suite caught
  // exactly that omission when this check was added.
  chatBridgeFiles: vi.fn(() => state.contentScripts[0]?.js ?? []),
}))
vi.mock('@/runner/apply-machine', () => ({ probeJobPage: vi.fn() }))
vi.mock('@/shared/activity', () => ({
  activity: { begin: vi.fn(), relabel: vi.fn(), end: vi.fn() },
}))

function installFakeChrome(): void {
  const store: Record<string, unknown> = {}
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      getManifest: () => ({ version: '0.1.0', version_name: '0.1.0 (build 09-16 16:45)', content_scripts: state.contentScripts }),
    },
    permissions: {
      contains: vi.fn(async () => state.allSitesGranted),
    },
    alarms: { getAll: vi.fn(async () => state.alarms) },
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(store, items)),
        remove: vi.fn(async (key: string) => {
          delete store[key]
        }),
        getBytesInUse: vi.fn(async () => 1024 * 1024),
      },
    },
  }
}

function find(report: SelfTestReport, id: string) {
  return report.checks.find((c) => c.id === id)
}

beforeEach(() => {
  state.allSitesGranted = true
  state.alarms = [{ name: 'autoapply:cycle' }, { name: 'autoapply:maintenance' }]
  state.modelAnswer = { answer: 'ready', count: 3 }
  state.modelThrows = ''
  state.halted = false
  state.profileOk = true
  state.queued = []
  state.recipes = [{ enabled: true }]
  installFakeChrome()
})

describe('a healthy extension', () => {
  it('passes everything and says which build it checked', async () => {
    const report = await runSelfTest()
    expect(report.summary.fail).toBe(0)
    expect(report.build).toContain('build 09-16 16:45')
    // The first thing to read when a fix "did not work" is whether the fix is
    // even loaded, so the build has to be in the report unconditionally.
    expect(find(report, 'build')?.detail).toContain('0.1.0')
  })
})

describe('the failures it is for', () => {
  it('catches a missing site-access grant, and says where to fix it', async () => {
    state.allSitesGranted = false
    const check = find(await runSelfTest(), 'siteAccess')
    expect(check?.status).toBe('warn')
    expect(check?.fix).toMatch(/Site access/i)
  })

  it('catches a missing cycle alarm', async () => {
    state.alarms = [{ name: 'autoapply:maintenance' }]
    expect(find(await runSelfTest(), 'alarms')?.status).toBe('warn')
  })

  it('catches a sticky kill switch, which otherwise looks like doing nothing', async () => {
    state.halted = true
    const check = find(await runSelfTest(), 'halted')
    expect(check?.status).toBe('warn')
    expect(check?.fix).toMatch(/Start/)
  })

  it('catches an unusable profile', async () => {
    state.profileOk = false
    expect(find(await runSelfTest(), 'profile')?.status).toBe('fail')
  })

  it('catches having nothing to do', async () => {
    state.recipes = []
    expect(find(await runSelfTest(), 'searches')?.status).toBe('fail')
  })

  it('catches a model that answers but returns an empty object', async () => {
    // The exact shape of the resume bug: every schema field has a default, so
    // {} validates and yields a perfectly empty result with no error at all.
    state.modelAnswer = { answer: '', count: 0 }
    const check = find(await runSelfTest(), 'modelContract')
    expect(check?.status).toBe('fail')
    expect(check?.detail).toMatch(/empty/i)
  })

  it('catches a model that cannot be reached', async () => {
    state.modelThrows = 'HTTP 410: model has reached end of life'
    const check = find(await runSelfTest(), 'modelContract')
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('410')
  })

  it('catches a build with no page agent in it', async () => {
    state.contentScripts = [{ matches: ['https://deepai.org/*', 'https://chat.deepseek.com/*'], js: ['assets/chat-bridge.js'] }]
    installFakeChrome()
    expect(find(await runSelfTest(), 'contentScript')?.status).toBe('fail')
    state.contentScripts = [
      { matches: ['https://deepai.org/*', 'https://chat.deepseek.com/*'], js: ['assets/chat-bridge.js'] },
      { matches: ['https://boards.greenhouse.io/*'], js: ['assets/form-agent.js'] },
    ]
  })
})

describe('never passing by omission', () => {
  it('reports a check that threw as a failure, not a pass', async () => {
    ;(globalThis as unknown as { chrome: { alarms: unknown } }).chrome.alarms = {
      getAll: vi.fn(async () => {
        throw new Error('alarms API exploded')
      }),
    }
    const report = await runSelfTest()
    // getAll is caught inside the check and degrades to "no alarms", which is
    // still a warning rather than a silent pass. Either way it must not be a
    // pass, because nothing was actually verified.
    expect(find(report, 'alarms')?.status).not.toBe('pass')
  })

  it('counts every check, so a shrinking report is visible in the summary', async () => {
    const report = await runSelfTest()
    const total = report.summary.pass + report.summary.fail + report.summary.warn + report.summary.skip
    expect(total).toBe(report.checks.length)
  })

  it('does not open any page unless asked', async () => {
    const report = await runSelfTest()
    expect(report.probes).toHaveLength(0)
  })
})

describe('formatSelfTest', () => {
  it('writes something complete enough to hand to someone else', async () => {
    state.allSitesGranted = false
    const text = formatSelfTest(await runSelfTest())

    expect(text).toContain('AUTOAPPLY SELF-TEST')
    expect(text).toContain('Build: 0.1.0 (build 09-16 16:45)')
    expect(text).toMatch(/\[WARN\] Chrome lets it read job sites/)
    // A report without the remedy is just a complaint.
    expect(text).toContain('FIX: Settings -> Advanced -> Site access')
  })
})

describe('a search that fetches plenty and keeps none', () => {
  it('is reported as a failure, not as an empty market', async () => {
    state.recipeHealth = {
      r1: { lastRunAt: Date.now(), lastFetched: 2600, lastStored: 0, lastError: '' },
    }
    const report = await runSelfTest({ probePages: false })
    const check = report.checks.find((c) => c.id === 'search-yield')
    expect(check?.status).toBe('fail')
    expect(check?.detail).toMatch(/kept none|filter/i)
  })

  it('passes when the last run kept something', async () => {
    state.recipeHealth = {
      r1: { lastRunAt: Date.now(), lastFetched: 1582, lastStored: 23, lastError: '' },
    }
    const report = await runSelfTest({ probePages: false })
    expect(report.checks.find((c) => c.id === 'search-yield')?.status).toBe('pass')
  })

  it('says nothing when no search has run yet', async () => {
    state.recipeHealth = {}
    const report = await runSelfTest({ probePages: false })
    expect(report.checks.find((c) => c.id === 'search-yield')?.status).toBe('skip')
  })
})

/**
 * The advice has to match the cause.
 *
 * A DeepSeek session lapsed overnight and the self-test said to check the API
 * key and the model id -- neither of which was wrong, and both of which take
 * time to rule out. The failure already carries a code; it just was not read.
 */
async function runWithModelFailure(error: Error): Promise<SelfTestReport> {
  state.modelError = error
  try {
    return await runSelfTest()
  } finally {
    state.modelError = null
  }
}

describe('what the model check tells you to do', () => {
  it('sends you to sign in when the session lapsed', async () => {
    const report = await runWithModelFailure(new LlmError('Not signed in to DeepSeek', 'not_logged_in'))
    const check = report.checks.find((c) => c.id === 'modelContract')
    expect(check?.status).toBe('fail')
    expect(check?.fix).toMatch(/sign in/i)
    expect(check?.fix).not.toMatch(/model id/i)
  })

  it('sends you to the model settings when nothing is configured', async () => {
    const report = await runWithModelFailure(new LlmError('No model configured', 'config'))
    expect(report.checks.find((c) => c.id === 'modelContract')?.fix).toMatch(/Settings -> Model/)
  })

  it('suggests a faster model when the answer never arrived', async () => {
    const report = await runWithModelFailure(new LlmError('timed out', 'timeout'))
    expect(report.checks.find((c) => c.id === 'modelContract')?.fix).toMatch(/faster model/i)
  })

  it('keeps the old advice for a failure it cannot place', async () => {
    const report = await runWithModelFailure(new Error('something else entirely'))
    expect(report.checks.find((c) => c.id === 'modelContract')?.fix).toMatch(/instruction-tuned/)
  })
})
