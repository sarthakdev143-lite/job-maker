/**
 * The merge is where a resume import can quietly destroy work the user did by
 * hand, so it is tested directly rather than through the UI.
 */

import { describe, expect, it } from 'vitest'
import { mergeIntoProfile, normalizeResumeText, remainingGaps } from '@/documents/parse-resume'
import { asSeniority } from '@/matching/suggest'
import { ParsedResumeSchema, ProfileSchema, type ParsedResume, type Profile } from '@/storage/schemas'

function parsed(overrides: Record<string, unknown> = {}): ParsedResume {
  return ParsedResumeSchema.parse({
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    phone: '9876543210',
    city: 'Bengaluru',
    skills: ['Go', 'Postgres'],
    experience: [
      {
        company: 'Analytical Engines',
        title: 'Staff Engineer',
        startDate: '2021-01',
        current: true,
        bullets: ['Cut p99 latency from 1800ms to 400ms'],
      },
    ],
    education: [{ school: 'Cambridge', degree: 'BSc', field: 'Mathematics', endDate: '2016-06' }],
    ...overrides,
  })
}

// Typed loosely on purpose: these fixtures pass partial nested objects and let
// the schema apply its own defaults, which is exactly how stored records behave.
function profile(overrides: Record<string, unknown> = {}): Profile {
  return ProfileSchema.parse(overrides)
}

const RAW = 'Ada Lovelace\nStaff Engineer\nCut p99 latency from 1800ms to 400ms'

describe('mergeIntoProfile in fill_empty mode', () => {
  it('fills every empty field', () => {
    const result = mergeIntoProfile(profile(), parsed(), 'fill_empty', RAW)
    expect(result.profile.firstName).toBe('Ada')
    expect(result.profile.email).toBe('ada@example.com')
    expect(result.profile.skills).toEqual(['Go', 'Postgres'])
    expect(result.changes).toContain('email')
  })

  it('never overwrites something the user already typed', () => {
    const existing = profile({ email: 'me@personal.com', city: 'Pune' })
    const result = mergeIntoProfile(existing, parsed(), 'fill_empty', RAW)
    expect(result.profile.email).toBe('me@personal.com')
    expect(result.profile.city).toBe('Pune')
    expect(result.skipped).toContain('email')
  })

  it('does not report a change when the value already matched', () => {
    const existing = profile({ firstName: 'Ada' })
    const result = mergeIntoProfile(existing, parsed(), 'fill_empty', RAW)
    expect(result.changes).not.toContain('first name')
    expect(result.skipped).not.toContain('first name')
  })

  it('keeps existing experience rather than merging two sources of truth', () => {
    const existing = profile({
      experience: [{ id: 'role_kept', company: 'Mine', title: 'Engineer', bullets: ['Did a thing'] }],
    })
    const result = mergeIntoProfile(existing, parsed(), 'fill_empty', RAW)
    expect(result.profile.experience).toHaveLength(1)
    expect(result.profile.experience[0]?.company).toBe('Mine')
    expect(result.skipped).toContain('experience')
  })
})

describe('mergeIntoProfile in replace mode', () => {
  it('lets the resume win', () => {
    const existing = profile({ email: 'me@personal.com' })
    const result = mergeIntoProfile(existing, parsed(), 'replace', RAW)
    expect(result.profile.email).toBe('ada@example.com')
  })

  it('leaves a field alone when the resume said nothing about it', () => {
    const existing = profile({ phone: '5551234', portfolio: 'https://ada.dev' })
    const result = mergeIntoProfile(existing, parsed({ phone: '', portfolio: '' }), 'replace', RAW)
    expect(result.profile.phone).toBe('5551234')
    expect(result.profile.portfolio).toBe('https://ada.dev')
  })

  it('reuses the id of a role the user has already edited', () => {
    const existing = profile({
      experience: [
        { id: 'role_original', company: 'Analytical Engines', title: 'Staff Engineer', bullets: ['My own wording'] },
      ],
    })
    const result = mergeIntoProfile(existing, parsed(), 'replace', RAW)
    // Tailoring addresses roles by id, so a stable id matters across imports.
    expect(result.profile.experience[0]?.id).toBe('role_original')
    expect(result.profile.experience[0]?.bullets).toEqual(['Cut p99 latency from 1800ms to 400ms'])
  })

  it('gives new roles generated ids', () => {
    const result = mergeIntoProfile(profile(), parsed(), 'replace', RAW)
    expect(result.profile.experience[0]?.id).toMatch(/^role_/)
    expect(result.profile.education[0]?.id).toMatch(/^edu_/)
  })
})

describe('mergeIntoProfile always', () => {
  it('stores the raw text for the fabrication screen to check against', () => {
    const result = mergeIntoProfile(profile(), parsed(), 'fill_empty', RAW)
    expect(result.profile.masterResumeText).toContain('1800ms')
  })

  it('never takes demographic answers from a resume', () => {
    const result = mergeIntoProfile(profile(), parsed(), 'replace', RAW)
    expect(result.profile.voluntary.answerEeoQuestions).toBe(false)
  })

  it('only takes work authorization when the document stated it', () => {
    const silent = mergeIntoProfile(profile(), parsed(), 'replace', RAW)
    expect(silent.profile.workAuthorization.authorizedInCountries).toEqual([])

    const stated = mergeIntoProfile(
      profile(),
      parsed({ workAuthorization: { authorizedInCountries: ['India'], requiresSponsorship: false } }),
      'replace',
      RAW
    )
    expect(stated.profile.workAuthorization.authorizedInCountries).toEqual(['India'])
  })
})

describe('normalizeResumeText', () => {
  it('cleans up the artefacts PDF extraction leaves behind', () => {
    const messy = 'Identiﬁed  issues\r\n• Did a thing\r\n\r\n\r\nNext – section'
    const clean = normalizeResumeText(messy)
    expect(clean).toContain('Identified issues')
    expect(clean).toContain('- Did a thing')
    expect(clean).toContain('Next - section')
    expect(clean).not.toMatch(/\n{3,}/)
  })
})

describe('remainingGaps', () => {
  it('names what a resume cannot answer', () => {
    const gaps = remainingGaps(profile({ firstName: 'Ada', email: 'a@b.c', phone: '123' }))
    expect(gaps).toContain('which countries you are authorized to work in')
    expect(gaps).toContain('expected compensation')
    expect(gaps).not.toContain('email address')
  })

  it('is empty once the answerable fields are filled', () => {
    const complete = profile({
      email: 'a@b.c',
      phone: '123',
      workAuthorization: { authorizedInCountries: ['India'], noticePeriodDays: 30 },
      compensation: { expectedCtc: '40 LPA' },
    })
    expect(remainingGaps(complete)).toEqual([])
  })
})

describe('asSeniority', () => {
  it('drops levels the prefilter would not understand', () => {
    expect(asSeniority(['senior', 'wizard', 'staff'])).toEqual(['senior', 'staff', 'unknown'])
  })

  it('always keeps unknown, because most postings do not state a level', () => {
    expect(asSeniority(['mid'])).toContain('unknown')
    expect(asSeniority(['mid', 'unknown'])).toEqual(['mid', 'unknown'])
  })
})
