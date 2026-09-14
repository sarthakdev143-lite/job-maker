/**
 * The guess tier exists because a blank mandatory question is a rejected
 * application, not a cautious one. These tests pin down both halves of that
 * bargain: it answers what it can, and it refuses the questions where a wrong
 * answer costs the user the role rather than just the application.
 */

import { describe, expect, it } from 'vitest'
import { guessAnswer } from '@/form/guess'
import { FieldDescriptorSchema, JobSchema, ProfileSchema, type FieldDescriptor } from '@/storage/schemas'

const profile = ProfileSchema.parse({
  firstName: 'Sarthak',
  lastName: 'K',
  email: 's@example.com',
  city: 'Indore',
  state: 'Madhya Pradesh',
  country: 'India',
  yearsExperience: 4,
  headline: 'Full-stack engineer',
  workAuthorization: { noticePeriodDays: 30 },
  compensation: { expectedCtc: 'INR 20 LPA' },
})

const job = JobSchema.parse({
  id: 'j1',
  source: 'naukri',
  url: 'https://www.naukri.com/job-listings-1',
  company: 'Acme',
  title: 'Engineer',
  location: 'Bengaluru',
  dedupeHash: 'abc',
  discoveredAt: Date.now(),
})

function field(overrides: Partial<FieldDescriptor>): FieldDescriptor {
  return FieldDescriptorSchema.parse({ selector: '#x', kind: 'text', required: true, ...overrides })
}

describe('guessAnswer', () => {
  it('picks the profile city out of a list of cities', () => {
    const guess = guessAnswer(
      field({
        label: 'Which city do you prefer to work in?',
        kind: 'select',
        options: [
          { value: '', label: 'Select' },
          { value: 'blr', label: 'Bengaluru' },
          { value: 'ind', label: 'Indore' },
          { value: 'pun', label: 'Pune' },
        ],
      }),
      profile,
      job
    )
    expect(guess?.value).toBe('Indore')
  })

  it('falls back to remote when no listed city matches', () => {
    const guess = guessAnswer(
      field({
        label: 'Preferred location',
        kind: 'select',
        options: [
          { value: 'nyc', label: 'New York' },
          { value: 'rem', label: 'Remote' },
        ],
      }),
      profile,
      job
    )
    expect(guess?.value).toBe('Remote')
  })

  it('never leaves a mandatory choice blank, even with nothing matching', () => {
    const guess = guessAnswer(
      field({
        label: 'Which of our product lines interests you?',
        kind: 'select',
        options: [
          { value: '', label: 'Please select' },
          { value: 'a', label: 'Payments' },
          { value: 'b', label: 'Lending' },
        ],
      }),
      profile,
      job
    )
    expect(guess?.value).toBe('Payments')
    expect(guess?.confidence).toBeLessThan(0.5)
  })

  it('prefers a neutral option where one exists', () => {
    const guess = guessAnswer(
      field({
        label: 'Gender',
        kind: 'select',
        options: [
          { value: 'm', label: 'Male' },
          { value: 'f', label: 'Female' },
          { value: 'x', label: 'Prefer not to say' },
        ],
      }),
      profile,
      job
    )
    expect(guess?.value).toBe('Prefer not to say')
  })

  it('lands a notice period inside the right band', () => {
    const guess = guessAnswer(
      field({
        label: 'What is your notice period?',
        kind: 'select',
        options: [
          { value: '1', label: 'Immediate' },
          { value: '2', label: '15-30 days' },
          { value: '3', label: '60-90 days' },
        ],
      }),
      profile,
      job
    )
    expect(guess?.value).toBe('15-30 days')
  })

  it('answers a free-text city question from the profile', () => {
    const guess = guessAnswer(field({ label: 'Current city', kind: 'text' }), profile, job)
    expect(guess?.value).toBe('Indore')
  })

  it('agrees to a willingness question', () => {
    const guess = guessAnswer(
      field({
        label: 'Are you willing to relocate?',
        kind: 'radio',
        options: [
          { value: 'y', label: 'Yes' },
          { value: 'n', label: 'No' },
        ],
      }),
      profile,
      job
    )
    expect(guess?.value).toBe('Yes')
  })

  it('refuses to guess at work authorization', () => {
    expect(
      guessAnswer(
        field({
          label: 'Will you now or in the future require sponsorship for employment visa status?',
          kind: 'radio',
          options: [
            { value: 'y', label: 'Yes' },
            { value: 'n', label: 'No' },
          ],
        }),
        profile,
        job
      )
    ).toBeNull()
  })

  it('refuses to guess at a licence number', () => {
    expect(guessAnswer(field({ label: 'Professional licence number', kind: 'text' }), profile, job)).toBeNull()
  })

  it('gives back nothing for an identifier it cannot know', () => {
    expect(guessAnswer(field({ label: 'Employee referral code', kind: 'text' }), profile, job)).toBeNull()
  })
})
