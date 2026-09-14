/**
 * The point of the activity model is that "still working" and "actually stuck"
 * look different. These thresholds are the whole feature, so they are tested
 * directly: crying stuck during a slow model reply is as bad as staying calm
 * while genuinely hung.
 */

import { describe, expect, it } from 'vitest'
import { formatDuration, idleStep, readActivity, type ActivityStep } from '@/shared/activity'

const NOW = 1_800_000_000_000

function step(overrides: Partial<ActivityStep> = {}): ActivityStep {
  return {
    kind: 'scoring',
    label: 'Scoring 3 of 25: Senior Backend Engineer',
    detail: 'DeepSeek is replying (412 characters so far)',
    startedAt: NOW - 5_000,
    expectedMs: 15_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  }
}

describe('readActivity', () => {
  it('reports working while detail keeps changing', () => {
    const reading = readActivity(step(), { now: NOW, running: true })
    expect(reading.health).toBe('working')
    expect(reading.message).toContain('412 characters')
  })

  it('stays calm through a long step that is still reporting progress', () => {
    // Two minutes in, but something changed a second ago: this is a slow reply,
    // not a hang, and calling it stuck would train the user to ignore warnings.
    const reading = readActivity(step({ startedAt: NOW - 120_000, updatedAt: NOW - 1_000 }), {
      now: NOW,
      running: true,
    })
    expect(reading.health).toBe('working')
  })

  it('warns when nothing has changed for a while', () => {
    const reading = readActivity(step({ updatedAt: NOW - 60_000 }), { now: NOW, running: true })
    expect(reading.health).toBe('slow')
  })

  it('calls it stuck once silence passes the hard limit', () => {
    const reading = readActivity(step({ updatedAt: NOW - 400_000 }), { now: NOW, running: true })
    expect(reading.health).toBe('stuck')
    expect(reading.message).toMatch(/stuck/i)
  })

  it('gives a step with a long expected duration more rope', () => {
    const applying = step({ kind: 'applying', expectedMs: 180_000, updatedAt: NOW - 60_000 })
    expect(readActivity(applying, { now: NOW, running: true }).health).toBe('working')
  })

  it('treats an unresponsive worker as stuck regardless of the step', () => {
    const reading = readActivity(step(), { now: NOW, running: true, workerReachable: false })
    expect(reading.health).toBe('unreachable')
    expect(reading.message).toMatch(/not responding/i)
  })

  it('is idle when the agent is not running', () => {
    const reading = readActivity(idleStep('last run 16:41: 12 found'), { now: NOW, running: false })
    expect(reading.health).toBe('idle')
    expect(reading.message).toContain('12 found')
  })

  it('does not shout about a pause, which is a normal state', () => {
    const paused = step({ kind: 'paused', label: 'Waiting for active hours', updatedAt: NOW - 600_000 })
    expect(readActivity(paused, { now: NOW, running: true }).health).toBe('idle')
  })

  it('measures elapsed and stale separately', () => {
    const reading = readActivity(step({ startedAt: NOW - 90_000, updatedAt: NOW - 2_000 }), {
      now: NOW,
      running: true,
    })
    expect(reading.elapsedMs).toBe(90_000)
    expect(reading.staleMs).toBe(2_000)
  })
})

describe('formatDuration', () => {
  it('reads naturally at every scale', () => {
    expect(formatDuration(4_000)).toBe('4s')
    expect(formatDuration(65_000)).toBe('1m 5s')
    expect(formatDuration(120_000)).toBe('2m')
    expect(formatDuration(3_900_000)).toBe('1h 5m')
  })
})
