/**
 * The Indeed Easy Apply wizard adapter.
 *
 * The safety property under test is narrow and important: Indeed drives every
 * step of its wizard with one button, `ia-continueButton`, relabelled per step.
 * If the runner can be persuaded to treat an early step as the final one it
 * clicks continue, sees no confirmation, and records a "submitted but not
 * confirmed" application -- having sent nothing at all while burning a slot in
 * the daily count and, worse, marking the job as handled so it is never retried.
 *
 * So: submission is allowed on the review step and nowhere else, unless a
 * button literally says it submits.
 */

import { describe, expect, it } from 'vitest'
import { classifyApplyStep, indeedAdapter, isSmartApply } from '@/sites/indeed'
import { adapterForUrl } from '@/sites/registry'

function doc(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
}

describe('classifyApplyStep', () => {
  it.each([
    ['https://smartapply.indeed.com/beta/indeedapply/form/contact-info', 'contact'],
    ['https://smartapply.indeed.com/beta/indeedapply/form/resume', 'resume'],
    ['https://smartapply.indeed.com/beta/indeedapply/form/documents', 'resume'],
    ['https://smartapply.indeed.com/beta/indeedapply/form/questions', 'questions'],
    ['https://smartapply.indeed.com/beta/indeedapply/form/qualification-questions', 'questions'],
    ['https://smartapply.indeed.com/beta/indeedapply/form/review', 'review'],
    ['https://smartapply.indeed.com/beta/indeedapply/post-apply', 'submitted'],
  ])('reads %s as the %s step', (url, expected) => {
    expect(classifyApplyStep(url)).toBe(expected)
  })

  it('treats an unfamiliar step as a middle step, not as the final one', () => {
    // The safe default: fill it and press continue, never submit.
    expect(classifyApplyStep('https://smartapply.indeed.com/beta/indeedapply/form/employer-quiz')).toBe('other')
  })

  it('classifies the confirmation screen before anything else in the path', () => {
    // A confirmation URL that also contains "review" must not read as review,
    // or the runner would try to submit an application already sent.
    expect(classifyApplyStep('https://smartapply.indeed.com/beta/review/post-apply')).toBe('submitted')
  })

  it('does not throw on a malformed URL', () => {
    expect(() => classifyApplyStep('not a url')).not.toThrow()
    expect(classifyApplyStep('not a url')).toBe('other')
  })
})

describe('isSmartApply', () => {
  it('recognises the Indeed-hosted form', () => {
    expect(isSmartApply('https://smartapply.indeed.com/beta/indeedapply/form/resume')).toBe(true)
  })

  it('does not mistake a job advert for a form', () => {
    expect(isSmartApply('https://www.indeed.com/viewjob?jk=abc123')).toBe(false)
    expect(isSmartApply('https://in.indeed.com/jobs?q=engineer')).toBe(false)
  })
})

describe('indeedAdapter.canSubmit', () => {
  const continueOnly = '<button data-testid="ia-continueButton">Continue</button>'

  it.each([
    'https://smartapply.indeed.com/beta/indeedapply/form/contact-info',
    'https://smartapply.indeed.com/beta/indeedapply/form/resume',
    'https://smartapply.indeed.com/beta/indeedapply/form/questions',
  ])('refuses to submit on the %s step', (url) => {
    expect(indeedAdapter.canSubmit?.(doc(continueOnly), url)).toBe(false)
  })

  it('allows submission on the review step', () => {
    const url = 'https://smartapply.indeed.com/beta/indeedapply/form/review'
    expect(indeedAdapter.canSubmit?.(doc(continueOnly), url)).toBe(true)
  })

  it('allows submission wherever a button genuinely says it submits', () => {
    const url = 'https://smartapply.indeed.com/beta/indeedapply/form/questions'
    const html = '<button data-testid="ia-continueButton">Submit your application</button>'
    expect(indeedAdapter.canSubmit?.(doc(html), url)).toBe(true)
  })

  it('is not fooled by a button that merely mentions submitting elsewhere', () => {
    const url = 'https://smartapply.indeed.com/beta/indeedapply/form/contact-info'
    const html = '<button>Continue</button><p>You will submit your application on the next screen</p>'
    expect(indeedAdapter.canSubmit?.(doc(html), url)).toBe(false)
  })
})

describe('indeedAdapter.detect', () => {
  it('treats a job advert as not-yet-a-form so the runner clicks apply first', () => {
    const result = indeedAdapter.detect(
      doc('<h1>Senior Engineer</h1><button id="indeedApplyButton">Apply now</button>'),
      'https://www.indeed.com/viewjob?jk=abc'
    )
    expect(result.isApplicationForm).toBe(false)
    expect(result.detail).toMatch(/advert/i)
  })

  it('recognises a form step with inputs', () => {
    const result = indeedAdapter.detect(
      doc('<input name="firstName"><input name="email">'),
      'https://smartapply.indeed.com/beta/indeedapply/form/contact-info'
    )
    expect(result.isApplicationForm).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.5)
  })

  it('counts the review step as part of the application even with no inputs', () => {
    const result = indeedAdapter.detect(
      doc('<h2>Review your application</h2>'),
      'https://smartapply.indeed.com/beta/indeedapply/form/review'
    )
    expect(result.isApplicationForm).toBe(true)
  })

  it('always reports the flow as multi-step', () => {
    const result = indeedAdapter.detect(doc('<input name="a">'), 'https://smartapply.indeed.com/beta/x/form/resume')
    expect(result.multiStep).toBe(true)
  })
})

describe('registry wiring', () => {
  it.each([
    'https://www.indeed.com/viewjob?jk=abc',
    'https://in.indeed.com/jobs?q=engineer',
    'https://smartapply.indeed.com/beta/indeedapply/form/review',
  ])('routes %s to the Indeed adapter', (url) => {
    expect(adapterForUrl(url).id).toBe('indeed')
  })

  it('does not capture unrelated hosts that merely contain the word', () => {
    expect(adapterForUrl('https://notindeed.example.com/jobs').id).not.toBe('indeed')
    expect(adapterForUrl('https://indeed.com.evil.test/jobs').id).not.toBe('indeed')
  })
})

describe('indeedAdapter.canonicalKey', () => {
  const field = (over: Record<string, string>) =>
    ({ id: '', name: '', label: '', selector: '', kind: 'text', ...over }) as never

  it.each([
    [{ id: 'input-firstName' }, 'firstName'],
    [{ name: 'lastName' }, 'lastName'],
    [{ label: 'Email address' }, 'email'],
    [{ label: 'Mobile number' }, 'phone'],
    [{ label: 'LinkedIn profile' }, 'linkedin'],
    [{ label: 'PIN code' }, 'postalCode'],
  ])('maps %o to %s', (over, expected) => {
    expect(indeedAdapter.canonicalKey?.(field(over))).toBe(expected)
  })

  it('returns null for a question only the model can answer', () => {
    expect(indeedAdapter.canonicalKey?.(field({ label: 'Why do you want this role?' }))).toBeNull()
  })
})
