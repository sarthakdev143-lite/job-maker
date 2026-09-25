/**
 * Building searches when the model is not available.
 *
 * A DeepSeek session lapsed overnight and "Build searches from my profile"
 * answered `Not signed in to DeepSeek` and did nothing at all — an error about
 * a chat provider in answer to a question about job boards. The model is an
 * improvement here, not a requirement: the catalogue supplies the boards, and a
 * profile that names a job title already says what to search for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  suggestThrows: '',
  savedRecipes: [] as Array<Record<string, unknown>>,
  boardsChecked: [] as string[],
}

vi.mock('@/matching/suggest', () => ({
  suggestRules: vi.fn(async () => {
    if (state.suggestThrows) throw new Error(state.suggestThrows)
    return {
      titleIncludes: ['architect'],
      titleExcludes: ['account executive'],
      descriptionIncludes: [],
      seniority: [],
      searchKeywords: ['principal solution architect distributed systems'],
      greenhouseBoards: ['acme'],
      leverBoards: [],
      rationale: 'because',
    }
  }),
}))

vi.mock('@/storage/settings', async () => {
  const { MatchRulesSchema } = await vi.importActual<typeof import('@/storage/schemas')>('@/storage/schemas')
  return {
    getSettings: vi.fn(async () => ({
      matchRules: MatchRulesSchema.parse({ workModes: ['remote'], remoteEligibility: [], titleExcludes: [] }),
    })),
    getProfile: vi.fn(async () => ({
      country: 'India',
      currentTitle: 'Software Architect',
      skills: ['Kubernetes', 'Go'],
      experience: [{ title: 'Staff Engineer' }],
    })),
    getRecipes: vi.fn(async () => []),
    saveRecipe: vi.fn(async (r: Record<string, unknown>) => {
      state.savedRecipes.push(r)
    }),
    saveSettings: vi.fn(async () => undefined),
  }
})

vi.mock('@/discovery/board-catalogue', async () => {
  const actual = await vi.importActual<typeof import('@/discovery/board-catalogue')>('@/discovery/board-catalogue')
  return {
    ...actual,
    // The catalogue itself is real; only the network is not.
    validateBoards: vi.fn(async (entries: Array<{ slug: string; source: string }>) => {
      state.boardsChecked = entries.map((e) => e.slug)
      return entries
        .slice(0, 6)
        .map((e) => ({ ...e, live: true, jobCount: 10, matchCount: 2 }))
    }),
  }
})

vi.mock('@/shared/activity', () => ({
  activity: { begin: vi.fn(), relabel: vi.fn(), note: vi.fn(), end: vi.fn() },
}))

const { setUpSearchesFromProfile } = await import('@/discovery/setup')

beforeEach(() => {
  state.suggestThrows = ''
  state.savedRecipes = []
  state.boardsChecked = []
})

describe('when the model cannot be reached', () => {
  it('still builds searches rather than refusing', async () => {
    state.suggestThrows = 'Not signed in to DeepSeek'

    const result = await setUpSearchesFromProfile()

    expect(result.needsManual).toBe(false)
    expect(result.created.length).toBeGreaterThan(0)
  })

  it('searches for the titles the person has actually held', async () => {
    state.suggestThrows = 'Not signed in to DeepSeek'

    await setUpSearchesFromProfile()

    const keywords = (state.savedRecipes.find((r) => r.source === 'workable')?.keywords ?? []) as string[]
    expect(keywords).toContain('software architect')
    expect(keywords).toContain('staff engineer')
    // One skill-qualified variant, so a keyword index has more than one thing
    // to match on.
    expect(keywords.some((k) => k.includes('kubernetes'))).toBe(true)
  })

  it('searches the role as well as the rank, which is where the postings are', async () => {
    state.suggestThrows = 'Not signed in to DeepSeek'

    await setUpSearchesFromProfile()

    const keywords = (state.savedRecipes.find((r) => r.source === 'workable')?.keywords ?? []) as string[]
    // "Staff Engineer" is one title; "engineer" is what most postings say.
    expect(keywords).toContain('engineer')
  })

  it('says so, rather than quietly producing something worse', async () => {
    state.suggestThrows = 'Not signed in to DeepSeek'
    const result = await setUpSearchesFromProfile()
    expect(result.notes.join(' ')).toMatch(/model was unavailable/i)
  })

  it('does not invent company names without the model', async () => {
    state.suggestThrows = 'Not signed in to DeepSeek'
    await setUpSearchesFromProfile()
    // Everything checked came from the shipped catalogue, which is verified.
    const { BOARD_CATALOGUE } = await import('@/discovery/board-catalogue')
    const known = new Set(BOARD_CATALOGUE.map((e) => e.slug))
    expect(state.boardsChecked.every((slug) => known.has(slug))).toBe(true)
  })

  it('leaves nothing behind when the model is working', async () => {
    const result = await setUpSearchesFromProfile()
    expect(result.notes.join(' ')).not.toMatch(/model was unavailable/i)
    expect(state.boardsChecked).toContain('acme')
  })
})
