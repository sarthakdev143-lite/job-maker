/**
 * Recognising a multi-step form.
 *
 * Found by running the real extension against a three-step form: it filled page
 * one, declared itself finished, went looking for a submit button that lives
 * two pages later, and parked a nearly complete application as "no submit
 * control found". The generic adapter -- the one every company-hosted careers
 * page falls back to -- reported `multiStep: false` unconditionally, so the
 * runner never advanced.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { genericAdapter } from '@/sites/generic'

function mount(body: string): Document {
  document.body.innerHTML = body
  return document
}

/** Enough signal for the adapter to call it an application form at all. */
const APPLICATION_BODY = `
  <form>
    <label for="name">Full name</label><input id="name" name="name" type="text" />
    <label for="email">Email</label><input id="email" type="email" name="email" />
    <label for="cv">Upload your resume</label><input id="cv" type="file" name="resume" />
    <p>Apply for this job. Cover letter optional.</p>
  </form>`

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('generic adapter step detection', () => {
  it('sees a wizard when the page offers a Continue control', () => {
    const doc = mount(`${APPLICATION_BODY}<button type="button">Continue</button>`)
    const result = genericAdapter.detect(doc, 'https://careers.example.com/apply')
    expect(result.isApplicationForm).toBe(true)
    expect(result.multiStep).toBe(true)
  })

  it('recognises the other words sites use for the same button', () => {
    for (const label of ['Next', 'Next step', 'Save and continue', 'Proceed']) {
      const doc = mount(`${APPLICATION_BODY}<button type="button">${label}</button>`)
      expect(genericAdapter.detect(doc, 'https://careers.example.com/apply').multiStep).toBe(true)
    }
  })

  it('reads a next control rendered as a div or an input', () => {
    const asDiv = mount(`${APPLICATION_BODY}<div role="button">Continue</div>`)
    expect(genericAdapter.detect(asDiv, 'https://careers.example.com/apply').multiStep).toBe(true)

    const asInput = mount(`${APPLICATION_BODY}<input type="button" value="Next" />`)
    expect(genericAdapter.detect(asInput, 'https://careers.example.com/apply').multiStep).toBe(true)
  })

  it('leaves a single-page form alone', () => {
    const doc = mount(`${APPLICATION_BODY}<button type="submit">Submit application</button>`)
    expect(genericAdapter.detect(doc, 'https://careers.example.com/apply').multiStep).toBe(false)
  })

  it('is not fooled by a button that merely contains the word', () => {
    const doc = mount(`${APPLICATION_BODY}<button type="button">Continue reading the job description</button>`)
    expect(genericAdapter.detect(doc, 'https://careers.example.com/apply').multiStep).toBe(false)
  })
})
