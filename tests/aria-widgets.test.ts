/**
 * Choice widgets that are not native inputs.
 *
 * The whole class of bug this file covers was invisible to the suite until now:
 * every fixture in `tests/fixtures/` was hand-written with plain
 * `<input type="radio">` and `<select>` markup, so a harvester and filler built
 * entirely in terms of those passed 637 tests while being unable to touch a
 * single question on a modern React ATS form. Workable, SmartRecruiters and the
 * current Lever and Ashby forms render their yes/no and multiple-choice
 * questions as `div[role="radio"]` and `div[role="checkbox"]` -- no input, no
 * name, no `<option>` to enumerate.
 *
 * Before this file: such a question was harvested with the right text and *zero
 * options*, so nothing upstream could answer it, and every write path refused it
 * with "no writer matched". The field was then reported as unfillable and parked.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { harvestFields } from '@/form/harvester'
import { applyFillPlan } from '@/form/filler'
import type { FieldDescriptor, FilledField } from '@/storage/schemas'

/** Turn a harvested descriptor into a fill-plan entry, as the runner does. */
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

/** react-aria's shape: a labelled radiogroup of divs, selection in aria-checked. */
const ARIA_RADIOGROUP = `
<div class="application-question">
  <span id="auth-label">Are you authorised to work in the United States?</span>
  <div role="radiogroup" aria-labelledby="auth-label">
    <div role="radio" aria-checked="false" data-value="yes" tabindex="-1">Yes</div>
    <div role="radio" aria-checked="false" data-value="no" tabindex="-1">No</div>
  </div>
</div>`

/** The same question with the group labelling itself. */
const ARIA_RADIOGROUP_ARIA_LABEL = `
<div role="radiogroup" aria-label="Will you now or in the future require sponsorship?">
  <div role="radio" aria-checked="false" tabindex="-1">Yes</div>
  <div role="radio" aria-checked="false" tabindex="-1">No</div>
</div>`

/** A multi-select question: a group of switches, not a yes/no. */
const ARIA_CHECKBOX_GROUP = `
<div class="field">
  <label id="langs-label">Which languages can you read independently?</label>
  <div role="group" aria-labelledby="langs-label">
    <div role="checkbox" aria-checked="false" data-value="python">Python</div>
    <div role="checkbox" aria-checked="false" data-value="rust">Rust</div>
    <div role="checkbox" aria-checked="false" data-value="go">Go</div>
  </div>
</div>`

/** A single yes/no toggle with no group. */
const ARIA_SWITCH = `
<div role="switch" aria-checked="false" aria-label="I agree to the privacy policy">I agree</div>`

const radioOf = (fields: FieldDescriptor[], kind: 'radio' | 'checkbox' = 'radio') =>
  fields.find((f) => f.kind === kind)

