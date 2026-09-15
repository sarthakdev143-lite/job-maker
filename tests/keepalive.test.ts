/**
 * Regression tests for the bug that stopped overnight runs.
 *
 * Manifest V3 evicts a service worker after ~30s without extension API
 * activity, and a pending setTimeout is not activity. The agent's pause between
 * applications is 45-180s of exactly that, so every unattended run died at the
 * first gap between applications and did not resume until the next periodic
 * alarm, up to thirty minutes later.
 *
 * The contract these tests pin down is narrow but load-bearing: no single
 * uninterrupted wait may ever exceed the heartbeat interval, and an extension
 * API must be touched across every one of those boundaries.
 */

import { describe, expect, it, vi } from 'vitest'
import { HEARTBEAT_INTERVAL_MS, durableSleep, startHeartbeat } from '@/shared/keepalive'

/** Records what was slept for and when the browser was poked, in order. */
function recorder() {
  const events: Array<{ kind: 'tick' } | { kind: 'sleep'; ms: number }> = []
  return {
    events,
    ticker: async () => {
      events.push({ kind: 'tick' })
    },
    sleepFn: async (ms: number) => {
      events.push({ kind: 'sleep', ms })
    },
    sleeps: () => events.filter((e): e is { kind: 'sleep'; ms: number } => e.kind === 'sleep'),
    ticks: () => events.filter((e) => e.kind === 'tick'),
  }
}

describe('durableSleep', () => {
  it('waits the full requested time', async () => {
    const rec = recorder()
    await durableSleep(180_000, { ticker: rec.ticker, sleepFn: rec.sleepFn })
    const total = rec.sleeps().reduce((sum, s) => sum + s.ms, 0)
    expect(total).toBe(180_000)
  })

  it('never sleeps longer than the heartbeat interval in one go', async () => {
    const rec = recorder()
    await durableSleep(180_000, { ticker: rec.ticker, sleepFn: rec.sleepFn })
    for (const s of rec.sleeps()) {
      expect(s.ms).toBeLessThanOrEqual(HEARTBEAT_INTERVAL_MS)
    }
  })

  it('pokes an extension API before every chunk', async () => {
    const rec = recorder()
    await durableSleep(100_000, { ticker: rec.ticker, sleepFn: rec.sleepFn })

    // Every sleep must be immediately preceded by a tick, or the worker could
    // have been evicted during it.
    rec.events.forEach((event, index) => {
      if (event.kind !== 'sleep') return
      expect(rec.events[index - 1]?.kind).toBe('tick')
    })
  })

  it('handles the real 45-180s application gap without a fatal wait', async () => {
    const rec = recorder()
    await durableSleep(45_000, { ticker: rec.ticker, sleepFn: rec.sleepFn })
    // Anything at or above 30s is the eviction window.
    expect(rec.sleeps().every((s) => s.ms < 30_000)).toBe(true)
  })

  it('returns immediately when asked to stop, rather than waiting out the delay', async () => {
    const rec = recorder()
    await durableSleep(180_000, { ticker: rec.ticker, sleepFn: rec.sleepFn, shouldStop: () => true })
    expect(rec.sleeps()).toHaveLength(0)
  })

  it('stops partway through when a stop arrives mid-wait', async () => {
    const rec = recorder()
    let elapsed = 0
    await durableSleep(180_000, {
      ticker: rec.ticker,
      sleepFn: async (ms) => {
        elapsed += ms
        rec.events.push({ kind: 'sleep', ms })
      },
      shouldStop: () => elapsed >= 60_000,
    })
    expect(elapsed).toBeGreaterThanOrEqual(60_000)
    expect(elapsed).toBeLessThan(180_000)
  })

  it('treats a zero or negative delay as no wait at all', async () => {
    const rec = recorder()
    await durableSleep(0, { ticker: rec.ticker, sleepFn: rec.sleepFn })
    await durableSleep(-5000, { ticker: rec.ticker, sleepFn: rec.sleepFn })
    expect(rec.sleeps()).toHaveLength(0)
  })

  it('survives a ticker that throws, because keepalive must never fail a run', async () => {
    const rec = recorder()
    let calls = 0
    const flaky = async () => {
      calls++
      if (calls === 2) throw new Error('browser busy')
      return null
    }

    await expect(durableSleep(40_000, { ticker: flaky, sleepFn: rec.sleepFn })).resolves.toBeUndefined()
    // The wait still completed in full despite the failed poke.
    expect(rec.sleeps().reduce((sum, s) => sum + s.ms, 0)).toBe(40_000)
  })
})

describe('startHeartbeat', () => {
  it('pokes on an interval until stopped', () => {
    vi.useFakeTimers()
    try {
      let ticks = 0
      const beat = startHeartbeat({ ticker: async () => void ticks++, intervalMs: 20_000 })

      vi.advanceTimersByTime(60_000)
      expect(ticks).toBe(3)

      beat.stop()
      vi.advanceTimersByTime(60_000)
      expect(ticks).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is safe to stop more than once', () => {
    vi.useFakeTimers()
    try {
      const beat = startHeartbeat({ ticker: async () => undefined })
      beat.stop()
      expect(() => beat.stop()).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps beating even when the ticker rejects', () => {
    vi.useFakeTimers()
    try {
      let ticks = 0
      const beat = startHeartbeat({
        ticker: async () => {
          ticks++
          throw new Error('transient')
        },
        intervalMs: 20_000,
      })
      vi.advanceTimersByTime(60_000)
      expect(ticks).toBe(3)
      beat.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
