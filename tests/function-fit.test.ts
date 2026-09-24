/**
 * Dropping postings from another profession.
 *
 * A remote-only sweep for a principal architect returned account executives,
 * pre-sales specialists and go-to-market leads. Each was a real remote posting
 * that broke none of the user's rules, and each cost a model call to score
 * before being rejected at 8 out of 100. The scorer was right; it is just an
 * expensive way to notice something visible in the title.
 *
 * The bar for dropping is deliberately high: wrongly discarding a job someone
 * wanted costs far more than one wasted model call.
 */

import { describe, expect, it } from 'vitest'
import { detectFunction, wrongProfession } from '@/matching/function-fit'

const ARCHITECT = ['Principal Solution Architect', 'Software Architect', 'Senior Software Engineer']

describe('detectFunction', () => {
  it('reads engineering titles, including ambiguous ones', () => {
    expect(detectFunction('Staff Software Engineer')).toBe('engineering')
    expect(detectFunction('Principal Solution Architect')).toBe('engineering')
    // "Sales Engineer" contains a sales word but is still an engineering title.
    expect(detectFunction('Senior Sales Engineer')).toBe('engineering')
    expect(detectFunction('Site Reliability Engineer (SRE)')).toBe('engineering')
  })

  it('reads the other professions', () => {
    expect(detectFunction('Senior Account Executive, Startups')).toBe('sales')
    expect(detectFunction('Demand Generation Lead')).toBe('marketing')
    expect(detectFunction('Staff Accountant')).toBe('finance')
    expect(detectFunction('Technical Recruiter')).toBe('people')
    expect(detectFunction('Associate General Counsel')).toBe('legal')
    expect(detectFunction('Customer Success Manager')).toBe('support')
  })

  it('says nothing about a title it cannot place', () => {
    expect(detectFunction('Chief of Staff')).toBe('unknown')
    expect(detectFunction('')).toBe('unknown')
  })
})

describe('wrongProfession', () => {
  it('drops a sales role for an architect', () => {
    expect(wrongProfession('Senior Account Executive, Startups (SoCal)', ARCHITECT)).toBe('sales')
    expect(wrongProfession('Principal Account Executive, SLED West', ARCHITECT)).toBe('sales')
  })

  it('keeps every engineering role', () => {
    expect(wrongProfession('Software Architect (L6)', ARCHITECT)).toBeNull()
    expect(wrongProfession('Staff Software Engineer', ARCHITECT)).toBeNull()
    expect(wrongProfession('Senior Sales Engineer', ARCHITECT)).toBeNull()
  })

  it('keeps anything it cannot place', () => {
    expect(wrongProfession('Chief of Staff, CRO', ARCHITECT)).toBeNull()
    expect(wrongProfession('Member of Technical Staff', ARCHITECT)).toBeNull()
  })

  it('does nothing when the applicant has no history to judge against', () => {
    expect(wrongProfession('Senior Account Executive', [])).toBeNull()
    expect(wrongProfession('Senior Account Executive', ['Chief of Staff'])).toBeNull()
  })

  it('keeps a sales role for someone who has actually done sales', () => {
    expect(wrongProfession('Senior Account Executive', ['Account Executive', 'Sales Manager'])).toBeNull()
  })

  it('keeps an engineering role for someone moving from sales engineering', () => {
    expect(wrongProfession('Staff Software Engineer', ['Sales Engineer'])).toBeNull()
  })
})
