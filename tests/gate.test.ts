/**
 * The gate decides whether a real employer receives an application, so it gets
 * the most thorough tests in the suite. Every check here corresponds to a way
 * the agent could otherwise embarrass its user.
 */

import { describe, expect, it } from 'vitest'
import { evaluateGate, withinActiveWindow, type GateFacts } from '@/runner/autonomy-gate'
import { AutonomySchema, type FieldDescriptor, type FilledField } from '@/storage/schemas'

function facts(overrides: Partial<GateFacts> = {}): GateFacts {
  return {
    autonomy: AutonomySchema.parse({ mode: 'gated', minMatchScore: 75, minFillConfidence: 0.85 }),
    matchScore: 90,
    fillConfidence: 0.95,
    plan: [field({ required: true })],
    unresolved: [],
    vendor: 'greenhouse',
    vendorEnabled: true,
    appliedToday: 0,
    appliedTodayOnVendor: 0,
    now: new Date('2026-01-14T10:00:00'), // a Wednesday, inside the default window
    ...overrides,
  }
}

function field(overrides: Partial<FilledField> = {}): FilledField {
  return {
    selector: '#a',
    label: 'First name',
    kind: 'text',
    value: 'Ada',
    confidence: 0.99,
    source: 'profile',
    reasoning: '',
    verified: true,
    error: '',
    required: false,
    ...overrides,
  }
}

function descriptor(overrides: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    selector: '#x',
    frameId: 0,
    kind: 'text',
    label: 'Why us?',
    normalizedLabel: 'why us',
    placeholder: '',
    name: '',
    id: '',
    required: false,
    options: [],
    currentValue: '',
    maxLength: null,
    group: '',
    ...overrides,
  }
}

describe('evaluateGate', () => {
  it('submits when everything is in order', () => {
    expect(evaluateGate(facts()).action).toBe('submit')
  })

  it('never submits in dry run mode, however good the numbers', () => {
    const decision = evaluateGate(
      facts({ autonomy: AutonomySchema.parse({ mode: 'dry_run' }), matchScore: 100, fillConfidence: 1 })
    )
    expect(decision.action).toBe('review')
  })

  it('never submits in review mode', () => {
    const decision = evaluateGate(facts({ autonomy: AutonomySchema.parse({ mode: 'review' }) }))
    expect(decision.action).toBe('review')
  })

  it('parks a job below the score threshold', () => {
    const decision = evaluateGate(facts({ matchScore: 60 }))
    expect(decision.action).toBe('review')
    expect(decision.reasons.join(' ')).toMatch(/match score/)
  })

  it('parks a form below the confidence threshold', () => {
    const decision = evaluateGate(facts({ fillConfidence: 0.5 }))
    expect(decision.action).toBe('review')
    expect(decision.reasons.join(' ')).toMatch(/confidence/)
  })

  it('parks when a required field is unanswered, even in full mode', () => {
    const decision = evaluateGate(
      facts({
        autonomy: AutonomySchema.parse({ mode: 'full' }),
        unresolved: [descriptor({ required: true, label: 'Visa status' })],
      })
    )
    expect(decision.action).toBe('review')
    expect(decision.reasons.join(' ')).toMatch(/Visa status/)
  })

  it('ignores thresholds in full mode but still checks that fields took', () => {
    expect(evaluateGate(facts({ autonomy: AutonomySchema.parse({ mode: 'full' }), matchScore: 10, fillConfidence: 0.1 })).action).toBe(
      'submit'
    )
    const withFailure = evaluateGate(
      facts({
        autonomy: AutonomySchema.parse({ mode: 'full' }),
        plan: [field({ required: true, error: 'value did not stick' })],
      })
    )
    expect(withFailure.action).toBe('review')
  })

  it('skips a site the user switched off', () => {
    const decision = evaluateGate(facts({ vendorEnabled: false }))
    expect(decision.action).toBe('skip')
  })

  it('halts the run at the global daily cap', () => {
    const decision = evaluateGate(facts({ appliedToday: 15 }))
    expect(decision.action).toBe('review')
    expect(decision.haltRun).toBe(true)
  })

  it('parks at a per-site cap without halting the whole run', () => {
    const autonomy = AutonomySchema.parse({ mode: 'gated', perSiteDailyCap: { greenhouse: 2 } })
    const decision = evaluateGate(facts({ autonomy, appliedTodayOnVendor: 2 }))
    expect(decision.action).toBe('review')
    expect(decision.haltRun).toBeUndefined()
  })

  it('refuses to run outside the active window', () => {
    const decision = evaluateGate(facts({ now: new Date('2026-01-14T03:00:00') }))
    expect(decision.action).toBe('review')
    expect(decision.haltRun).toBe(true)
  })

  it('checks caps before quality, so the message says what actually stopped it', () => {
    const decision = evaluateGate(facts({ appliedToday: 99, matchScore: 10 }))
    expect(decision.reasons.join(' ')).toMatch(/daily cap/)
  })
})

describe('withinActiveWindow', () => {
  const autonomy = AutonomySchema.parse({ activeHours: { start: 9, end: 21 }, activeDays: [1, 2, 3, 4, 5] })

  it('accepts a weekday inside the window', () => {
    expect(withinActiveWindow(autonomy, new Date('2026-01-14T10:00:00'))).toBe(true)
  })

  it('rejects a weekday outside the window', () => {
    expect(withinActiveWindow(autonomy, new Date('2026-01-14T22:00:00'))).toBe(false)
  })

  it('rejects a weekend', () => {
    expect(withinActiveWindow(autonomy, new Date('2026-01-17T10:00:00'))).toBe(false)
  })

  it('handles a window that wraps midnight', () => {
    const nightOwl = AutonomySchema.parse({ activeHours: { start: 22, end: 6 }, activeDays: [0, 1, 2, 3, 4, 5, 6] })
    expect(withinActiveWindow(nightOwl, new Date('2026-01-14T23:00:00'))).toBe(true)
    expect(withinActiveWindow(nightOwl, new Date('2026-01-14T02:00:00'))).toBe(true)
    expect(withinActiveWindow(nightOwl, new Date('2026-01-14T12:00:00'))).toBe(false)
  })

  it('treats a zero-width window as no restriction', () => {
    const always = AutonomySchema.parse({ activeHours: { start: 0, end: 0 }, activeDays: [0, 1, 2, 3, 4, 5, 6] })
    expect(withinActiveWindow(always, new Date('2026-01-14T04:00:00'))).toBe(true)
  })
})
