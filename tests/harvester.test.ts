/**
 * Fixture tests for the harvester and the canonical matcher.
 *
 * These are the tests that catch adapter rot. Each fixture is a real ATS form
 * shape; the assertions say which question each control is asking and which
 * profile field answers it. When a vendor changes their markup, this file
 * fails before a user finds out by having an application filled in wrongly.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { harvestFields, resolveLabel } from '@/form/harvester'
import { answerCanonical, canonicalKeyFor } from '@/form/canonical'
import { buildSelector } from '@/form/selector'
import { greenhouseAdapter } from '@/sites/greenhouse'
import { leverAdapter } from '@/sites/lever'
import { ashbyAdapter } from '@/sites/ashby'
import { workdayAdapter } from '@/sites/workday'
import { ProfileSchema, type FieldDescriptor, type Profile } from '@/storage/schemas'

function loadFixture(vendor: string): Document {
  const html = readFileSync(resolve(__dirname, 'fixtures', vendor, 'application.html'), 'utf-8')
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>[\s\S]*$/i, '')
  return document
}

function byLabel(fields: FieldDescriptor[], fragment: string): FieldDescriptor | undefined {
  return fields.find((f) => f.label.toLowerCase().includes(fragment.toLowerCase()))
}

const profile: Profile = ProfileSchema.parse({
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  phone: '9876543210',
  phoneCountryCode: '+91',
  city: 'Bengaluru',
  state: 'Karnataka',
  country: 'India',
  linkedin: 'https://linkedin.com/in/ada',
  github: 'https://github.com/ada',
  currentCompany: 'Analytical Engines',
  currentTitle: 'Staff Engineer',
  workAuthorization: {
    authorizedInCountries: ['India'],
    requiresSponsorship: true,
    willingToRelocate: false,
    noticePeriodDays: 60,
  },
  compensation: { currency: 'INR', expectedCtc: '45 LPA' },
})

describe('Greenhouse fixture', () => {
  let fields: FieldDescriptor[]

  beforeEach(() => {
    const doc = loadFixture('greenhouse')
    fields = harvestFields(doc)
  })

  it('detects the application form', () => {
    const result = greenhouseAdapter.detect(document, 'https://boards.greenhouse.io/acme/jobs/1')
    expect(result.isApplicationForm).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.9)
    expect(result.jobTitle).toContain('Senior Backend Engineer')
  })

  it('skips hidden inputs and site search boxes', () => {
    expect(fields.some((f) => f.name.includes('authenticity_token'))).toBe(false)
    expect(fields.some((f) => f.name === 'search')).toBe(false)
  })

  it('reads labels through label[for]', () => {
    expect(byLabel(fields, 'first name')).toBeDefined()
    expect(byLabel(fields, 'first name')?.required).toBe(true)
  })

  it('strips the required marker from the label', () => {
    expect(byLabel(fields, 'last name')?.label).toBe('Last Name')
  })

  it('maps vendor field names to canonical keys', () => {
    const first = byLabel(fields, 'first name')!
    expect(greenhouseAdapter.canonicalKey?.(first)).toBe('firstName')
    const resume = fields.find((f) => f.kind === 'file')!
    expect(greenhouseAdapter.canonicalKey?.(resume)).toBe('resume')
  })

  it('collapses a radio group into one question, keeping its options', () => {
    const sponsorship = fields.find((f) => f.group === 'sponsorship')
    expect(sponsorship).toBeDefined()
    expect(sponsorship?.kind).toBe('radio')
    expect(sponsorship?.label).toMatch(/sponsorship/i)
    expect(sponsorship?.options.map((o) => o.label)).toEqual(['Yes', 'No'])
  })

  it('answers the sponsorship question from the profile, using the form wording', () => {
    const sponsorship = fields.find((f) => f.group === 'sponsorship')!
    const key = canonicalKeyFor(sponsorship)
    expect(key).toBe('requiresSponsorship')
    expect(answerCanonical(key!, profile, sponsorship)?.value).toBe('Yes')
  })

  it('captures select options so an answer can be snapped onto one', () => {
    const auth = byLabel(fields, 'legally authorized')!
    expect(auth.options.map((o) => o.label)).toContain('Yes')
    expect(canonicalKeyFor(auth)).toBe('workAuthorized')
  })

  it('declines EEO questions by default, choosing the form’s own decline option', () => {
    const gender = byLabel(fields, 'gender')!
    expect(canonicalKeyFor(gender)).toBe('eeoGender')
    expect(answerCanonical('eeoGender', profile, gender)?.value).toBe('Decline To Self Identify')
  })

  it('records maxLength so long answers get truncated rather than rejected', () => {
    expect(byLabel(fields, 'why do you want')?.maxLength).toBe(2000)
  })

  it('leaves a bespoke question for the model', () => {
    const why = byLabel(fields, 'why do you want')!
    expect(canonicalKeyFor(why)).toBeNull()
  })
})

describe('Lever fixture', () => {
  let fields: FieldDescriptor[]

  beforeEach(() => {
    const doc = loadFixture('lever')
    fields = harvestFields(doc)
  })

  it('maps the combined name field to a full name', () => {
    const name = fields.find((f) => f.name === 'name')!
    expect(leverAdapter.canonicalKey?.(name)).toBe('fullName')
    expect(answerCanonical('fullName', profile, name)?.value).toBe('Ada Lovelace')
  })

  it('maps namespaced link fields', () => {
    const linkedin = fields.find((f) => f.name === 'urls[LinkedIn]')!
    const github = fields.find((f) => f.name === 'urls[GitHub]')!
    expect(leverAdapter.canonicalKey?.(linkedin)).toBe('linkedin')
    expect(leverAdapter.canonicalKey?.(github)).toBe('github')
  })

  it('falls back to the label for opaque custom questions', () => {
    const salary = fields.find((f) => f.name.startsWith('cards['))!
    expect(leverAdapter.canonicalKey?.(salary)).toBeNull()
    expect(canonicalKeyFor(salary)).toBe('expectedSalary')
    expect(answerCanonical('expectedSalary', profile, salary)?.value).toBe('45 LPA')
  })

  it('reads labels from a sibling inside the field wrapper', () => {
    expect(byLabel(fields, 'current company')).toBeDefined()
    expect(canonicalKeyFor(byLabel(fields, 'current company')!)).toBe('currentCompany')
  })
})

describe('Ashby fixture', () => {
  let fields: FieldDescriptor[]

  beforeEach(() => {
    const doc = loadFixture('ashby')
    fields = harvestFields(doc)
  })

  it('maps system fields', () => {
    const email = fields.find((f) => f.id === '_systemfield_email')!
    expect(ashbyAdapter.canonicalKey?.(email)).toBe('email')
  })

  it('reads a radio group question from aria-labelledby', () => {
    const relocate = fields.find((f) => f.group === 'relocate')!
    expect(relocate.label).toMatch(/willing to relocate/i)
    expect(canonicalKeyFor(relocate)).toBe('willingToRelocate')
    expect(answerCanonical('willingToRelocate', profile, relocate)?.value).toBe('No')
  })

  it('answers a notice period question from the profile', () => {
    const notice = byLabel(fields, 'notice period')!
    expect(canonicalKeyFor(notice)).toBe('noticePeriod')
    expect(answerCanonical('noticePeriod', profile, notice)?.value).toBe('60 days')
  })
})

describe('Workday fixture', () => {
  let fields: FieldDescriptor[]

  beforeEach(() => {
    const doc = loadFixture('workday')
    fields = harvestFields(doc)
  })

  it('builds selectors from data-automation-id', () => {
    const first = fields.find((f) => f.selector.includes('legalNameSection_firstName'))
    expect(first).toBeDefined()
    expect(first?.label).toBe('First Name')
  })

  it('maps automation ids to canonical keys', () => {
    const city = fields.find((f) => f.selector.includes('addressSection_city'))!
    expect(workdayAdapter.canonicalKey?.(city)).toBe('city')
    expect(answerCanonical('city', profile, city)?.value).toBe('Bengaluru')
  })

  it('reports the form as multi-step', () => {
    expect(workdayAdapter.detect(document, 'https://acme.wd1.myworkdayjobs.com/careers').multiStep).toBe(true)
  })
})

describe('selector building', () => {
  beforeEach(() => {
    loadFixture('greenhouse')
  })

  it('prefers a stable id', () => {
    const el = document.querySelector('#first_name')!
    expect(buildSelector(el, document)).toBe('#first_name')
  })

  it('disambiguates radio group members by value', () => {
    const el = document.querySelector('input[name="sponsorship"][value="no"]')!
    const selector = buildSelector(el, document)
    expect(document.querySelectorAll(selector).length).toBe(1)
  })

  it('produces selectors that resolve back to exactly one element', () => {
    for (const field of harvestFields(document)) {
      expect(document.querySelectorAll(field.selector).length, `${field.label} -> ${field.selector}`).toBe(1)
    }
  })
})

describe('resolveLabel cascade', () => {
  it('falls back through the mechanisms in order', () => {
    document.documentElement.innerHTML = `
      <body>
        <div class="field"><span class="label">Preceding sibling label</span><input id="a" /></div>
        <div><input id="b" aria-label="Aria labelled" /></div>
        <div><label>Wrapping label <input id="c" /></label></div>
        <div><input id="d" placeholder="Placeholder only" /></div>
        <div><input id="e" name="snake_case_name" /></div>
      </body>`
    expect(resolveLabel(document.querySelector('#a')!, document)).toBe('Preceding sibling label')
    expect(resolveLabel(document.querySelector('#b')!, document)).toBe('Aria labelled')
    expect(resolveLabel(document.querySelector('#c')!, document)).toBe('Wrapping label')
    expect(resolveLabel(document.querySelector('#d')!, document)).toBe('Placeholder only')
    expect(resolveLabel(document.querySelector('#e')!, document)).toBe('snake case name')
  })
})
