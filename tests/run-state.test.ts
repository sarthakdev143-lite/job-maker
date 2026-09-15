/**
 * Run state that outlives the service worker.
 *
 * The orchestrator held "am I running?" in a field on a singleton, which Chrome
 * discards along with the worker after ~30 idle seconds. An overnight run did
 * not pause when that happened, it forgot: the replacement worker read itself
 * as idle and waited for the next periodic alarm before doing anything.
 *
 * These cover the record itself. The contract is that a run in progress is
 * still visible after the worker is replaced, and that a run the user stopped
 * never comes back to life on its own.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { STALE_AFTER_MS, beat, clearRunState, loadRunState, looksInterrupted, saveRunState } from '@/background/run-state'

/** A minimal chrome.storage.local that behaves like the real one. */
function installFakeStorage(): { store: Record<string, unknown>; failNext: () => void } {
  const store: Record<string, unknown> = {}
  let shouldFail = false

  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => {
          if (shouldFail) {
            shouldFail = false
            throw new Error('storage unavailable')
          }
          return key in store ? { [key]: store[key] } : {}
        },
        set: async (items: Record<string, unknown>) => {
          if (shouldFail) {
            shouldFail = false
            throw new Error('storage unavailable')
          }
          Object.assign(store, items)
        },
      },
    },
  }

  return { store, failNext: () => void (shouldFail = true) }
}

describe('run state', () => {
  let fake: ReturnType<typeof installFakeStorage>

  beforeEach(() => {
    fake = installFakeStorage()
  })

  it('reports idle when nothing has ever been stored', async () => {
    const state = await loadRunState()
    expect(state.running).toBe(false)
    expect(state.startedAt).toBeNull()
  })

  it('round-trips a run that is in progress', async () => {
    const startedAt = Date.now() - 60_000
    await saveRunState({ running: true, startedAt, manual: true })

    const state = await loadRunState()
    expect(state.running).toBe(true)
    expect(state.startedAt).toBe(startedAt)
    expect(state.manual).toBe(true)
  })

  it('remembers that a run was started by hand', async () => {
    // A manual run ignores the active-hours window. Losing that flag across an
    // eviction turned a run started at 11pm into a scheduled one that then
    // refused to work until morning.
    await saveRunState({ running: true, startedAt: Date.now(), manual: true })
    expect((await loadRunState()).manual).toBe(true)

    await saveRunState({ running: true, startedAt: Date.now(), manual: false })
    expect((await loadRunState()).manual).toBe(false)
  })

  it('stamps the clock on every save', async () => {
    const before = Date.now()
    await saveRunState({ running: true, startedAt: before, manual: false })
    expect((await loadRunState()).lastBeatAt).toBeGreaterThanOrEqual(before)
  })

  it('clears back to idle when the user stops', async () => {
    await saveRunState({ running: true, startedAt: Date.now(), manual: true })
    await clearRunState()

    const state = await loadRunState()
    expect(state.running).toBe(false)
    expect(state.startedAt).toBeNull()
  })

  it('beats only while a run is actually in progress', async () => {
    // Beating on a cleared record would resurrect a stopped run.
    await clearRunState()
    await beat()
    expect((await loadRunState()).running).toBe(false)
  })

  it('advances the beat of a live run', async () => {
    await saveRunState({ running: true, startedAt: Date.now(), manual: false })
    const first = (await loadRunState()).lastBeatAt

    await new Promise((r) => setTimeout(r, 5))
    await beat()

    expect((await loadRunState()).lastBeatAt).toBeGreaterThanOrEqual(first)
    expect((await loadRunState()).running).toBe(true)
  })

  it('survives storage throwing, rather than failing the run', async () => {
    fake.failNext()
    await expect(loadRunState()).resolves.toMatchObject({ running: false })

    fake.failNext()
    await expect(saveRunState({ running: true, startedAt: 1, manual: false })).resolves.toBeUndefined()
  })

  it('ignores a malformed stored record', async () => {
    fake.store['agent:runState'] = 'not an object'
    const state = await loadRunState()
    expect(state.running).toBe(false)
  })

  it('coerces a partially written record into something usable', async () => {
    fake.store['agent:runState'] = { running: true }
    const state = await loadRunState()
    expect(state.running).toBe(true)
    expect(state.startedAt).toBeNull()
    expect(state.lastBeatAt).toBe(0)
  })
})

describe('looksInterrupted', () => {
  const live = { running: true, startedAt: 0, manual: false, lastBeatAt: 1_000_000 }

  it('is false for a run that beat recently', () => {
    expect(looksInterrupted(live, live.lastBeatAt + 1000)).toBe(false)
  })

  it('is true once the beats have stopped for long enough', () => {
    expect(looksInterrupted(live, live.lastBeatAt + STALE_AFTER_MS + 1)).toBe(true)
  })

  it('is never true for a run that is not running', () => {
    expect(looksInterrupted({ ...live, running: false }, live.lastBeatAt + STALE_AFTER_MS * 10)).toBe(false)
  })
})
