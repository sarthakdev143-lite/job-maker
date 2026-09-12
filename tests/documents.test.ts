/**
 * The fabrication guard is the only thing standing between a model's
 * enthusiasm and a metric on a real resume, so it gets tested directly.
 */

import { describe, expect, it } from 'vitest'
import { screenFabrications } from '@/documents/tailor'
import { ProfileSchema, type Profile, type TailoredResume } from '@/storage/schemas'

const profile: Profile = ProfileSchema.parse({
  firstName: 'Ada',
  lastName: 'Lovelace',
  masterResumeText: 'Led a team of 4 engineers.',
  experience: [
    {
      id: 'role_1',
      company: 'Analytical Engines',
      title: 'Staff Engineer',
      startDate: '2021-01',
      current: true,
      bullets: [
        'Cut p99 latency from 1800ms to 400ms by rewriting the scheduler',
        'Led a team of 4 engineers across two time zones',
      ],
    },
  ],
})

function tailored(bullets: string[]): TailoredResume {
  return { summary: 'Staff engineer.', roles: [{ id: 'role_1', bullets }], skillsOrder: [] }
}

describe('screenFabrications', () => {
  it('keeps a rewrite that reuses the original figures', () => {
    const result = screenFabrications(
      tailored(['Rewrote the scheduler, cutting p99 latency from 1800ms to 400ms']),
      profile
    )
    expect(result.report.clean).toBe(true)
    expect(result.tailored.roles[0]?.bullets).toHaveLength(1)
  })

  it('rejects a bullet that invents a figure', () => {
    const result = screenFabrications(tailored(['Improved throughput by 340% across the platform']), profile)
    expect(result.report.clean).toBe(false)
    expect(result.report.rejectedBullets[0]?.reason).toMatch(/340/)
  })

  it('falls back to the original bullets when screening empties a role', () => {
    const result = screenFabrications(tailored(['Saved $2,500,000 annually']), profile)
    expect(result.tailored.roles[0]?.bullets).toEqual(profile.experience[0]?.bullets)
  })

  it('accepts figures that appear anywhere in the master resume text', () => {
    const result = screenFabrications(tailored(['Led a team of 4 engineers']), profile)
    expect(result.report.clean).toBe(true)
  })

  it('normalizes separators before comparing, so 1,800ms matches 1800ms', () => {
    const result = screenFabrications(tailored(['Cut latency from 1,800ms to 400ms']), profile)
    expect(result.report.clean).toBe(true)
  })

  it('drops a role the model invented outright', () => {
    const result = screenFabrications(
      { summary: '', roles: [{ id: 'role_does_not_exist', bullets: ['Anything'] }], skillsOrder: [] },
      profile
    )
    expect(result.report.clean).toBe(false)
    expect(result.tailored.roles[0]?.bullets).toEqual([])
  })
})
