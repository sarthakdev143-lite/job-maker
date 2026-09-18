/**
 * The model fallback is allowed to click things, so what it refuses matters
 * more than what it accepts.
 *
 * Every test here is about a way the fallback could do damage: clicking a
 * button the model was not sure about, clicking one that does not exist,
 * clicking a disabled control, or recording a submission that never happened.
 * The happy path is one test; the rest are the guard rails.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  APPLY_CONTROL_THRESHOLD,
  findApplyControl,
  findNextControl,
  NEXT_CONTROL_THRESHOLD,
  readSubmissionState,
  SUBMISSION_THRESHOLD,
} from '@/form/page-reasoner'
import type { PageOutline } from '@/form/outline'

const answers: { value: unknown } = { value: null }

vi.mock('@/llm/broker', () => ({
  llm: {
    completeStructured: vi.fn(async () => answers.value),
  },
}))

function outline(elements: PageOutline['elements']): PageOutline {
  return {
    url: 'https://careers.example.com/jobs/1',
    title: 'Senior Engineer',
    headings: ['Senior Engineer'],
    elements,
    text: 'We are hiring.',
    truncated: false,
  }
}

const APPLY = { ref: 1, role: 'button', text: 'Apply for this job', selector: '#apply' }
const SAVE = { ref: 2, role: 'button', text: 'Save job', selector: '#save' }

beforeEach(() => {
  answers.value = null
})

describe('findApplyControl', () => {
  it('returns the selector of the control the model chose', async () => {
    answers.value = { ref: 1, confidence: 0.92, reasoning: 'it says apply' }
    const result = await findApplyControl(outline([APPLY, SAVE]), { title: 'Senior Engineer', company: 'Example' })
    expect(result.selector).toBe('#apply')
    expect(result.text).toBe('Apply for this job')
  })

  it('returns nothing for ref 0, which is the model saying there is none', async () => {
    answers.value = { ref: 0, confidence: 0.9, reasoning: 'this listing has expired' }
    const result = await findApplyControl(outline([SAVE]), null)
    expect(result.selector).toBe('')
    expect(result.reasoning).toContain('expired')
  })

  it('refuses a reference that is not in the outline', async () => {
    // A small model will happily answer 7 when it was shown two controls.
    // Turning that into a selector means clicking something nobody chose.
    answers.value = { ref: 7, confidence: 0.99, reasoning: 'confident nonsense' }
    const result = await findApplyControl(outline([APPLY, SAVE]), null)
    expect(result.selector).toBe('')
  })

  it('refuses a disabled control', async () => {
    answers.value = { ref: 1, confidence: 0.95, reasoning: 'looks like apply' }
    const result = await findApplyControl(outline([{ ...APPLY, disabled: true }]), null)
    expect(result.selector).toBe('')
    expect(result.reasoning).toMatch(/disabled/)
  })

  it('does not call the model for a page with nothing on it', async () => {
    const result = await findApplyControl(outline([]), null)
    expect(result.selector).toBe('')
    expect(result.reasoning).toMatch(/nothing interactive/)
  })

  it('reports confidence so the caller can refuse a guess', async () => {
    // The threshold is enforced by the caller, not here -- but the number has
    // to survive, or there is nothing to enforce it with.
    answers.value = { ref: 1, confidence: 0.4, reasoning: 'might be apply' }
    const result = await findApplyControl(outline([APPLY]), null)
    expect(result.confidence).toBeLessThan(APPLY_CONTROL_THRESHOLD)
    expect(result.selector).toBe('#apply')
  })
})

describe('readSubmissionState', () => {
  it('confirms a submission only above the threshold', async () => {
    answers.value = { state: 'submitted', confidence: 0.95, evidence: 'Application received' }
    expect((await readSubmissionState(outline([]))).submitted).toBe(true)

    answers.value = { state: 'submitted', confidence: SUBMISSION_THRESHOLD - 0.01, evidence: 'maybe' }
    // Recording a submission that did not happen silently drops a job the user
    // wanted. Failing to record one that did costs a review. The bar is high on
    // purpose.
    expect((await readSubmissionState(outline([]))).submitted).toBe(false)
  })

  it('passes a rejection through as its own state', async () => {
    answers.value = { state: 'rejected', confidence: 0.9, evidence: 'Email is required' }
    const reading = await readSubmissionState(outline([]))
    expect(reading.state).toBe('rejected')
    expect(reading.submitted).toBe(false)
    expect(reading.evidence).toBe('Email is required')
  })

  it('treats an unrecognised state as not submitted', async () => {
    answers.value = { state: 'banana', confidence: 1, evidence: '' }
    expect((await readSubmissionState(outline([]))).submitted).toBe(false)
  })

  it('is case insensitive, because a model will answer "Submitted"', async () => {
    answers.value = { state: 'Submitted', confidence: 0.99, evidence: 'Thanks!' }
    expect((await readSubmissionState(outline([]))).submitted).toBe(true)
  })
})

describe('findNextControl', () => {
  const CONTINUE = { ref: 1, role: 'button', text: 'Continue', selector: '#continue' }
  const SEND = { ref: 2, role: 'button', text: 'Submit application', selector: '#send' }

  it('returns the control that moves the form on', async () => {
    answers.value = { ref: 1, confidence: 0.9, submits: false, reasoning: 'next step' }
    const next = await findNextControl(outline([CONTINUE, SEND]), 7)
    expect(next.selector).toBe('#continue')
    expect(next.submits).toBe(false)
  })

  it('reports when the control would submit rather than continue', async () => {
    // The caller refuses these. A wizard step that turns out to be the send
    // button would walk straight past the autonomy gate, which on a dry run
    // means sending an application the user asked not to send.
    answers.value = { ref: 2, confidence: 0.95, submits: true, reasoning: 'this sends it' }
    const next = await findNextControl(outline([CONTINUE, SEND]), 7)
    expect(next.submits).toBe(true)
  })

  it('refuses a reference that is not in the outline', async () => {
    answers.value = { ref: 99, confidence: 0.99, submits: false, reasoning: 'nonsense' }
    expect((await findNextControl(outline([CONTINUE]), 3)).selector).toBe('')
  })

  it('refuses a disabled control', async () => {
    answers.value = { ref: 1, confidence: 0.99, submits: false, reasoning: 'continue' }
    expect((await findNextControl(outline([{ ...CONTINUE, disabled: true }]), 3)).selector).toBe('')
  })

  it('does not call the model for an empty page', async () => {
    const next = await findNextControl(outline([]), 0)
    expect(next.selector).toBe('')
    expect(next.reasoning).toMatch(/nothing interactive/)
  })

  it('carries confidence so a guess can be refused', async () => {
    answers.value = { ref: 1, confidence: 0.2, submits: false, reasoning: 'maybe' }
    expect((await findNextControl(outline([CONTINUE]), 3)).confidence).toBeLessThan(NEXT_CONTROL_THRESHOLD)
  })
})
