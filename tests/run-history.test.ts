/**
 * Persisted run records: the morning after must have an answer.
 *
 * The in-memory cycle summary vanished on the next cycle or worker restart,
 * so "found? filtered? attempted? submitted? why not?" had no single place to
 * look. These cover the record itself: it persists across reads, caps its own
 * growth, and names blocks rather than reporting them as empty nights.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  emptySummary,
  getLastSummary,
  getRecentSummaries,
  recordRecipeHealth,
  getRecipeHealth,
  saveCycleSummary,
  summarizeCycle,
} from '@/background/run-history'

function installFakeStorage(): { store: Record<string, unknown> } {
  const store: Record<string, unknown> = {}
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
        set: async (items: Record<string, unknown>) => {
          Object.assign(store, items)
        },
      },
    },
  }
  return { store }
}

function baseSummary() {
  return {
    ...emptySummary(),
    startedAt: 1000,
    endedAt: 2000,
    outcome: 'completed' as const,
    note: 'test',
  }
}

describe('run history', () => {
  beforeEach(() => {
    installFakeStorage()
  })

  it('persists a cycle and reads it back as the last summary', async () => {
    await saveCycleSummary({ ...baseSummary(), found: 3, submitted: 1 })
    const last = await getLastSummary()
    expect(last?.found).toBe(3)
    expect(last?.submitted).toBe(1)
    expect(last?.id).toBeTruthy()
  })

  it('returns null when nothing has been recorded', async () => {
    expect(await getLastSummary()).toBeNull()
    expect(await getRecentSummaries()).toEqual([])
  })

  it('keeps only the most recent entries', async () => {
    for (let i = 0; i < 25; i++) {
      await saveCycleSummary({ ...baseSummary(), startedAt: i, endedAt: i + 1 })
    }
    const recent = await getRecentSummaries(30)
    expect(recent.length).toBe(20)
    expect(recent[0].startedAt).toBe(24)
  })

  it('names a blocked night instead of calling it empty', async () => {
    const note = summarizeCycle({ ...emptySummary(), outcome: 'completed', note: '', blocked: 2 })
    expect(note).toMatch(/bot check/i)
  })

  it('names the top parking reason when everything parks', async () => {
    const note = summarizeCycle({
      ...emptySummary(),
      outcome: 'completed',
      note: '',
      attempted: 4,
      parked: 4,
      gateReasons: { '2 required field(s) unanswered: foo': 3, 'daily cap reached (15/15)': 1 },
    })
    expect(note).toMatch(/top reason/)
    expect(note).toMatch(/unanswered/)
  })

  it('records per-recipe health across runs', async () => {
    await recordRecipeHealth('r1', { lastRunAt: 5, lastFetched: 10, lastStored: 2 })
    await recordRecipeHealth('r1', { lastError: 'boom' })
    const health = await getRecipeHealth()
    expect(health['r1'].lastFetched).toBe(10)
    expect(health['r1'].lastError).toBe('boom')
  })
})
