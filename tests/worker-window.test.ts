/**
 * Regression test for the bug that stopped the agent doing anything at all.
 *
 * chrome.windows.create rejects `state` when it is given alongside `left`,
 * `top`, `width` or `height`:
 *
 *   "The 'state' property cannot be used with 'left', 'top', 'width', or 'height'."
 *
 * Every background window the agent opens was passing both, so the very first
 * call -- opening the DeepSeek tab during the start-up health check -- threw,
 * health came back unreachable, and start() refused to run. Nothing downstream
 * ever executed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openWorkerWindow } from '@/shared/windows'

type CreateArgs = Record<string, unknown>

let createCalls: CreateArgs[]
let updateCalls: Array<[number, Record<string, unknown>]>
let createImpl: (args: CreateArgs) => Promise<unknown>

function installFakeChrome(): void {
  createCalls = []
  updateCalls = []
  createImpl = async (args) => ({ id: 7, tabs: [{ id: 42 }], state: args.state })

  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    windows: {
      create: vi.fn(async (args: CreateArgs) => {
        createCalls.push(args)
        return createImpl(args)
      }),
      update: vi.fn(async (id: number, args: Record<string, unknown>) => {
        updateCalls.push([id, args])
        return { id }
      }),
      remove: vi.fn(async () => undefined),
    },
  }
}

/** Chrome's own validation, as a stand-in for the real API. */
function rejectStateWithBounds(args: CreateArgs): Promise<unknown> {
  const hasBounds = ['left', 'top', 'width', 'height'].some((key) => args[key] !== undefined)
  const state = args.state as string | undefined
  if (hasBounds && state && state !== 'normal') {
    return Promise.reject(
      new Error("The 'state' property cannot be used with 'left', 'top', 'width', or 'height'.")
    )
  }
  return Promise.resolve({ id: 7, tabs: [{ id: 42 }] })
}

beforeEach(installFakeChrome)
afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome
})

describe('openWorkerWindow', () => {
  it('never sends window bounds together with a non-normal state', async () => {
    createImpl = rejectStateWithBounds
    await openWorkerWindow('https://example.com', { minimized: true })

    const args = createCalls[0]!
    expect(args.state).toBe('minimized')
    expect(args.width).toBeUndefined()
    expect(args.height).toBeUndefined()
    expect(args.left).toBeUndefined()
    expect(args.top).toBeUndefined()
  })

  it('may send bounds when the window is not minimized', async () => {
    createImpl = rejectStateWithBounds
    await openWorkerWindow('https://example.com', { minimized: false, width: 1280, height: 900 })

    const args = createCalls[0]!
    expect(args.width).toBe(1280)
    expect(args.state).not.toBe('minimized')
  })

  it('returns the tab and window ids the caller needs', async () => {
    const result = await openWorkerWindow('https://example.com', { minimized: true })
    expect(result).toEqual({ tabId: 42, windowId: 7 })
  })

  it('never steals focus', async () => {
    await openWorkerWindow('https://example.com', { minimized: true })
    expect(createCalls[0]!.focused).toBe(false)
  })

  it('falls back to creating a plain window and minimizing it afterwards', async () => {
    // Some platforms refuse `state` at creation time entirely.
    createImpl = async (args) => {
      if (args.state !== undefined) throw new Error('Invalid state')
      return { id: 7, tabs: [{ id: 42 }] }
    }

    const result = await openWorkerWindow('https://example.com', { minimized: true })

    expect(result.tabId).toBe(42)
    expect(createCalls).toHaveLength(2)
    expect(updateCalls).toContainEqual([7, { state: 'minimized' }])
  })

  it('reports a useful error when a window cannot be opened at all', async () => {
    createImpl = async () => ({ id: undefined, tabs: [] })
    await expect(openWorkerWindow('https://example.com', { minimized: true })).rejects.toThrow(
      /could not open/i
    )
  })
})
