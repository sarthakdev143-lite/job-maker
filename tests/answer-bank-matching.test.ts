/**
 * What the answer bank is allowed to reuse.
 *
 * The bank is the difference between an application that costs one model call
 * and one that costs thirteen, so it is tempting to make it match loosely. Each
 * case here is a match that looked plausible under the option-matching
 * similarity the bank used to share, and would have filled a real form with an
 * answer to a different question.
 */

import { describe, expect, it } from 'vitest'
import { questionSimilarity, similarity } from '@/shared/text'
import { FUZZY_THRESHOLD } from '@/storage/answer-bank'

/** The bank fills when this is true, so assert on the decision, not the score. */
function reuses(stored: string, asked: string): boolean {
  return questionSimilarity(asked, stored) >= FUZZY_THRESHOLD
}

describe('questions that mean the same thing', () => {
  it('reuses an answer across a harmless qualifier', () => {
    expect(reuses('First name', 'Legal first name')).toBe(true)
    expect(reuses('Phone number', 'Mobile phone number')).toBe(true)
    expect(reuses('Current company', 'Your current company')).toBe(true)
  })

  it('reuses across spelling and vendor phrasing', () => {
    expect(reuses('Are you legally authorised to work in the US?', 'Are you legally authorized to work in the United States?*')).toBe(true)
  })

  it('still treats an identical question as identical', () => {
    expect(questionSimilarity('Notice period', 'Notice period')).toBe(1)
  })
})

describe('questions that only look the same', () => {
  it('will not answer a longer question with a one-word entry', () => {
    // The bug this was found by: an entry for "Name" filling the box asking
    // for the applicant's most recent employer with the applicant's own name.
    expect(similarity('Name', 'Name of your most recent employer')).toBeGreaterThan(FUZZY_THRESHOLD)
    expect(reuses('Name', 'Name of your most recent employer')).toBe(false)
  })

  it('will not reuse an answer across a negation', () => {
    expect(reuses('Do you require visa sponsorship?', 'Do you not require visa sponsorship?')).toBe(false)
    expect(reuses('Are you able to work from our Pune office?', 'Are you unable to work from our Pune office?')).toBe(false)
  })

  it('will not reuse an answer when the numbers differ', () => {
    expect(reuses('Do you have 5 years of experience with Kubernetes?', 'Do you have 10 years of experience with Kubernetes?')).toBe(false)
  })

  it('keeps a number-bearing question matchable against itself', () => {
    expect(reuses('Do you have 5 years of Kubernetes experience?', 'Do you have 5+ years of Kubernetes experience?')).toBe(true)
  })

  it('does not confuse two countries', () => {
    expect(reuses('Are you authorized to work in the United States?', 'Are you authorized to work in India?')).toBe(false)
  })
})

describe('the option matcher stays generous', () => {
  it('still finds a dial-code option, which the strict rule would reject', () => {
    // Regression: a live Greenhouse form offered "India +91" for the answer
    // "India". The bank got stricter; option matching must not.
    expect(similarity('India', 'India +91')).toBeGreaterThanOrEqual(0.8)
    expect(questionSimilarity('India', 'India +91')).toBeLessThan(FUZZY_THRESHOLD)
  })
})