describe('ARIA choice widgets that are not native inputs', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  describe('harvesting', () => {
    it('reads the question from aria-labelledby and lists its options', () => {
      document.body.innerHTML = ARIA_RADIOGROUP
      const group = radioOf(harvestFields(document))

      expect(group, 'the radiogroup must be harvested as one question').toBeTruthy()
      expect(group?.label).toContain('authorised to work')
      expect(group?.options.map((o) => o.label)).toEqual(['Yes', 'No'])
    })

    it('reads the question from the group\'s own aria-label', () => {
      document.body.innerHTML = ARIA_RADIOGROUP_ARIA_LABEL
      const group = radioOf(harvestFields(document))

      expect(group?.label).toContain('require sponsorship')
      expect(group?.options.length).toBe(2)
    })

    it('harvests a group of switches as one multi-select question, not three', () => {
      document.body.innerHTML = ARIA_CHECKBOX_GROUP
      const fields = harvestFields(document)

      expect(fields.length).toBe(1)
      expect(fields[0]?.label).toContain('read independently')
      expect(fields[0]?.options.map((o) => o.label)).toEqual(['Python', 'Rust', 'Go'])
    })

    it('harvests a lone switch as a boolean checkbox', () => {
      document.body.innerHTML = ARIA_SWITCH
      const fields = harvestFields(document)

      expect(fields.length).toBe(1)
      expect(fields[0]?.kind).toBe('checkbox')
      expect(fields[0]?.label).toContain('privacy policy')
      expect(fields[0]?.currentValue).toBe('false')
    })

    it('does not mistake the option text for the question', () => {
      document.body.innerHTML = `
        <div class="field">
          <div role="radiogroup">
            <div role="radio">Yes</div>
            <div role="radio">No</div>
          </div>
        </div>`
      const group = radioOf(harvestFields(document))

      // No label anywhere: it must not report an option as the question.
      expect(group?.options.length).toBe(2)
      expect(group?.label).not.toBe('Yes')
    })
  })

  describe('filling', () => {
    it('selects an option and verifies it held', async () => {
      document.body.innerHTML = ARIA_RADIOGROUP
      const group = radioOf(harvestFields(document))!

      const { filled, failed } = await applyFillPlan([planFor(group, 'Yes')], { min: 0, max: 0 })

      expect(failed.map((f) => f.error)).toEqual([])
      expect(filled.length).toBe(1)
      expect(document.querySelector('[data-value="yes"]')?.getAttribute('aria-checked')).toBe('true')
      expect(document.querySelector('[data-value="no"]')?.getAttribute('aria-checked')).toBe('false')
    })

    it('selects by the widget\'s own value, not only by its text', async () => {
      document.body.innerHTML = ARIA_RADIOGROUP
      const group = radioOf(harvestFields(document))!

      await applyFillPlan([planFor(group, 'no')], { min: 0, max: 0 })

      expect(document.querySelector('[data-value="no"]')?.getAttribute('aria-checked')).toBe('true')
    })

    it('ticks several boxes when the answer names several options', async () => {
      document.body.innerHTML = ARIA_CHECKBOX_GROUP
      const group = radioOf(harvestFields(document), 'checkbox')!

      const { filled, failed } = await applyFillPlan(
        [planFor(group, 'Python, Go')],
        { min: 0, max: 0 }
      )

      expect(failed.map((f) => f.error)).toEqual([])
      expect(filled.length).toBe(1)
      expect(document.querySelector('[data-value="python"]')?.getAttribute('aria-checked')).toBe('true')
      expect(document.querySelector('[data-value="go"]')?.getAttribute('aria-checked')).toBe('true')
      expect(document.querySelector('[data-value="rust"]')?.getAttribute('aria-checked')).toBe('false')
    })

    it('ticks a lone switch', async () => {
      document.body.innerHTML = ARIA_SWITCH
      const field = harvestFields(document)[0]

      const { filled, failed } = await applyFillPlan([planFor(field, 'true')], { min: 0, max: 0 })

      expect(failed.map((f) => f.error)).toEqual([])
      expect(filled.length).toBe(1)
      expect(document.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
    })

    it('unticks a lone switch when the answer is no', async () => {
      document.body.innerHTML = ARIA_SWITCH.replace('aria-checked="false"', 'aria-checked="true"')
      const field = harvestFields(document)[0]

      const { filled } = await applyFillPlan([planFor(field, 'false')], { min: 0, max: 0 })

      expect(filled.length).toBe(1)
      expect(document.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
    })

    it('reports an unselectable group as failed rather than filled', async () => {
      document.body.innerHTML = ARIA_RADIOGROUP
      const group = radioOf(harvestFields(document))!

      const { filled, failed } = await applyFillPlan([planFor(group, 'Maybe')], { min: 0, max: 0 })

      expect(filled.length).toBe(0)
      expect(failed.length).toBe(1)
      // The whole point: it must not claim a group is answered when nothing is
      // selected, which is what sent forms to employers with a blank required
      // question.
      expect(
        Array.from(document.querySelectorAll('[role="radio"]')).every(
          (r) => r.getAttribute('aria-checked') === 'false'
        )
      ).toBe(true)
    })
  })
})
