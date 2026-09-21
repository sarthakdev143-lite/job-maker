/**
 * "Where are you based?"
 *
 * A live Ashby form asked "What city, state/region, and country are you
 * currently based in?" and the agent answered "Indore". It was true, it was
 * accepted, and it answered a third of the question -- the kind of reply a
 * human reviewer reads as carelessness. A composite key exists so the whole
 * question gets the whole answer, and it has to sit ahead of the plain `city`
 * key without swallowing it.
 */

import { describe, expect, it } from 'vitest'
import { answerCanonical, canonicalKeyFor } from '@/form/canonical'
import { FieldDescriptorSchema, ProfileSchema, type FieldDescriptor } from '@/storage/schemas'

function field(label: string, overrides: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return FieldDescriptorSchema.parse({ selector: '#f', label, kind: 'text', ...overrides })
}

const profile = ProfileSchema.parse({
  firstName: 'Nitish',
  lastName: 'Rathore',
  city: 'Indore',
  state: 'Madhya Pradesh',
  country: 'India',
})

describe('a question asking for the whole location', () => {
  it('answers city, state and country when all three were asked for', () => {
    const f = field('What city, state/region, and country are you currently based in?')
    expect(canonicalKeyFor(f)).toBe('location')
    expect(answerCanonical('location', profile, f)?.value).toBe('Indore, Madhya Pradesh, India')
  })

  it('recognises the phrasings that mean the same thing', () => {
    for (const label of ['Where are you based?', 'Where are you currently located?', 'Current location', 'Location']) {
      expect(canonicalKeyFor(field(label))).toBe('location')
    }
  })

  it('leaves a plain city box alone', () => {
    expect(canonicalKeyFor(field('City'))).toBe('city')
    expect(canonicalKeyFor(field('Town'))).toBe('city')
  })

  it('does not claim a box that only wants the country', () => {
    expect(canonicalKeyFor(field('Country'))).toBe('country')
  })

  it('answers with what it has when the profile is half filled in', () => {
    const sparse = ProfileSchema.parse({ firstName: 'A', city: 'Indore', state: '' })
    const answer = answerCanonical('location', sparse, field('Where are you based?'))
    // `country` is the one part of an address the profile always has.
    expect(answer?.value).toBe('Indore, India')
    // Less certain, because the question asked for more than the profile holds.
    expect(answer?.confidence).toBeLessThan(0.95)
  })

  it('says nothing rather than guessing when no location is known', () => {
    const empty = ProfileSchema.parse({ firstName: 'A', country: '' })
    // An empty canonical answer is no answer, so the field falls through to
    // the bank and then the model rather than being filled with nothing.
    expect(answerCanonical('location', empty, field('Where are you based?'))).toBeNull()
  })
})
