/**
 * Keyword matching for discovery.
 *
 * The model writes search keywords as whole phrases -- "principal solution
 * architect distributed systems" -- and the filter used to look for that exact
 * string inside a job title. Nothing matched: a sweep of sixty-eight verified
 * boards fetched several hundred postings and reported zero jobs found, which
 * is indistinguishable from a quiet market.
 */

import { describe, expect, it } from 'vitest'
import { filterByKeywords } from '@/discovery/sources/ats-apis'
import { JobSchema, SearchRecipeSchema, type Job, type SearchRecipe } from '@/storage/schemas'

function job(title: string, location = 'Remote', workMode: Job['workMode'] = 'remote'): Job {
  return JobSchema.parse({
    id: `job_${title}`, source: 'greenhouse', url: 'https://example.com/1', title, location, workMode,
    dedupeHash: title, discoveredAt: Date.now(),
  })
}

function recipe(overrides: Partial<SearchRecipe> = {}): SearchRecipe {
  return SearchRecipeSchema.parse({ id: 'r1', name: 'boards', source: 'greenhouse', ...overrides })
}

describe('filterByKeywords', () => {
  const phrases = [
    'principal solution architect distributed systems',
    'ai genai architect llm platform',
    'staff engineer low latency backend',
  ]

  it('matches a real title against a multi-word keyword phrase', () => {
    const jobs = [job('Staff Software Engineer'), job('Solutions Architect, Platform'), job('Head of Marketing')]
    const kept = filterByKeywords(jobs, recipe({ keywords: phrases })).map((j) => j.title)
    expect(kept).toContain('Staff Software Engineer')
    expect(kept).toContain('Solutions Architect, Platform')
    expect(kept).not.toContain('Head of Marketing')
  })

  it('ignores words that every title has', () => {
    // "staff" and "principal" carry no signal; the distinctive words must.
    const kept = filterByKeywords([job('Staff Accountant')], recipe({ keywords: ['staff engineer backend'] }))
    expect(kept).toHaveLength(0)
  })

  it('still honours remote-only and location', () => {
    const jobs = [job('Backend Engineer', 'San Francisco', 'onsite'), job('Backend Engineer', 'Remote', 'remote')]
    const kept = filterByKeywords(jobs, recipe({ keywords: ['backend engineer'], remoteOnly: true }))
    expect(kept).toHaveLength(1)
    expect(kept[0].workMode).toBe('remote')
  })

  it('passes everything through when no rule is set', () => {
    const jobs = [job('Anything At All')]
    expect(filterByKeywords(jobs, recipe())).toHaveLength(1)
  })
})
