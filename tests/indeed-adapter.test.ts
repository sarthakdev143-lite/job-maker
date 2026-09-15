/**
 * The Indeed Easy Apply wizard adapter.
 *
 * Every URL and selector asserted here was read off a real Indeed application
 * walked end to end in a signed-in browser, not inferred. That distinction
 * matters: the first version of this adapter was written from plausible-looking
 * markup and got the submit button, the continue button and the step paths all
 * wrong, which would have produced a night of applications that filled forms
 * and submitted nothing.
 *
 * The safety property under test is narrow and important. Indeed's wizard is
 * driven by continue buttons that sit in the same place as the final submit,
 * so if the runner can be persuaded to treat an early step as the last one it
 * clicks continue, sees no confirmation, and records a "submitted but not
 * confirmed" application -- having sent nothing while burning a slot in the
 * daily count and marking the job handled so it is never retried.
 */

import { describe, expect, it } from 'vitest'
import { classifyApplyStep, indeedAdapter, isSmartApply } from '@/sites/indeed'
import { adapterForUrl } from '@/sites/registry'

const BASE = 'https://smartapply.indeed.com/beta/indeedapply'

function doc(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
}

describe('classifyApplyStep', () => {
  // Observed on a real application, in this order.
  it.each([
    [`${BASE}/form/resume-selection-module/resume-selection`, 'resume'],
    [`${BASE}/form/questions-module/questions/1`, 'questions'],
    [`${BASE}/form/resume-module/profile-education`, 'resume'],
    [`${BASE}/form/resume-module/profile-work-experience`, 'resume'],
    [`${BASE}/form/resume-module/profile-work-experience/create`, 'resume'],
    [`${BASE}/form/review-module`, 'review'],
    [`${BASE}/post-apply`, 'submitted'],
  ])('reads %s as the %s step', (url, expected) => {
    expect(classifyApplyStep(url)).toBe(expected)
  })

  it('treats the entry redirect as a middle step rather than anything final', () => {
    expect(classifyApplyStep(`${BASE}/applybyapplyablejobid`)).toBe('other')
  })

  it('treats an unfamiliar step as a middle step, not as the final one', () => {
    // The safe default: fill it and press continue, never submit.
    expect(classifyApplyStep(`${BASE}/form/employer-quiz`)).toBe('other')
  })

  it('does not mistake a mid-flow profile-review page for the final review', () => {
    // Regression: a bare /review/ test matched these, which would have let the
    // runner press submit on a step that only confirms saved profile details.
    expect(classifyApplyStep(`${BASE}/form/resume-module/profile-review`)).not.toBe('review')
    expect(classifyApplyStep(`${BASE}/form/resume-module/review-education`)).not.toBe('review')
  })

  it('classifies the confirmation screen before anything else in the path', () => {
    // A confirmation URL that also contains "review" must not read as review,
    // or the runner would try to submit an application already sent.
    expect(classifyApplyStep(`${BASE}/review-module/post-apply`)).toBe('submitted')
  })

  it('does not throw on a malformed URL', () => {
    expect(() => classifyApplyStep('not a url')).not.toThrow()
    expect(classifyApplyStep('not a url')).toBe('other')
  })
})

describe('isSmartApply', () => {
  it('recognises the Indeed-hosted form', () => {
    expect(isSmartApply(`${BASE}/form/review-module`)).toBe(true)
  })

  it('does not mistake a job advert for a form', () => {
    expect(isSmartApply('https://www.indeed.com/viewjob?jk=abc123')).toBe(false)
    expect(isSmartApply('https://in.indeed.com/jobs?q=engineer')).toBe(false)
  })
})

