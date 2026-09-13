/**
 * The active-hours window exists so unattended runs do not fire at 3am. It kept
 * blocking runs the user had just started by hand instead, which presented as
 * an agent that said "running" and did nothing.
 */

import { describe, expect, it } from 'vitest'
import { evaluateGate, withinActiveWindow, type GateFacts } from '@/runner/autonomy-gate'
import { describeNextWindow } from '@/background/orchestrator'
import { AutonomySchema, type FilledField } from '@/storage/schemas'

// A Sunday afternoon: inside the hours, outside a weekdays-only day list.
const SUNDAY_AFTERNOON = new Date('2026-09-13T16:35:00')

function field(): FilledField {
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
    required: true,
  }
}

function facts(overrides: Partial<GateFacts> = {}): GateFacts {
  return {
    autonomy: AutonomySchema.parse({ mode: 'gated', activeDays: [1, 2, 3, 4, 5] }),
    matchScore: 90,
    fillConfidence: 0.95,
    plan: [field()],
    unresolved: [],
    vendor: 'greenhouse',
    vendorEnabled: true,
    appliedToday: 0,
    appliedTodayOnVendor: 0,
    now: SUNDAY_AFTERNOON,
    ...overrides,
  }
}

describe('the gate and the active-hours window', () => {
  it('halts a scheduled run outside the window', () => {
    const decision = evaluateGate(facts())
    expect(decision.action).toBe('review')
    expect(decision.haltRun).toBe(true)
    expect(decision.reasons.join(' ')).toMatch(/active hours/)
  })

  it('lets a run the user started by hand through the same window', () => {
    const decision = evaluateGate(facts({ ignoreActiveHours: true }))
    expect(decision.action).toBe('submit')
  })

  it('still enforces the daily cap on a manual run', () => {
    const decision = evaluateGate(facts({ ignoreActiveHours: true, appliedToday: 15 }))
    expect(decision.action).toBe('review')
    expect(decision.reasons.join(' ')).toMatch(/daily cap/)
  })

  it('still enforces quality thresholds on a manual run', () => {
    const decision = evaluateGate(facts({ ignoreActiveHours: true, matchScore: 10 }))
    expect(decision.action).toBe('review')
    expect(decision.reasons.join(' ')).toMatch(/match score/)
  })
})

describe('the default schedule', () => {
  it('covers every day, so installing at the weekend does not look broken', () => {
    const autonomy = AutonomySchema.parse({})
    expect(withinActiveWindow(autonomy, SUNDAY_AFTERNOON)).toBe(true)
  })
})

describe('describeNextWindow', () => {
  it('names the next day the window opens', () => {
    const weekdays = AutonomySchema.parse({ activeDays: [1, 2, 3, 4, 5], activeHours: { start: 9, end: 21 } })
    expect(describeNextWindow(weekdays, SUNDAY_AFTERNOON)).toBe('tomorrow at 09:00')
  })

  it('says today when the window has not opened yet', () => {
    const weekdays = AutonomySchema.parse({ activeDays: [1, 2, 3, 4, 5], activeHours: { start: 9, end: 21 } })
    const mondayDawn = new Date('2026-09-14T06:00:00')
    expect(describeNextWindow(weekdays, mondayDawn)).toBe('today at 09:00')
  })

  it('names a weekday further out', () => {
    const mondaysOnly = AutonomySchema.parse({ activeDays: [1], activeHours: { start: 9, end: 21 } })
    const tuesday = new Date('2026-09-15T10:00:00')
    expect(describeNextWindow(mondaysOnly, tuesday)).toBe('Monday at 09:00')
  })

  it('admits when no day is selected at all', () => {
    const never = AutonomySchema.parse({ activeDays: [] })
    // An empty list means "unrestricted" to withinActiveWindow, so the next
    // window is simply the next start hour rather than never.
    expect(describeNextWindow(never, SUNDAY_AFTERNOON)).toMatch(/at \d\d:00/)
  })
})
