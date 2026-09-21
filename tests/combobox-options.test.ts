/**
 * Reading a react-select dropdown's choices by opening it.
 *
 * A live Greenhouse form at Twilio came back with three mandatory questions
 * carrying zero options each, because react-select renders nothing until the
 * control is clicked. Every tier downstream needs those choices: the profile
 * answer to a gender question is "decline to self-identify", which is an option
 * or it is nothing; the guess tier picks the most defensible option on offer
 * and had none; and the model was being asked a multiple-choice question
 * without being shown the choices. All three were parked, and Greenhouse
 * rejects a submission with a mandatory question left blank.
 *
 * The widgets below are faithful to the real markup, including the part that
 * makes this necessary — the menu exists only while the control is open.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { revealComboboxOptions } from '@/form/combobox-options'
import { harvestFields } from '@/form/harvester'
import type { FieldDescriptor } from '@/storage/schemas'

/** A react-select that renders its menu on click and removes it on Escape. */
function mountSelect(id: string, label: string, options: string[], opts: { onType?: boolean } = {}): void {
  const host = document.createElement('div')
  host.innerHTML = `
    <label for="${id}">${label}</label>
    <div class="select__control">
      <input id="${id}" role="combobox" aria-autocomplete="list" aria-expanded="false"
             aria-controls="${id}-menu" aria-required="true" type="text" />
    </div>
    <div id="${id}-menu"></div>`
  document.body.appendChild(host)

  const input = document.getElementById(id) as HTMLInputElement
  const menu = document.getElementById(`${id}-menu`) as HTMLElement

  const open = (): void => {
    if (opts.onType && !input.value) return // a typeahead shows nothing until you type
    menu.innerHTML = options
      .map((o) => `<div role="option" class="select__option" tabindex="-1">${o}</div>`)
      .join('')
    input.setAttribute('aria-expanded', 'true')
  }
  const shut = (): void => {
    menu.innerHTML = ''
    input.setAttribute('aria-expanded', 'false')
  }

  input.addEventListener('mousedown', open)
  input.addEventListener('click', open)
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') shut()
  })
}

/**
 * happy-dom gives every element a zero-sized box, so `offsetParent` is null and
 * the "is it on screen" filter would reject every option. Real browsers do not
 * have this problem; the filter is what keeps a hidden menu from being read.
 */
function makeOptionsVisible(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement
    },
  })
}

function fieldFor(selector: string, label: string): FieldDescriptor {
  return harvestFields(document).find((f) => f.selector.includes(selector.replace('#', '')) || f.label === label)!
}

beforeEach(() => {
  document.body.innerHTML = ''
  makeOptionsVisible()
})

describe('a dropdown that renders nothing until it is opened', () => {
  it('reads the choices that were not in the page', async () => {
    mountSelect('gender', 'Voluntary Self-Identification of Gender', [
      'Male',
      'Female',
      'Decline to self-identify',
    ])

    const fields = harvestFields(document)
    const gender = fields.find((f) => f.label.includes('Gender'))!
    expect(gender.options).toHaveLength(0)

    const filled = await revealComboboxOptions(fields, document)

    expect(filled).toBe(1)
    expect(gender.options.map((o) => o.label)).toEqual(['Male', 'Female', 'Decline to self-identify'])
  })

  it('closes the menu again, so two are never open at once', async () => {
    mountSelect('auth', 'Are you legally authorized to work?', ['Yes', 'No'])
    await revealComboboxOptions(harvestFields(document), document)
    expect(document.getElementById('auth')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('works through every option-less dropdown on the page', async () => {
    mountSelect('a', 'Question A', ['Yes', 'No'])
    mountSelect('b', 'Question B', ['One', 'Two'])
    mountSelect('c', 'Question C', ['Red', 'Blue'])

    const fields = harvestFields(document)
    expect(await revealComboboxOptions(fields, document)).toBe(3)
  })

  it('leaves a dropdown that already listed its options alone', async () => {
    document.body.innerHTML = `
      <label for="s">Country</label>
      <select id="s"><option>India</option><option>Japan</option></select>`
    const fields = harvestFields(document)
    expect(await revealComboboxOptions(fields, document)).toBe(0)
    expect(fields[0].options).toHaveLength(2)
  })

  it('accepts a typeahead having nothing to show, rather than hanging on it', async () => {
    // A city picker backed by a search API shows results only once you type.
    mountSelect('city', 'Location (City)', ['Indore, India'], { onType: true })
    const fields = harvestFields(document)
    expect(await revealComboboxOptions(fields, document)).toBe(0)
    expect(fields.find((f) => f.label.includes('City'))?.options).toEqual([])
  })

  it('carries on when one widget cannot even be found', async () => {
    mountSelect('good', 'Good question', ['Yes', 'No'])
    const fields = harvestFields(document)
    fields.unshift({ ...fields[0], selector: '#gone-from-the-page', label: 'Missing', options: [] })

    await expect(revealComboboxOptions(fields, document)).resolves.toBe(1)
  })

  it('does not choke on a selector the browser will not parse', async () => {
    mountSelect('fine', 'Fine question', ['Yes'])
    const fields = harvestFields(document)
    fields.unshift({ ...fields[0], selector: '###', label: 'Broken', options: [] })

    await expect(revealComboboxOptions(fields, document)).resolves.toBe(1)
  })

  it('does not read the container as one giant option', async () => {
    mountSelect('nested', 'Nested question', ['Yes', 'No'])
    const fields = harvestFields(document)
    await revealComboboxOptions(fields, document)
    const options = fields.find((f) => f.label.includes('Nested'))!.options
    expect(options.every((o) => o.label.length < 20)).toBe(true)
  })
})
