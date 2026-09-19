/**
 * A resume import must never succeed silently having read nothing.
 *
 * Every field in ParsedResumeSchema carries a `.default()`, so a model reply of
 * `{}` validated cleanly and became a fully-empty ParsedResume. mergeIntoProfile
 * skips empty fields, so the import then reported success with zero changes and
 * the profile stayed blank — indistinguishable, to the user, from the extension
 * simply not working.
 */

import { describe, expect, it } from 'vitest'

import { isHollowParse, mergeIntoProfile } from '@/documents/parse-resume'
import { ParsedResumeSchema, ProfileSchema, type ParsedResume } from '@/storage/schemas'

function parsed(overrides: Partial<ParsedResume> = {}): ParsedResume {
  return ParsedResumeSchema.parse(overrides)
}

describe('isHollowParse', () => {
  it('flags a reply of {}', () => {
    expect(isHollowParse(parsed())).toBe(true)
  })

  it('flags a reply whose keys we do not recognise', () => {
    // Zod strips unknown keys, so this arrives as an empty object.
    expect(isHollowParse(ParsedResumeSchema.parse({ name: 'Sarthak', jobs: [{ co: 'Acme' }] }))).toBe(
      true
    )
  })

  it('flags the prompt shape example echoed back verbatim', () => {
    // The prompt ends with a template containing one blank role; weaker models
    // sometimes return it as-is, which is content-free despite being non-empty.
    const echoed = parsed({
      experience: [
        { company: '', title: '', location: '', startDate: '', endDate: '', current: false, bullets: [], tech: [] },
      ],
      education: [{ school: '', degree: '', field: '', startDate: '', endDate: '', gpa: '' }],
    })
    expect(isHollowParse(echoed)).toBe(true)
  })

  it.each([
    ['a first name', { firstName: 'Sarthak' }],
    ['a last name', { lastName: 'Parulekar' }],
    ['an email', { email: 'a@b.com' }],
    ['a phone number', { phone: '9990001111' }],
    ['a skill', { skills: ['TypeScript'] }],
    ['a summary', { summary: 'Backend engineer.' }],
    ['a headline', { headline: 'Software Engineer' }],
  ])('accepts a parse carrying %s', (_label, fields) => {
    expect(isHollowParse(parsed(fields as Partial<ParsedResume>))).toBe(false)
  })

  it('accepts a role that has a company or a title', () => {
    const withRole = parsed({
      experience: [
        {
          company: 'Acme',
          title: '',
          location: '',
          startDate: '',
          endDate: '',
          current: false,
          bullets: [],
          tech: [],
        },
      ],
    })
    expect(isHollowParse(withRole)).toBe(false)
  })

  it('accepts education alone, for a new graduate with no roles yet', () => {
    const grad = parsed({
      education: [
        { school: 'IIT Bombay', degree: 'B.Tech', field: 'CS', startDate: '', endDate: '', gpa: '' },
      ],
    })
    expect(isHollowParse(grad)).toBe(false)
  })
})

describe('the silent failure this guards against', () => {
  it('an empty parse merges into a profile without changing anything', () => {
    // This is what used to reach the user as a successful import.
    const before = ProfileSchema.parse({})
    const result = mergeIntoProfile(before, parsed(), 'fill_empty', 'x'.repeat(200))

    expect(result.profile.firstName).toBe('')
    expect(result.profile.experience).toEqual([])
    expect(result.profile.skills).toEqual([])
    // The only recorded change is the raw text being stored — nothing a user
    // would recognise as their resume having been read.
    expect(result.changes.filter((c) => c !== 'master resume text')).toEqual([])
  })

  it('a real parse does change the profile, so the guard is not over-broad', () => {
    const before = ProfileSchema.parse({})
    const result = mergeIntoProfile(
      before,
      parsed({ firstName: 'Sarthak', email: 'a@b.com', skills: ['TypeScript'] }),
      'fill_empty',
      'x'.repeat(200)
    )

    expect(result.profile.firstName).toBe('Sarthak')
    expect(result.changes).toContain('first name')
  })
})
