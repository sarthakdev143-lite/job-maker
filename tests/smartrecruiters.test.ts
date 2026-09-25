/**
 * The SmartRecruiters source.
 *
 * Unlike the other three, this one is not a list of company boards: it searches
 * a single public index covering every employer on the platform. Two of its
 * quirks are load-bearing and easy to regress:
 *
 *   - only `keyword` filters. `remote` and `country` are accepted and silently
 *     ignored, so geography has to be enforced downstream;
 *   - every posting states `remote` and `hybrid` outright, which is better
 *     evidence than reading it out of the advert's prose, and is exactly the
 *     inference that made a remote-only search fill up with office jobs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSmartRecruiters, hydrateSmartRecruiters } from '@/discovery/sources/ats-apis'
import { JobSchema, SearchRecipeSchema, type SearchRecipe } from '@/storage/schemas'

function recipe(overrides: Partial<SearchRecipe> = {}): SearchRecipe {
  return SearchRecipeSchema.parse({
    id: 'r1',
    name: 'SmartRecruiters index',
    source: 'smartrecruiters',
    keywords: ['software architect'],
    maxResultsPerRun: 40,
    ...overrides,
  })
}

function posting(name: string, remote: boolean, hybrid = false, city = 'Bengaluru', country = 'in') {
  return {
    id: `id-${name}`,
    name,
    company: { identifier: 'acme', name: 'Acme' },
    releasedDate: '2026-09-19T10:00:00.000Z',
    location: { city, region: 'KA', country, remote, hybrid },
    applyUrl: `https://jobs.smartrecruiters.com/acme/${encodeURIComponent(name)}`,
    shortLocation: `${city}, ${country.toUpperCase()}`,
  }
}

function mockSearch(pages: Array<{ content: unknown[] }>) {
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

describe('fetchSmartRecruiters', () => {
  it('reads the board’s own remote flag rather than guessing', async () => {
    mockSearch([
      {
        content: [
          posting('Software Architect', true),
          posting('Platform Engineer', false, true),
          posting('Office Engineer', false, false),
        ],
      },
    ])

    const jobs = await fetchSmartRecruiters(recipe())

    expect(jobs.map((j) => j.workMode)).toEqual(['remote', 'hybrid', 'onsite'])
    expect(jobs[0].vendor).toBe('smartrecruiters')
    expect(jobs[0].company).toBe('Acme')
  })

  it('keeps the apply URL the index gives, which is the form itself', async () => {
    mockSearch([{ content: [posting('Software Architect', true)] }])
    const [job] = await fetchSmartRecruiters(recipe())
    expect(job.url).toContain('jobs.smartrecruiters.com/acme/')
    expect(job.applyUrl).toBe(job.url)
  })

  it('marks the description as a snippet, since the index carries no advert', async () => {
    mockSearch([{ content: [posting('Software Architect', true)] }])
    const [job] = await fetchSmartRecruiters(recipe())
    expect(job.descriptionSource).toBe('snippet')
    expect(job.descriptionText).toBe('')
  })

  it('never returns the same posting twice across search phrases', async () => {
    mockSearch([{ content: [posting('Software Architect', true)] }])
    const jobs = await fetchSmartRecruiters(
      recipe({ keywords: ['software architect', 'solution architect', 'staff engineer'] })
    )
    expect(jobs).toHaveLength(1)
  })

  it('stops at the requested ceiling', async () => {
    const many = Array.from({ length: 100 }, (_, i) => posting(`Engineer ${i}`, true))
    mockSearch([{ content: many }])
    const jobs = await fetchSmartRecruiters(recipe({ maxResultsPerRun: 25 }))
    expect(jobs.length).toBeLessThanOrEqual(25)
  })

  it('survives a search that fails outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )
    await expect(fetchSmartRecruiters(recipe())).resolves.toEqual([])
  })
})

describe('widening a search that found almost nothing', () => {
  it('retries a long phrase with its first words', async () => {
    const seen: string[] = []
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(decodeURIComponent(new URL(url).searchParams.get('keyword') ?? ''))
        call++
        // The full phrase matches almost nothing; the shorter one matches a lot.
        const content = call === 1 ? [posting('Rare Exact Match', true)] : Array.from({ length: 30 }, (_, i) => posting(`Architect ${i}`, true))
        return { ok: true, status: 200, json: async () => ({ content }), text: async () => '' }
      })
    )

    const jobs = await fetchSmartRecruiters(recipe({ keywords: ['principal solution architect distributed systems'] }))

    expect(seen[0]).toBe('principal solution architect distributed systems')
    expect(seen[1]).toBe('principal solution architect')
    expect(jobs.length).toBeGreaterThan(10)
  })

  it('does not widen when the full phrase already found plenty', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(decodeURIComponent(new URL(url).searchParams.get('keyword') ?? ''))
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: Array.from({ length: 20 }, (_, i) => posting(`Role ${i}`, true)) }),
          text: async () => '',
        }
      })
    )

    await fetchSmartRecruiters(recipe({ keywords: ['principal solution architect distributed systems'] }))

    expect(seen).toEqual(['principal solution architect distributed systems'])
  })
})

describe('locations the index reports badly', () => {
  it('drops the litter a board leaves in a location string', async () => {
    mockSearch([
      {
        content: [
          { ...posting('Solutions Architect', true), shortLocation: 'Anywhere, undefined' },
          { ...posting('Platform Engineer', true), shortLocation: 'Bengaluru, IN' },
        ],
      },
    ])
    const jobs = await fetchSmartRecruiters(recipe())
    expect(jobs[0].location).toBe('Anywhere')
    expect(jobs[1].location).toBe('Bengaluru, IN')
  })
})

describe('hydrateSmartRecruiters', () => {
  it('fills in the advert a card-only index leaves empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          jobAd: {
            sections: {
              companyDescription: { text: '<p>About Acme</p>' },
              jobDescription: { text: '<p>Design <strong>distributed</strong> systems.</p>' },
              qualifications: { text: '<p>Ten years of experience.</p>' },
            },
          },
        }),
        text: async () => '',
      }))
    )

    const job = JobSchema.parse({
      id: 'j1',
      source: 'smartrecruiters',
      url: 'https://jobs.smartrecruiters.com/Acme/744000150512789-software-architect',
      title: 'Software Architect',
      dedupeHash: 'j1',
      discoveredAt: Date.now(),
      descriptionText: '',
      descriptionSource: 'snippet',
    })

    await hydrateSmartRecruiters([job], 10)

    expect(job.descriptionText).toContain('distributed')
    expect(job.descriptionText).toContain('Ten years')
    expect(job.descriptionText).not.toContain('<strong>')
    expect(job.descriptionSource).toBe('hydrated')
  })

  it('leaves a posting that already has its advert alone', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const job = JobSchema.parse({
      id: 'j2',
      source: 'smartrecruiters',
      url: 'https://jobs.smartrecruiters.com/Acme/744000150512789-x',
      title: 'Software Architect',
      dedupeHash: 'j2',
      discoveredAt: Date.now(),
      descriptionText: 'Already here.',
    })

    await hydrateSmartRecruiters([job], 10)

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('carries on when one advert cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('gone')
      })
    )
    const job = JobSchema.parse({
      id: 'j3',
      source: 'smartrecruiters',
      url: 'https://jobs.smartrecruiters.com/Acme/744000150512789-x',
      title: 'Software Architect',
      dedupeHash: 'j3',
      discoveredAt: Date.now(),
      descriptionText: '',
    })

    await expect(hydrateSmartRecruiters([job], 10)).resolves.toBeUndefined()
    expect(job.descriptionText).toBe('')
  })
})

describe('the one filter this index has', () => {
  /**
   * `keyword` is the whole API. Measured against the live index: "software
   * architect" returned 19 Indian postings in a page of 98, two of them remote;
   * "India remote software architect" returned 89 and six. The country belongs
   * in the words because there is nowhere else to put it.
   */
  function capture(): string[] {
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(decodeURIComponent(new URL(url).searchParams.get('keyword') ?? ''))
        return { ok: true, status: 200, json: async () => ({ content: [] }), text: async () => '' }
      })
    )
    return asked
  }

  it('names the country in the search, since the index takes no location', async () => {
    const asked = capture()
    await fetchSmartRecruiters(recipe({ location: 'India', keywords: ['software architect'] }))
    expect(asked[0]).toBe('India software architect')
  })

  it('asks for remote work in words too', async () => {
    const asked = capture()
    await fetchSmartRecruiters(recipe({ location: 'India', remoteOnly: true, keywords: ['staff engineer'] }))
    expect(asked[0]).toBe('India remote staff engineer')
  })

  it('does not repeat a word the phrase already has', async () => {
    const asked = capture()
    await fetchSmartRecruiters(
      recipe({ location: 'India', remoteOnly: true, keywords: ['remote backend engineer India'] })
    )
    expect(asked[0]).toBe('remote backend engineer India')
  })

  it('leaves the phrase alone when the search names no place', async () => {
    const asked = capture()
    await fetchSmartRecruiters(recipe({ keywords: ['software architect'] }))
    expect(asked[0]).toBe('software architect')
  })

  it('keeps qualifying the shorter phrases it falls back to', async () => {
    const asked: string[] = []
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(decodeURIComponent(new URL(url).searchParams.get('keyword') ?? ''))
        call++
        // Thin first result, so the widening path runs.
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: call === 1 ? [posting('One', true)] : [] }),
          text: async () => '',
        }
      })
    )

    await fetchSmartRecruiters(
      recipe({ location: 'India', keywords: ['principal solution architect distributed systems'] })
    )

    expect(asked.length).toBeGreaterThan(1)
    expect(asked.every((a) => a.startsWith('India '))).toBe(true)
  })
})
