import { describe, expect, it } from 'vitest'
import {
  condenseDescription,
  detectSeniority,
  detectWorkMode,
  normalizeQuestion,
  parsePostedDate,
  parseSalary,
  renderTemplate,
  similarity,
} from '@/shared/text'

describe('normalizeQuestion', () => {
  it('collapses the same question asked two ways', () => {
    const a = normalizeQuestion('Are you legally authorized to work in the United States?*')
    const b = normalizeQuestion('Are you legally authorised to work in the US? (required)')
    expect(a).toBe(b)
  })

  it('strips required markers and parenthetical noise', () => {
    expect(normalizeQuestion('First Name *')).toBe('first name')
    expect(normalizeQuestion('Phone (optional)')).toBe('phone')
  })

  it('normalizes vocabulary so a bank hit is possible', () => {
    expect(normalizeQuestion('Mobile number')).toBe('phone number')
    expect(normalizeQuestion('Expected CTC')).toBe('expected compensation')
    expect(normalizeQuestion('Upload your CV')).toBe('upload resume')
  })

  it('is stable under punctuation and case', () => {
    expect(normalizeQuestion('WHY DO YOU WANT TO WORK HERE?')).toBe(normalizeQuestion('why do you want to work here'))
  })
})

describe('similarity', () => {
  it('scores a contained phrase highly', () => {
    expect(similarity('first name', 'legal first name')).toBeGreaterThan(0.8)
  })

  it('separates unrelated questions', () => {
    expect(similarity('first name', 'expected compensation')).toBeLessThan(0.3)
  })

  it('matches reworded but equivalent questions above the bank threshold', () => {
    expect(similarity('current employer', 'current company')).toBeGreaterThan(0.4)
    expect(similarity('linkedin profile url', 'linkedin url')).toBeGreaterThan(0.78)
  })
})

describe('detectSeniority', () => {
  it('reads the title first', () => {
    expect(detectSeniority('Senior Software Engineer')).toBe('senior')
    expect(detectSeniority('Engineering Manager')).toBe('manager')
    expect(detectSeniority('Software Engineering Intern')).toBe('intern')
    expect(detectSeniority('Staff Backend Engineer')).toBe('staff')
  })

  it('falls back to the years the description asks for', () => {
    expect(detectSeniority('Software Engineer', 'We want someone with 7 years of experience')).toBe('senior')
    expect(detectSeniority('Software Engineer', 'Looking for 1 year of experience')).toBe('junior')
  })
})

describe('detectWorkMode', () => {
  it('prefers hybrid when both words appear', () => {
    expect(detectWorkMode('Hybrid role, 3 days remote')).toBe('hybrid')
  })

  it('identifies remote and onsite', () => {
    expect(detectWorkMode('Fully remote, work from home')).toBe('remote')
    expect(detectWorkMode('On-site in Bengaluru')).toBe('onsite')
    expect(detectWorkMode('Software Engineer')).toBe('unknown')
  })
})

describe('parseSalary', () => {
  it('reads Indian lakh notation', () => {
    const result = parseSalary('INR 25-35 LPA')
    expect(result.currency).toBe('INR')
    expect(result.min).toBe(2500000)
    expect(result.max).toBe(3500000)
  })

  it('reads US thousands notation', () => {
    const result = parseSalary('$120k - $160k')
    expect(result.currency).toBe('USD')
    expect(result.min).toBe(120000)
    expect(result.max).toBe(160000)
  })

  it('ignores numbers too small to be a salary', () => {
    expect(parseSalary('3 years of experience').min).toBeNull()
  })
})

describe('parsePostedDate', () => {
  const base = Date.parse('2026-01-15T12:00:00Z')

  it('understands relative phrasing', () => {
    expect(parsePostedDate('3 days ago', base)).toBe(base - 3 * 86400000)
    expect(parsePostedDate('Just posted', base)).toBe(base)
    expect(parsePostedDate('yesterday', base)).toBe(base - 86400000)
  })

  it('returns null for text with no date in it', () => {
    expect(parsePostedDate('Bengaluru, India', base)).toBeNull()
  })
})

describe('condenseDescription', () => {
  it('keeps the head and the tail of a long posting', () => {
    const text = `ROLE SUMMARY${'x'.repeat(5000)}REQUIREMENTS SECTION`
    const condensed = condenseDescription(text, 1000)
    expect(condensed.startsWith('ROLE SUMMARY')).toBe(true)
    expect(condensed.endsWith('REQUIREMENTS SECTION')).toBe(true)
    expect(condensed).toContain('[...]')
    expect(condensed.length).toBeLessThan(1100)
  })
})

describe('renderTemplate', () => {
  it('fills placeholders and drops unknown ones', () => {
    expect(renderTemplate('{a} and {b} and {missing}', { a: 'one', b: 2 })).toBe('one and 2 and ')
  })
})
