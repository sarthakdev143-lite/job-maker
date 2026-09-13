/**
 * Regression test for "Could not establish connection. Receiving end does not
 * exist."
 *
 * chrome.windows.create resolves as soon as the window exists -- the page has
 * not loaded and its content script does not exist yet. The health check
 * messaged the tab immediately, got that error, reported the model unreachable,
 * and the agent refused to start.
 *
 * The fix is to wait for the tab and inject the script if it is still missing,
 * which is what every caller now goes through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureContentScript, waitForTabComplete } from '@/shared/injection'

type Tab = { id: number; status: string; url?: string }

let tab: Tab
let pingFailuresRemaining: number
let injected: number
let sendCalls: number

function installFakeChrome(): void {
  tab = { id: 42, status: 'complete', url: 'https://chat.deepseek.com/' }
  pingFailuresRemaining = 0
  injected = 0
  sendCalls = 0

  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      getManifest: () => ({
        content_scripts: [
          { matches: ['https://chat.deepseek.com/*'], js: ['assets/deepseek-bridge.js'] },
          { matches: ['https://boards.greenhouse.io/*'], js: ['assets/form-agent.js'] },
        ],
      }),
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        if (id !== tab.id) throw new Error('No tab with id')
        return tab
      }),
      sendMessage: vi.fn(async () => {
        sendCalls++
        if (pingFailuresRemaining > 0) {
          pingFailuresRemaining--
          throw new Error('Could not establish connection. Receiving end does not exist.')
        }
        return { ok: true, type: 'ds:status', ready: true, loggedIn: true }
      }),
    },
    scripting: {
      executeScript: vi.fn(async () => {
        injected++
        // Injecting makes the receiving end exist.
        pingFailuresRemaining = 0
        return [{ frameId: 0, result: null }]
      }),
    },
  }
}

beforeEach(installFakeChrome)
afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome
})

describe('ensureContentScript', () => {
  it('returns the reply when the script is already there', async () => {
    const res = await ensureContentScript(42, ['assets/deepseek-bridge.js'], { type: 'ds:status' })
    expect(res).toMatchObject({ ok: true, loggedIn: true })
    expect(injected).toBe(0)
  })

  it('injects the script when the receiving end does not exist, then succeeds', async () => {
    pingFailuresRemaining = 3
    const res = await ensureContentScript(42, ['assets/deepseek-bridge.js'], { type: 'ds:status' })
    expect(injected).toBe(1)
    expect(res).toMatchObject({ ok: true })
  })

  it('waits for a still-loading tab before giving up on it', async () => {
    tab.status = 'loading'
    pingFailuresRemaining = 99
    setTimeout(() => {
      tab.status = 'complete'
      pingFailuresRemaining = 0
    }, 300)

    const res = await ensureContentScript(42, ['assets/deepseek-bridge.js'], { type: 'ds:status' }, { timeoutMs: 5000 })
    expect(res).toMatchObject({ ok: true })
  })

  it('gives up with a readable error rather than hanging forever', async () => {
    pingFailuresRemaining = Number.MAX_SAFE_INTEGER
    ;(globalThis as unknown as { chrome: { scripting: { executeScript: unknown } } }).chrome.scripting.executeScript =
      vi.fn(async () => {
        throw new Error('Cannot access contents of the page')
      })

    await expect(
      ensureContentScript(42, ['assets/deepseek-bridge.js'], { type: 'ds:status' }, { timeoutMs: 900 })
    ).rejects.toThrow(/never responded|not ready/i)
  })

  it('does not inject repeatedly while polling', async () => {
    pingFailuresRemaining = Number.MAX_SAFE_INTEGER
    await ensureContentScript(42, ['x.js'], { type: 'ping' }, { timeoutMs: 1200 }).catch(() => {})
    expect(injected).toBeLessThanOrEqual(2)
  })
})

describe('waitForTabComplete', () => {
  it('resolves once the tab finishes loading', async () => {
    tab.status = 'loading'
    setTimeout(() => {
      tab.status = 'complete'
    }, 250)
    await expect(waitForTabComplete(42, 3000)).resolves.toBeUndefined()
  })

  it('throws when the tab is gone', async () => {
    await expect(waitForTabComplete(999, 1000)).rejects.toThrow(/tab/i)
  })
})
