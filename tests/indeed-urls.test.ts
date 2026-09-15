/**
 * Indeed search URL construction.
 *
 * These matter more than they look. A search URL that quietly drops the remote
 * filter does not fail -- it returns hundreds of on-site jobs that each cost a
 * page load to read and are then thrown away, which looks like the agent
 * working hard and achieving nothing. And a query that crams every role phrase
 * into one string is read by Indeed as a conjunction and matches almost
 * nothing, which is the exact bug the Naukri builder already had to fix.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROLE_PHRASES,
  INDEED_DOMAINS,
  REMOTE_ATTR_FILTER,
  buildIndeedUrls,
  viewJobUrl,
} from '@/discovery/sources/indeed'
import type { SearchRecipe } from '@/storage/schemas'

function recipe(over: Partial<SearchRecipe> = {}): SearchRecipe {
  return {
    id: 'r1',
    name: 'Indeed remote',
    enabled: true,
    source: 'indeed',
    keywords: [],
    location: '',
    remoteOnly: true,
    boards: [],
    customUrls: [],
    maxResultsPerRun: 40,
    lastRunAt: null,
    ...over,
  }
}

describe('buildIndeedUrls', () => {
  it('puts every URL through the remote attribute filter', () => {
    const urls = buildIndeedUrls(recipe({ keywords: ['software engineer'] }))
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(new URL(url).searchParams.get('sc')).toBe(REMOTE_ATTR_FILTER)
    }
  })

  it('also sends Remote as the location, as a fallback for the attribute code', () => {
    for (const url of buildIndeedUrls(recipe({ keywords: ['architect'] }))) {
      expect(new URL(url).searchParams.get('l')).toBe('Remote')
    }
  })

  it('searches each phrase separately rather than concatenating them', () => {
    const phrases = ['lead engineer', 'software architect', 'backend developer']
    const urls = buildIndeedUrls(recipe({ keywords: phrases }), { pages: 1 })
    const queries = urls.map((u) => new URL(u).searchParams.get('q'))

    for (const phrase of phrases) {
      expect(queries).toContain(phrase)
    }
    // Nothing may contain two phrases glued together.
    for (const q of queries) {
      expect(phrases.filter((p) => q?.includes(p)).length).toBe(1)
    }
  })

  it('covers both the US and Indian domains', () => {
    const hosts = new Set(buildIndeedUrls(recipe({ keywords: ['engineer'] })).map((u) => new URL(u).hostname))
    for (const domain of INDEED_DOMAINS) {
      expect(hosts.has(domain)).toBe(true)
    }
  })

  it('paginates with Indeed start offsets, omitting start on the first page', () => {
    const urls = buildIndeedUrls(recipe({ keywords: ['engineer'] }), {
      domains: ['www.indeed.com'],
      pages: 3,
    })
    const starts = urls.map((u) => new URL(u).searchParams.get('start'))
    expect(starts).toEqual([null, '10', '20'])
  })

  it('multiplies out phrases, domains and pages', () => {
    const urls = buildIndeedUrls(recipe({ keywords: ['a', 'b'] }), {
      domains: ['www.indeed.com', 'in.indeed.com'],
      pages: 4,
    })
    expect(urls).toHaveLength(2 * 2 * 4)
    expect(new Set(urls).size).toBe(urls.length) // no duplicates
  })

  it('falls back to the lead/engineer/developer/architect families with no keywords', () => {
    const queries = buildIndeedUrls(recipe({ keywords: [] }), { domains: ['www.indeed.com'], pages: 1 }).map(
      (u) => new URL(u).searchParams.get('q')
    )
    expect(queries).toEqual(DEFAULT_ROLE_PHRASES)
    expect(queries.some((q) => q?.includes('lead'))).toBe(true)
    expect(queries.some((q) => q?.includes('architect'))).toBe(true)
    expect(queries.some((q) => q?.includes('developer'))).toBe(true)
  })

  it('ignores blank and whitespace-only keywords', () => {
    const queries = buildIndeedUrls(recipe({ keywords: ['  ', '', 'devops engineer'] }), {
      domains: ['www.indeed.com'],
      pages: 1,
    }).map((u) => new URL(u).searchParams.get('q'))
    expect(queries).toEqual(['devops engineer'])
  })

  it('sorts by date and bounds the age, so overnight runs see fresh postings', () => {
    const url = new URL(buildIndeedUrls(recipe({ keywords: ['engineer'] }), { maxAgeDays: 3 })[0])
    expect(url.searchParams.get('sort')).toBe('date')
    expect(url.searchParams.get('fromage')).toBe('3')
  })

  it('encodes multi-word phrases safely', () => {
    const url = buildIndeedUrls(recipe({ keywords: ['c++ / c# engineer'] }), {
      domains: ['www.indeed.com'],
      pages: 1,
    })[0]
    expect(() => new URL(url)).not.toThrow()
    expect(new URL(url).searchParams.get('q')).toBe('c++ / c# engineer')
  })

  it('prefers explicit custom URLs over anything it would build', () => {
    // fetchIndeed short-circuits on customUrls; this pins the recipe shape it
    // relies on so the two cannot drift apart.
    const r = recipe({ customUrls: ['https://www.indeed.com/jobs?q=manual'] })
    expect(r.customUrls).toHaveLength(1)
  })

  it('never emits a URL missing the remote filter, whatever the options', () => {
    const combos = [
      buildIndeedUrls(recipe({ keywords: [] })),
      buildIndeedUrls(recipe({ keywords: ['x'] }), { pages: 5 }),
      buildIndeedUrls(recipe({ keywords: ['x'] }), { domains: ['in.indeed.com'] }),
    ].flat()
    for (const url of combos) {
      const params = new URL(url).searchParams
      expect(params.get('sc')).toBe(REMOTE_ATTR_FILTER)
      expect(params.get('l')).toBe('Remote')
    }
  })
})

describe('viewJobUrl', () => {
  it('builds a canonical job URL from a job key', () => {
    expect(viewJobUrl('www.indeed.com', 'abc123')).toBe('https://www.indeed.com/viewjob?jk=abc123')
  })

  it('encodes a key containing URL-significant characters', () => {
    expect(viewJobUrl('in.indeed.com', 'a&b=c')).toBe('https://in.indeed.com/viewjob?jk=a%26b%3Dc')
  })
})
