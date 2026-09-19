/**
 * Regressions found by driving live ATS forms.
 *
 * Every case here is a bug that the fixture tests passed straight over and a
 * real application form caught. On a live Greenhouse posting, six of thirteen
 * fields -- three of them mandatory -- silently refused every value, and the
 * causes were four distinct defects stacked on top of each other:
 *
 *   1. a react-select `<input role="combobox">` was classified as plain text;
 *   2. clicking an option focused it, which blurred the search input and closed
 *      the menu before the click landed;
 *   3. a successful selection reads back as an empty input, because the widget
 *      shows the choice elsewhere -- so correct answers were reported failed;
 *   4. "India" never matched an option reading "India +91".
 *
 * The fake widgets below are deliberately faithful to the real markup.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { harvestFields } from '@/form/harvester'
import { applyFillPlan } from '@/form/filler'
import { humanClick } from '@/human/pointer'
import { seededRng } from '@/human/rng'
import type { FilledField } from '@/storage/schemas'

function plan(selector: string, label: string, kind: string, value: string): FilledField {
  return {
    selector, label, kind, value,
    confidence: 1, source: 'profile', reasoning: '', verified: false, error: '', required: true,
  }
}

/** A react-select lookalike: the input is a search box, not the value. */
function mountReactSelect(options: string[]): void {
  document.body.innerHTML = `
    <div class="select__control">
      <div class="select__value-container">
        <div class="select__input-container">
          <input id="country" class="select__input" type="text" role="combobox"
                 aria-autocomplete="list" aria-expanded="false" aria-haspopup="true"
                 aria-labelledby="country-label" aria-required="true" />
        </div>
      </div>
    </div>
    <label id="country-label" for="country">Country</label>
    <div class="select__menu" id="menu"></div>`

  const input = document.getElementById('country') as HTMLInputElement
  const menu = document.getElementById('menu') as HTMLElement
  const control = document.querySelector('.select__control') as HTMLElement

  const render = (): void => {
    const q = input.value.toLowerCase()
    menu.innerHTML = ''
    for (const label of options.filter((o) => o.toLowerCase().includes(q))) {
      const opt = document.createElement('div')
      opt.className = 'select__option'
      opt.setAttribute('role', 'option')
      // The real widget sets this, and focusing it is what used to break us.
      opt.setAttribute('tabindex', '-1')
      opt.textContent = label
      opt.addEventListener('mousedown', () => {
        // Selection clears the search box and shows the choice separately.
        input.value = ''
        menu.innerHTML = ''
        input.setAttribute('aria-expanded', 'false')
        const shown = document.createElement('div')
        shown.className = 'select__single-value'
        shown.textContent = label
        control.querySelector('.select__value-container')?.prepend(shown)
      })
      menu.appendChild(opt)
    }
  }

  control.addEventListener('mousedown', () => {
    input.setAttribute('aria-expanded', 'true')
    render()
  })
  input.addEventListener('input', render)
  // The menu closes when the search input loses focus, exactly as it does live.
  input.addEventListener('blur', () => {
    menu.innerHTML = ''
    input.setAttribute('aria-expanded', 'false')
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('harvesting a custom dropdown', () => {
  it('classifies an input with role=combobox as a combobox, not text', () => {
    mountReactSelect(['India +91'])
    const field = harvestFields(document).find((f) => f.selector === '#country')
    expect(field?.kind).toBe('combobox')
  })

  it('also trusts aria-autocomplete when the role is missing', () => {
    document.body.innerHTML = `<label for="c">City</label>
      <input id="c" type="text" aria-autocomplete="list" aria-expanded="false" />`
    const field = harvestFields(document).find((f) => f.selector === '#c')
    expect(field?.kind).toBe('combobox')
  })

  it('leaves a genuine text input alone', () => {
    document.body.innerHTML = `<label for="t">First Name</label><input id="t" type="text" />`
    expect(harvestFields(document).find((f) => f.selector === '#t')?.kind).toBe('text')
  })

  it('never treats a checkbox or file input as a dropdown', () => {
    document.body.innerHTML = `
      <label for="a">Agree</label><input id="a" type="checkbox" role="combobox" />
      <label for="r">Resume</label><input id="r" type="file" aria-autocomplete="list" />`
    const fields = harvestFields(document)
    expect(fields.find((f) => f.selector === '#a')?.kind).toBe('checkbox')
    expect(fields.find((f) => f.selector === '#r')?.kind).toBe('file')
  })
})

describe('humanClick focus behaviour', () => {
  it('does not move focus to a tabindex="-1" menu option', async () => {
    document.body.innerHTML = `<input id="search" /><div id="opt" tabindex="-1">India +91</div>`
    const search = document.getElementById('search') as HTMLInputElement
    const opt = document.getElementById('opt') as HTMLElement
    search.focus()

    await humanClick(opt, { pressMs: { min: 1, max: 2 }, scroll: false }, seededRng(1))

    expect(document.activeElement).toBe(search)
  })

  it('still focuses a real control', async () => {
    document.body.innerHTML = `<button id="b">Apply</button>`
    const btn = document.getElementById('b') as HTMLButtonElement
    await humanClick(btn, { pressMs: { min: 1, max: 2 }, scroll: false }, seededRng(1))
    expect(document.activeElement).toBe(btn)
  })
})

describe('filling a react-select dropdown end to end', () => {
  it('opens it, types, picks the option and reports it verified', async () => {
    mountReactSelect(['India +91', 'British Indian Ocean Territory +246', 'Indonesia +62'])

    const out = await applyFillPlan([plan('#country', 'Country', 'combobox', 'India')], { min: 1, max: 2 })

    expect(out.failed).toEqual([])
    expect(out.filled).toHaveLength(1)
    // A prefix match, which scores too low to survive the fuzzy threshold.
    expect(document.querySelector('.select__single-value')?.textContent).toBe('India +91')
  })

  it('picks the closest match, not the first one that happens to start right', async () => {
    // A real application went out with "Indianapolis, Indiana, United States"
    // in the location field because the agent typed "India" and took whichever
    // prefix match the DOM offered first.
    mountReactSelect(['Indianapolis, Indiana, United States', 'India', 'Indiana, United States'])

    const out = await applyFillPlan([plan('#country', 'Location', 'combobox', 'India')], { min: 1, max: 2 })

    expect(out.failed).toEqual([])
    expect(document.querySelector('.select__single-value')?.textContent).toBe('India')
  })

  it('verifies a selection the widget reformats beyond recognition', async () => {
    // The live country picker answers "India" by displaying "+91".
    mountReactSelect(['India'])
    const shown = () => document.querySelector('.select__single-value')?.textContent
    const out = await applyFillPlan([plan('#country', 'Country', 'combobox', 'India')], { min: 1, max: 2 })
    expect(shown()).toBe('India')
    expect(out.filled).toHaveLength(1)
  })
})

describe('a picker wearing a text input costume', () => {
  it('recovers when a typed value is discarded on blur', async () => {
    // Lever's location field: no ARIA at all, and it throws away anything that
    // was not chosen from its dropdown.
    document.body.innerHTML = `
      <label for="location-input">Current location</label>
      <input id="location-input" class="location-input" type="text" name="location" />
      <div class="dropdown-results" id="results"></div>`
    const input = document.getElementById('location-input') as HTMLInputElement
    const results = document.getElementById('results') as HTMLElement

    input.addEventListener('input', () => {
      results.innerHTML = ''
      if (!input.value) return
      const item = document.createElement('div')
      item.className = 'break-word dropdown-location width-full'
      item.textContent = `${input.value}, Karnataka, India`
      item.addEventListener('mousedown', () => {
        input.value = item.textContent ?? ''
        input.dataset.chosen = 'yes'
        results.innerHTML = ''
      })
      results.appendChild(item)
    })
    // Free text is discarded unless a suggestion was taken.
    input.addEventListener('blur', () => {
      if (input.dataset.chosen !== 'yes') input.value = ''
    })

    const out = await applyFillPlan(
      [plan('#location-input', 'Current location', 'text', 'Bengaluru')],
      { min: 1, max: 2 }
    )

    expect(out.failed).toEqual([])
    expect(input.value).toBe('Bengaluru, Karnataka, India')
  })
})

describe('a multi-select question rendered as checkboxes', () => {
  it('ticks the matching box instead of reporting an empty question as filled', async () => {
    // Greenhouse renders every "multi select" question this way. Sent through
    // the boolean checkbox writer, "Python" is not a truthy string, so nothing
    // was ticked and `checked === want` reported success -- a required answer
    // left blank and sworn to be filled.
    document.body.innerHTML = `
      <fieldset>
        <legend>Which programming languages can you independently read?</legend>
        <label for="q1"><input type="checkbox" id="q1" name="question_1[]" value="1" /> Python</label>
        <label for="q2"><input type="checkbox" id="q2" name="question_1[]" value="2" /> Rust</label>
        <label for="q3"><input type="checkbox" id="q3" name="question_1[]" value="3" /> Go</label>
      </fieldset>`

    const field = { ...plan('#q1', 'Which programming languages can you independently read?', 'checkbox', 'Python'), group: 'question_1[]' }
    const out = await applyFillPlan([field as FilledField], { min: 1, max: 2 })

    expect(out.failed).toEqual([])
    expect((document.getElementById('q1') as HTMLInputElement).checked).toBe(true)
    expect((document.getElementById('q2') as HTMLInputElement).checked).toBe(false)
  })

  it('ticks several boxes when the answer names more than one', async () => {
    document.body.innerHTML = `
      <label for="a"><input type="checkbox" id="a" name="langs[]" /> Python</label>
      <label for="b"><input type="checkbox" id="b" name="langs[]" /> Rust</label>
      <label for="c"><input type="checkbox" id="c" name="langs[]" /> Go</label>`

    const field = { ...plan('#a', 'Languages', 'checkbox', 'Python, Go'), group: 'langs[]' }
    await applyFillPlan([field as FilledField], { min: 1, max: 2 })

    expect((document.getElementById('a') as HTMLInputElement).checked).toBe(true)
    expect((document.getElementById('c') as HTMLInputElement).checked).toBe(true)
    expect((document.getElementById('b') as HTMLInputElement).checked).toBe(false)
  })

  it('still treats a lone consent checkbox as a yes/no', async () => {
    document.body.innerHTML = `<label for="ack"><input type="checkbox" id="ack" name="ack" /> I agree</label>`
    await applyFillPlan([plan('#ack', 'I agree', 'checkbox', 'true')], { min: 1, max: 2 })
    expect((document.getElementById('ack') as HTMLInputElement).checked).toBe(true)
  })
})

describe('a form that refuses in prose', () => {
  it('captures the refusal as a problem rather than leaving the page silent', async () => {
    // Greenhouse answers a submission its bot check dislikes with this line, in
    // a plain node matching no error selector. The run used to report only
    // "no signal: still on /jobs/123", which told the user nothing.
    const { outlinePage } = await import('@/form/outline')
    document.body.innerHTML = `
      <h1>Staff Engineer</h1>
      <form><button type="submit">Submit application</button></form>
      <div>There was an error processing your application. Please try again.</div>`

    const outline = outlinePage(document, 'https://job-boards.greenhouse.io/acme/jobs/1')

    expect(outline.problems?.some((p) => /error processing your application/i.test(p))).toBe(true)
  })

  it('says nothing when the page is not complaining', async () => {
    const { outlinePage } = await import('@/form/outline')
    document.body.innerHTML = `<h1>Thanks for applying</h1><p>Your application has been submitted.</p>`
    expect(outlinePage(document, 'https://example.com/x').problems ?? []).toEqual([])
  })
})
