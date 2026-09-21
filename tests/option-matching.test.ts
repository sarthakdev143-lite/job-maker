/**
 * Picking the right option out of a list.
 *
 * Both cases here were produced by a live Twilio form, and both only became
 * reachable once dropdowns started reporting their options at all — before
 * that most of these lists looked empty and the answer was passed through
 * untouched.
 *
 *   - "India" was answered with "British Indian Ocean Territory", because it
 *     was the first option in the country list *containing* that text. A real
 *     place, three thousand kilometres away, on a real application.
 *   - "Voluntary Self-Identification of Gender" was answered "Male", because
 *     nothing matched and the last resort picks the first option rather than
 *     leave a required question blank. Inventing someone's gender is not a
 *     cautious answer.
 */

import { describe, expect, it } from 'vitest'
import { bestOption } from '@/form/canonical'
import { guessAnswer } from '@/form/guess'
import { FieldDescriptorSchema, ProfileSchema, type FieldDescriptor } from '@/storage/schemas'

const COUNTRIES = [
  'Bolivia',
  'British Indian Ocean Territory',
  'India',
  'Indonesia',
  'United States',
]

function opts(labels: string[]): Array<{ value: string; label: string }> {
  return labels.map((label) => ({ value: label, label }))
}

describe('choosing a country', () => {
  it('takes the country, not the one that merely contains its name', () => {
    expect(bestOption(opts(COUNTRIES), 'India')).toBe('India')
  })

  it('still finds the entry that carries a dial code', () => {
    expect(bestOption(opts(['India +91', 'Indonesia +62']), 'India')).toBe('India +91')
  })

  it('takes the closest of several that start the same way', () => {
    expect(bestOption(opts(['Indiana', 'India', 'Indianapolis']), 'India')).toBe('India')
  })

  it('says nothing rather than something wrong', () => {
    expect(bestOption(opts(['Japan', 'Germany']), 'India')).toBeNull()
  })

  it('reads a yes that the form wrote out in full', () => {
    expect(bestOption(opts(['Yes, I am', 'No, I am not']), 'Yes')).toBe('Yes, I am')
  })

  it('is not fooled by an option that merely contains "no"', () => {
    // "None of the above" contains "no" and means the opposite of "No".
    expect(bestOption(opts(['None of the above', 'No']), 'No')).toBe('No')
  })
})

describe('a voluntary demographic question', () => {
  const profile = ProfileSchema.parse({ firstName: 'Nitish', lastName: 'Rathore' })

  function field(label: string, options: string[]): FieldDescriptor {
    return FieldDescriptorSchema.parse({
      selector: '#g',
      label,
      kind: 'combobox',
      required: true,
      options: opts(options),
    })
  }

  it('declines, in whatever words the form offers', () => {
    for (const decline of ['Decline To Self Identify', "I don't wish to answer", 'Prefer not to say']) {
      const guess = guessAnswer(field('Voluntary Self-Identification of Gender', ['Male', 'Female', decline]), profile, null)
      expect(guess?.value).toBe(decline)
    }
  })

  it('leaves the question alone when there is no way to decline', () => {
    const guess = guessAnswer(field('Voluntary Self-Identification of Gender', ['Male', 'Female']), profile, null)
    expect(guess).toBeNull()
  })

  it('does the same for every other demographic question', () => {
    for (const label of [
      'Race / Ethnicity',
      'Are you a protected veteran?',
      'Disability status',
      'What are your pronouns?',
    ]) {
      expect(guessAnswer(field(label, ['One', 'Two']), profile, null)).toBeNull()
    }
  })

  it('still answers an ordinary question from the first option', () => {
    const guess = guessAnswer(field('Which team interests you most?', ['Platform', 'Growth']), profile, null)
    expect(guess?.value).toBe('Platform')
  })
})
