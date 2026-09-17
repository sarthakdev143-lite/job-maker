/**
 * Workday's bottom-navigation button reads "Next" on every wizard page and
 * "Submit" only on the last -- under one shared selector. Selector presence
 * therefore cannot authorize submission: without a label check the runner
 * broke out of the wizard after page one and clicked Next as if it were
 * Submit, parking every Workday application as a validation error.
 */

import { describe, expect, it } from 'vitest'
import { workdayAdapter } from '@/sites/workday'

function doc(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
}

describe('workday canSubmit', () => {
  it('refuses a Next-labelled navigation button', () => {
    const d = doc('<button data-automation-id="bottom-navigation-next-button">Next</button>')
    expect(workdayAdapter.canSubmit?.(d, 'https://acme.myworkdayjobs.com/en-US/Careers/apply')).toBe(false)
  })

  it('authorizes a Submit-labelled navigation button', () => {
    const d = doc('<button data-automation-id="bottom-navigation-next-button">Submit</button>')
    expect(workdayAdapter.canSubmit?.(d, 'https://acme.myworkdayjobs.com/en-US/Careers/apply')).toBe(true)
  })

  it('authorizes the dedicated submit button', () => {
    const d = doc('<button data-automation-id="submitButton">Submit Application</button>')
    expect(workdayAdapter.canSubmit?.(d, 'https://acme.myworkdayjobs.com/en-US/Careers/apply')).toBe(true)
  })

  it('refuses when no navigation control is present at all', () => {
    const d = doc('<div>some content</div>')
    expect(workdayAdapter.canSubmit?.(d, 'https://acme.myworkdayjobs.com/en-US/Careers/apply')).toBe(false)
  })
})
