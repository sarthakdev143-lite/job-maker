/**
 * The Workable source.
 *
 * Per-company boards were a dead end here: the account API answers for any slug
 * and returns an empty list unless that company still posts through Workable,
 * so a board list cannot be built without already knowing the answer. The
 * aggregate index has no such problem, and is the most generous of the four
 * sources -- every record carries the full advert and states its own work mode,
 * so nothing is inferred and no second trip to the page is needed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWorkable } from '@/discovery/sources/ats-apis'
import { SearchRecipeSchema, type SearchRecipe } from '@/storage/schemas'

function recipe(overrides: Partial<SearchRecipe> = {}): SearchRecipe {
  return SearchRecipeSchema.parse({
    id: 'r1',
    name: 'Workable index',
    source: 'workable',
    keywords: ['software architect'],
    maxResultsPerRun: 40,
    ...overrides,
  })
}

function job(title: string, workplace: string, country = 'India', state = 'published') {
  return {
    id: `id-${title}`,
    title,
    state,
    company: { title: 'Acme' },
    location: { city: 'Indore', countryName: country },
    workplace,
    url: `https://jobs.workable.com/view/${encodeURIComponent(title)}`,
    description: '<p>We are hiring a <strong>backend</strong> engineer.</p>',
    created: '2026-09-19T10:00:00.000Z',
  }
}

function mockPages(pages: Array<{ jobs: unknown[]; nextPageToken?: string }>) {
  let call = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => pages[Math.min(call++, pages.length - 1)],
      text: async () => '',
    }))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchWorkable', () => {
  it('takes the work mode the board states', async () => {
    mockPages([
      { jobs: [job('Software Architect', 'remote'), job('Platform Engineer', 'hybrid'), job('Office Role', 'on_site')] },
    ])

    const jobs = await fetchWorkable(recipe())

    expect(jobs.map((j) => j.workMode)).toEqual(['remote', 'hybrid', 'onsite'])
    expect(jobs[0].vendor).toBe('workable')
    expect(jobs[0].company).toBe('Acme')
    expect(jobs[0].location).toBe('Indore, India')
  })

  it('keeps the full advert, so nothing has to re-read the page', async () => {
    mockPages([{ jobs: [job('Software Architect', 'remote')] }])
    const [j] = await fetchWorkable(recipe())
    expect(j.descriptionSource).toBe('hydrated')
    expect(j.descriptionText).toContain('backend')
    expect(j.descriptionText).not.toContain('<strong>')
  })

  it('follows the page token until it has enough', async () => {
    mockPages([
      { jobs: [job('One', 'remote'), job('Two', 'remote')], nextPageToken: 'next' },
      { jobs: [job('Three', 'remote'), job('Four', 'remote')] },
    ])
    const jobs = await fetchWorkable(recipe({ maxResultsPerRun: 40 }))
    expect(jobs.map((j) => j.title)).toEqual(['One', 'Two', 'Three', 'Four'])
  })

  it('ignores a posting that is not published', async () => {
    mockPages([{ jobs: [job('Draft Role', 'remote', 'India', 'draft'), job('Live Role', 'remote')] }])
    const jobs = await fetchWorkable(recipe())
    expect(jobs.map((j) => j.title)).toEqual(['Live Role'])
  })

  it('never returns the same posting twice across phrases', async () => {
    mockPages([{ jobs: [job('Software Architect', 'remote')] }])
    const jobs = await fetchWorkable(recipe({ keywords: ['software architect', 'solution architect'] }))
    expect(jobs).toHaveLength(1)
  })

  it('survives a search that fails outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )
    await expect(fetchWorkable(recipe())).resolves.toEqual([])
  })
})

describe('the index’s own limits', () => {
  it('never asks for a page larger than the API will serve', async () => {
    // Twenty is the ceiling: twenty-five is answered with 400, not clamped, so
    // a sweep that asked for fifty returned nothing at all.
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(url)
        return { ok: true, status: 200, json: async () => ({ jobs: [] }), text: async () => '' }
      })
    )

    await fetchWorkable(recipe())

    for (const url of asked) {
      const limit = Number(new URL(url).searchParams.get('limit'))
      expect(limit).toBeLessThanOrEqual(20)
    }
  })
})

describe('the filters the index honours', () => {
  /**
   * Collect the URLs a sweep actually asks for. The point of these is that
   * Workable is the one source of the four whose location and work-mode
   * parameters do something -- SmartRecruiters accepts both and ignores both --
   * so dropping them here costs a whole source's worth of usable postings.
   */
  function capture(): string[] {
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(url)
        return { ok: true, status: 200, json: async () => ({ jobs: [] }), text: async () => '' }
      })
    )
    return asked
  }

  it('asks the index for the country instead of filtering afterwards', async () => {
    const asked = capture()
    await fetchWorkable(recipe({ location: 'India' }))
    expect(new URL(asked[0]).searchParams.get('location')).toBe('India')
  })

  it('asks for remote postings only when that is what the search wants', async () => {
    const asked = capture()
    await fetchWorkable(recipe({ location: 'India', remoteOnly: true }))
    expect(new URL(asked[0]).searchParams.get('workplace')).toBe('remote')
  })

  it('leaves both off a search that did not ask for them', async () => {
    const asked = capture()
    await fetchWorkable(recipe())
    const params = new URL(asked[0]).searchParams
    expect(params.get('location')).toBeNull()
    expect(params.get('workplace')).toBeNull()
  })

  it('keeps the filters on every page it follows', async () => {
    const asked: string[] = []
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(url)
        call++
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jobs: [job(`Role ${call}`, 'remote')],
            nextPageToken: call < 2 ? 'next' : undefined,
          }),
          text: async () => '',
        }
      })
    )

    await fetchWorkable(recipe({ location: 'India', remoteOnly: true, maxResultsPerRun: 40 }))

    expect(asked.length).toBeGreaterThan(1)
    for (const url of asked) {
      expect(new URL(url).searchParams.get('location')).toBe('India')
      expect(new URL(url).searchParams.get('workplace')).toBe('remote')
    }
  })
})
