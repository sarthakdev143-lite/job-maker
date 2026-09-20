/**
 * Regression test for a kill switch that lasted five minutes.
 *
 * The cycle alarm fires every five minutes for ever and is the safety net under
 * an evicted worker: if nothing is running, it starts a run. Stop cleared the
 * run flag and closed the windows, so five minutes later the alarm woke, saw
 * nothing running, and started a fresh run. From the user's side the button did
 * nothing -- windows reappeared, applications resumed -- and the only way out
 * was switching autonomy off entirely.
 *
 * A halt is therefore sticky, and only pressing Start lifts it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRunState, isHalted, saveRunState, setHalted } from '@/background/run-state'

function installFakeStorage(): void {
  let store: Record<string, unknown> = {}
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          store = { ...store, ...items }
        }),
        remove: vi.fn(async (key: string) => {
          const { [key]: _drop, ...rest } = store
          store = rest
        }),
      },
    },
  }
}

beforeEach(installFakeStorage)

describe('the halt flag', () => {
  it('starts clear', async () => {
    expect(await isHalted()).toBe(false)
  })

  it('survives a read after being set, because the worker will not', async () => {
    await setHalted(true)
    expect(await isHalted()).toBe(true)
  })

  it('is lifted only by clearing it explicitly', async () => {
    await setHalted(true)
    await setHalted(false)
    expect(await isHalted()).toBe(false)
  })

  it('is not disturbed by the run state it lives alongside', async () => {
    // clearRunState is what the kill switch already called, and it was not
    // enough: the alarm reads "nothing running" as "start something".
    await setHalted(true)
    await saveRunState({ running: false, startedAt: null, manual: false })
    await clearRunState()
    expect(await isHalted()).toBe(true)
  })

  it('reports false rather than throwing when storage is unavailable', async () => {
    ;(globalThis as unknown as { chrome: { storage: unknown } }).chrome.storage = undefined
    // A broken read must not wedge the agent permanently off.
    expect(await isHalted()).toBe(false)
    await expect(setHalted(true)).resolves.toBeUndefined()
  })
})
