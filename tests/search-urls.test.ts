/**
 * Regression test for the search that found nothing useful.
 *
 * Every suggested keyword was joined into a single Naukri slug, producing
 * ".../principal-software-architect-distributed-systems-solution-architect-
 * microservices-kubernetes-genai-architect-llm-staff-engineer-polyglot-backend-
 * jobs-in-indore" -- one query so specific it matched almost nothing, which
 * then read as "the agent applies to no jobs".
 */

import { describe, expect, it } from 'vitest'
import { buildNaukriUrls } from '@/discovery/sources/scraped-boards'
import { SearchRecipeSchema, type SearchRecipe } from '@/storage/schemas'
import { matchCatalogue } from '@/discovery/board-catalogue'

function recipe(overrides: Record<string, unknown> = {}): SearchRecipe {
  return SearchRecipeSchema.parse({ id: 'r1', source: 'naukri', ...overrides })
}

describe('buildNaukriUrls', () => {
  it('builds one search per phrase instead of one containing all of them', () => {
    const urls = buildNaukriUrls(
      recipe({ keywords: ['software architect', 'staff engineer', 'backend engineer'], location: 'Indore' })
    )
    expect(urls).toEqual([
      'https://www.naukri.com/software-architect-jobs-in-indore',
      'https://www.naukri.com/staff-engineer-jobs-in-indore',
      'https://www.naukri.com/backend-engineer-jobs-in-indore',
    ])
  })

  it('caps how many searches one recipe fans out into', () => {
    const urls = buildNaukriUrls(recipe({ keywords: ['a role', 'b role', 'c role', 'd role', 'e role'] }))
    expect(urls).toHaveLength(3)
  })

  it('never produces the unbounded slug that caused this', () => {
    const urls = buildNaukriUrls(
      recipe({
        keywords: [
          'principal software architect distributed systems solution architect microservices kubernetes genai architect llm staff engineer polyglot backend',
        ],
        location: 'Indore',
      })
    )
    const slug = urls[0]!.split('/').pop()!
    expect(slug.length).toBeLessThan(90)
  })

  it('drops punctuation that would break the path', () => {
    const urls = buildNaukriUrls(recipe({ keywords: ['C++ / Go engineer'] }))
    expect(urls[0]).toBe('https://www.naukri.com/c-go-engineer-jobs')
  })

  it('falls back to a sane default when no keywords are set', () => {
    expect(buildNaukriUrls(recipe())).toEqual(['https://www.naukri.com/software-engineer-jobs'])
  })

  it('omits the location segment when none is given', () => {
    expect(buildNaukriUrls(recipe({ keywords: ['data engineer'] }))).toEqual([
      'https://www.naukri.com/data-engineer-jobs',
    ])
  })
})

describe('board selection for a remote-only search', () => {
  it('puts remote-friendly boards ahead of subject-matter matches', () => {
    const picked = matchCatalogue(['ai', 'machine learning', 'python'], { remoteOnly: true, limit: 12 })
    const remoteFriendly = picked.filter((b) => b.tags.includes('remote-friendly')).length
    expect(remoteFriendly).toBeGreaterThan(3)
  })

  it('still ranks by subject matter when any work mode is acceptable', () => {
    const anywhere = matchCatalogue(['ai', 'machine learning'], { limit: 12 })
    const aiBoards = anywhere.filter((b) => b.tags.includes('ai')).length
    expect(aiBoards).toBeGreaterThan(3)
  })

  it('keeps India boards in play for a remote-only search', () => {
    const picked = matchCatalogue(['backend', 'architect'], { india: true, remoteOnly: true, limit: 20 })
    expect(picked.some((b) => b.tags.includes('india'))).toBe(true)
  })
})
