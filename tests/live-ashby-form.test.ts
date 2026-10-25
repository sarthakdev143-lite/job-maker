/**
 * A real Ashby application form, harvested.
 *
 * `tests/fixtures/ashby/application.html` is 1.2 KB of hand-written markup with
 * two native radios in it. It is the fixture the suite had, and it is why 637
 * tests passed over a harvester and filler that could not touch most of what a
 * real form actually contains. This file is the other kind: the rendered DOM of
 * a live OpenAI posting, captured 2026-09-27, scripts and styles stripped.
 *
 * Everything asserted below was broken on this page before the fixes and is the
 * reason a run came back with fields missing or filled with the wrong answer.
 * The three Yes/No questions are the sharpest example. Work authorisation,
 * sponsorship and office attendance are the answers the README tells you to
 * supply by hand, and they were arriving as three identical required checkboxes
 * labelled "No" -- indistinguishable from each other, with the question text
 * nowhere in the field.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { harvestFields } from '@/form/harvester'
import { applyFillPlan } from '@/form/filler'
import { ashbyAdapter } from '@/sites/ashby'
import { canonicalKeyFor } from '@/form/canonical'
import type { FieldDescriptor, FilledField } from '@/storage/schemas'

const LIVE = 'tests/fixtures/ashby/application-live-2026-09-27.html'
const URL = 'https://jobs.ashbyhq.com/OpenAI/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3/application'

function loadLive(): void {
  document.documentElement.innerHTML = readFileSync(LIVE, 'utf8')
}

function planFor(field: FieldDescriptor, value: string): FilledField {
  return {
    selector: field.selector,
    label: field.label,
    kind: field.kind,
    value,
    confidence: 1,
    source: 'profile',
    reasoning: '',
    verified: false,
    error: '',
    required: field.required,
  }
}

describe('a real Ashby application form', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('is recognised as an application form with the right job on it', () => {
    loadLive()
    const detect = ashbyAdapter.detect(document, URL)

    expect(detect.isApplicationForm).toBe(true)
    expect(detect.jobTitle).toContain('Technical Program Manager')
    expect(detect.company).toBe('OpenAI')
  })

  describe('the three Yes/No questions', () => {
    // The whole point of this file. Before the fix these arrived as three
    // identical required checkboxes reading "No".
    it.each([
      ['Are you authorized to work in the country where the job is located?', 'work authorisation'],
      ['We may provide immigration and sponsorship support', 'sponsorship'],
      ['Are you able to work from our US office three days per week?', 'office attendance'],
    ])('harvests %s as a two-option question (%s)', (fragment) => {
      loadLive()
      const field = harvestFields(document).find((f) => f.label.includes(fragment))

      expect(field, `no field found for "${fragment}"`).toBeTruthy()
      expect(field?.kind).toBe('radio')
      expect(field?.options.map((o) => o.label)).toEqual(['Yes', 'No'])
    })

    it('does not emit the hidden checkbox behind them as its own field', () => {
      loadLive()
      const fields = harvestFields(document)

      // The backing `<input type=checkbox tabindex="-1" name="<uuid>">` holds the
      // value; the buttons are the control. Emitting both duplicated every
      // question, once of them unreadable.
      expect(fields.filter((f) => f.label.trim() === 'No')).toHaveLength(0)
    })

    it('fills one by pressing the button that carries the answer', async () => {
      loadLive()
      const field = harvestFields(document).find((f) =>
        f.label.includes('authorized to work in the country')
      )!

      const { filled, failed } = await applyFillPlan([planFor(field, 'Yes')], { min: 0, max: 0 })

      expect(failed.map((f) => f.error)).toEqual([])
      expect(filled).toHaveLength(1)

      const pressed = Array.from(document.querySelectorAll('[data-option][aria-pressed="true"]'))
      expect(pressed).toHaveLength(1)
      expect(pressed[0]?.getAttribute('data-option')).toBe('yes')
    })

    it('fills the other answer without leaving the first one pressed', async () => {
      loadLive()
      const field = harvestFields(document).find((f) => f.label.includes('US office'))!

      await applyFillPlan([planFor(field, 'No')], { min: 0, max: 0 })

      const pressed = Array.from(document.querySelectorAll('[data-option][aria-pressed="true"]'))
      expect(pressed).toHaveLength(1)
      expect(pressed[0]?.getAttribute('data-option')).toBe('no')
    })
  })

  describe('the EEO questions', () => {
    it('gives every group its options, so a decline is possible', () => {
      loadLive()
      const eeo = harvestFields(document).filter((f) => /gender|race|veteran/i.test(f.label))

      expect(eeo.length).toBeGreaterThanOrEqual(3)
      for (const f of eeo) {
        expect(f.options.length, `"${f.label}" harvested with no options`).toBeGreaterThan(1)
      }
    })

    it('offers a decline option on each, which is what the default behaviour needs', () => {
      loadLive()
      const gender = harvestFields(document).find((f) => f.label.toLowerCase().includes('gender'))

      // The README promises EEO questions are declined using the form's own
      // decline option. That is only possible if the option was harvested.
      expect(gender?.options.some((o) => /decline|prefer not|self-identify/i.test(o.label))).toBe(true)
    })

    it('reads the question, not a leaked CSS-module class name', () => {
      loadLive()
      const labels = harvestFields(document).map((f) => f.label)

      // `name` was a UUID with no id on the control, so the label was never
      // found and resolution fell through to a class name.
      expect(labels).not.toContain('Input gender')
      expect(labels.some((l) => /^gender$/i.test(l.trim()))).toBe(true)
    })

    it('resolves the EEO canonical keys, so the decline path is reachable', () => {
      loadLive()
      const eeo = harvestFields(document).filter((f) => /gender|race|veteran/i.test(f.label))

      const keys = eeo.map((f) => canonicalKeyFor(f))
      expect(keys).toContain('eeoGender')
      expect(keys).toContain('eeoRace')
      expect(keys).toContain('eeoVeteran')
    })
  })

  describe('the form as a whole', () => {
    it('gives every required field a label a person could answer', () => {
      loadLive()
      const required = harvestFields(document).filter((f) => f.required)

      expect(required.length).toBeGreaterThan(5)
      for (const f of required) {
        expect(f.label.trim().length, 'a required field with no question').toBeGreaterThan(2)
        // A CSS-module class leaking through as a question.
        expect(f.label, `"${f.kind}" labelled with a class name`).not.toMatch(/^[A-Za-z]+[A-Z][a-z]+$/)
      }
    })

    it('does not produce two fields asking the same question', () => {
      loadLive()
      const questions = harvestFields(document)
        .map((f) => f.label.trim().toLowerCase())
        .filter(Boolean)

      expect(new Set(questions).size).toBe(questions.length)
    })

    it('gives every harvested field a selector that resolves back to it', () => {
      loadLive()
      for (const f of harvestFields(document)) {
        if (!f.selector) continue
        const found = document.querySelectorAll(f.selector).length
        // Zero means buildSelector emitted something the page cannot match --
        // the field would have been reported "element not found" at fill time.
        expect(found, `selector ${f.selector} matches nothing`).toBeGreaterThan(0)
      }
    })
  })
})
