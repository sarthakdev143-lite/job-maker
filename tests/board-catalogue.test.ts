/**
 * The catalogue is hand-maintained, so it needs the checks a hand-maintained
 * list always needs. Duplicates crept in twice while it was being grown, and a
 * duplicate is not harmless: the same board is fetched twice per sweep and
 * takes a slot away from one that would have been searched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_CATALOGUE, matchCatalogue, validateBoards } from '@/discovery/board-catalogue'

describe('the board catalogue', () => {
  it('lists every board exactly once', () => {
    const seen = new Map<string, number>()
    for (const entry of BOARD_CATALOGUE) seen.set(entry.slug, (seen.get(entry.slug) ?? 0) + 1)
    expect([...seen.entries()].filter(([, n]) => n > 1).map(([slug]) => slug)).toEqual([])
  })

  it('only names sources discovery can actually read', () => {
    for (const entry of BOARD_CATALOGUE) {
      expect(['greenhouse', 'lever', 'ashby']).toContain(entry.source)
    }
  })

  it('gives every board a usable slug', () => {
    for (const entry of BOARD_CATALOGUE) {
      expect(entry.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    }
  })

  it('is large enough to be worth having', () => {
    expect(BOARD_CATALOGUE.length).toBeGreaterThan(80)
  })

  it('never returns more boards than asked for', () => {
    expect(matchCatalogue(['engineer'], { limit: 10 })).toHaveLength(10)
  })
})

/**
 * Boards were chosen by how many jobs they had, which measures company size and
 * nothing else. A remote-only, India-eligible sweep of the forty biggest boards
 * fetched 3,350 postings and kept seven of them, because the biggest boards are
 * the ones with the most offices in California. Every board's listing already
 * says where each posting is, and the listing has already been downloaded to
 * check the board exists, so counting the ones that suit costs nothing.
 */
describe('judging a board by what is on it', () => {
  function boardOf(source: string, locations: unknown[]): unknown {
    if (source === 'lever') return locations.map((l) => ({ categories: { location: l } }))
    return { jobs: locations.map((l) => ({ location: { name: l } })) }
  }

  function serve(payload: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => payload, text: async () => '' }))
    )
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('counts the postings someone in India could take', async () => {
    serve(boardOf('greenhouse', ['San Francisco, CA', 'Remote - India', 'New York', 'Remote, India']))
    const [check] = await validateBoards([{ slug: 'acme', source: 'greenhouse', tags: [] }], {
      country: 'India',
      remoteOnly: true,
    })
    expect(check.jobCount).toBe(4)
    expect(check.matchCount).toBe(2)
  })

  it('counts a globally-remote posting, which an applicant anywhere can take', async () => {
    serve(boardOf('greenhouse', ['Remote - Global', 'Remote (Worldwide)', 'Remote - US']))
    const [check] = await validateBoards([{ slug: 'acme', source: 'greenhouse', tags: [] }], {
      country: 'India',
      remoteOnly: true,
    })
    expect(check.matchCount).toBe(2)
  })

  it('reads Lever’s own shape as well as Greenhouse’s', async () => {
    serve(boardOf('lever', ['Remote - India', 'Berlin']))
    const [check] = await validateBoards([{ slug: 'acme', source: 'lever', tags: [] }], {
      country: 'India',
      remoteOnly: true,
    })
    expect(check.matchCount).toBe(1)
  })

  it('takes Ashby’s remote flag, which is stated rather than written', async () => {
    serve({ jobs: [{ location: 'Bengaluru, India', isRemote: true }, { location: 'Bengaluru, India' }] })
    const [check] = await validateBoards([{ slug: 'acme', source: 'ashby', tags: [] }], {
      country: 'India',
      remoteOnly: true,
    })
    expect(check.matchCount).toBe(1)
  })

  it('puts a small useful board ahead of a huge useless one', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++
        const payload =
          call === 1
            ? boardOf('greenhouse', Array.from({ length: 400 }, () => 'San Francisco, CA'))
            : boardOf('greenhouse', ['Remote - India', 'Remote, India', 'Bengaluru'])
        return { ok: true, status: 200, json: async () => payload, text: async () => '' }
      })
    )

    const checks = await validateBoards(
      [
        { slug: 'huge', source: 'greenhouse', tags: [] },
        { slug: 'small', source: 'greenhouse', tags: [] },
      ],
      { country: 'India', remoteOnly: true },
      1
    )

    expect(checks[0].slug).toBe('small')
  })

  it('falls back to size when nothing was asked for', async () => {
    serve(boardOf('greenhouse', ['San Francisco, CA', 'Remote - India']))
    const [check] = await validateBoards([{ slug: 'acme', source: 'greenhouse', tags: [] }])
    expect(check.matchCount).toBe(0)
    expect(check.live).toBe(true)
  })
})