describe('indeedAdapter.canSubmit', () => {
  const continueOnly = '<button data-testid="continue-button">Continue</button>'

  it.each([
    `${BASE}/form/resume-selection-module/resume-selection`,
    `${BASE}/form/questions-module/questions/1`,
    `${BASE}/form/resume-module/profile-education`,
    `${BASE}/form/resume-module/profile-work-experience`,
  ])('refuses to submit on %s', (url) => {
    expect(indeedAdapter.canSubmit?.(doc(continueOnly), url)).toBe(false)
  })

  it('allows submission on the real review step', () => {
    expect(indeedAdapter.canSubmit?.(doc(continueOnly), `${BASE}/form/review-module`)).toBe(true)
  })

  it('recognises the actual submit label, possessive and all', () => {
    // Verified live: the button reads "Submit your application", which an
    // exact-match pattern missed.
    const html = '<button data-testid="submit-application-button">Submit your application</button>'
    expect(indeedAdapter.canSubmit?.(doc(html), `${BASE}/form/questions-module/questions/1`)).toBe(true)
  })

  it('is not fooled by a button that merely mentions submitting elsewhere', () => {
    const html = '<button>Continue</button><p>You will submit your application on the next screen</p>'
    expect(indeedAdapter.canSubmit?.(doc(html), `${BASE}/form/resume-selection-module/resume-selection`)).toBe(false)
  })
})

describe('verified live selectors', () => {
  // These exact strings were read off a real application. If Indeed changes
  // them these tests fail until someone looks, which is the point.
  it('targets the real submit button', () => {
    expect(indeedAdapter.submitSelectors).toContain('button[data-testid="submit-application-button"]')
  })

  it('targets the real continue buttons, including the per-page suffixed ones', () => {
    expect(indeedAdapter.nextStepSelectors).toContain('button[data-testid="continue-button"]')
    expect(indeedAdapter.nextStepSelectors).toContain('button[data-testid$="-continue-button"]')
  })

  it('keeps a skip control, the only way past a profile step Indeed itself rejects', () => {
    expect(indeedAdapter.skipSelectors).toContain('button[data-testid$="-skip-button"]')
  })

  it('finds the apply entry by id, since its test id carries a -test suffix', () => {
    expect(indeedAdapter.applyEntrySelectors).toContain('#indeedApplyButton')
    expect(indeedAdapter.applyEntrySelectors).toContain('[data-testid^="indeedApplyButton"]')
  })

  it('never lists a bare continue button as something that submits', () => {
    // The wizard's continue controls must never appear in submitSelectors: the
    // review-step gate is a second line of defence, not the only one.
    for (const sel of indeedAdapter.submitSelectors) {
      expect(sel).not.toMatch(/continue/i)
    }
  })
})

describe('indeedAdapter.detect', () => {
  it('treats a job advert as not-yet-a-form so the runner clicks apply first', () => {
    const result = indeedAdapter.detect(
      doc('<h1>Senior Engineer</h1><button id="indeedApplyButton">Apply with Indeed</button>'),
      'https://www.indeed.com/viewjob?jk=abc'
    )
    expect(result.isApplicationForm).toBe(false)
    expect(result.detail).toMatch(/advert/i)
  })

  it('notes when an advert offers Easy Apply, which is the cheap path', () => {
    const result = indeedAdapter.detect(
      doc('<button id="indeedApplyButton">Apply with Indeed</button>'),
      'https://www.indeed.com/viewjob?jk=abc'
    )
    expect(result.detail).toMatch(/easy apply/i)
  })

  it('recognises a form step with inputs', () => {
    const result = indeedAdapter.detect(
      doc('<textarea name="q_8387e7a64916ce70"></textarea>'),
      `${BASE}/form/questions-module/questions/1`
    )
    expect(result.isApplicationForm).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.5)
  })

  it('counts the review step as part of the application even with no inputs', () => {
    const result = indeedAdapter.detect(doc('<h2>Review your application</h2>'), `${BASE}/form/review-module`)
    expect(result.isApplicationForm).toBe(true)
  })

  it('always reports the flow as multi-step', () => {
    const result = indeedAdapter.detect(doc('<input name="a">'), `${BASE}/form/resume-selection-module/x`)
    expect(result.multiStep).toBe(true)
  })
})

describe('registry wiring', () => {
  it.each([
    'https://www.indeed.com/viewjob?jk=abc',
    'https://in.indeed.com/jobs?q=engineer',
    `${BASE}/form/review-module`,
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

  it('returns null for a screening question only the model can answer', () => {
    // The real one observed: "Share a link to a feature or substantial project
    // you personally shipped".
    expect(indeedAdapter.canonicalKey?.(field({ label: 'Share a link to a project you shipped' }))).toBeNull()
  })
})
