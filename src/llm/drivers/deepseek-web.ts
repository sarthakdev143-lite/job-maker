/**
 * DeepSeek web driver.
 *
 * Owns one tab on chat.deepseek.com and talks to the bridge content script
 * inside it. The tab lives in its own minimized window so it never steals the
 * user's focus or clutters their working window, and it is reused for the life
 * of the session.
 *
 * Everything here is serialized by the broker: this driver assumes one prompt
 * in flight at a time and the bridge enforces that assumption.
 */

import type { CompleteRequest, LlmDriver, LlmHealth } from '../driver'
import { LlmError } from '../driver'
import type { DeepSeekResponse } from '@/shared/messages'
import type { LlmConfig } from '@/storage/schemas'
import { createLogger } from '@/shared/logger'
import { sleep, uid, withTimeout } from '@/shared/util'
import { deepseekBridgeFiles, ensureContentScript, waitForTabComplete } from '@/shared/injection'
import { openWorkerWindow } from '@/shared/windows'
import { activity } from '@/shared/activity'

const log = createLogger('llm:deepseek')

const CHAT_URL = 'https://chat.deepseek.com/'
const URL_MATCH = 'https://chat.deepseek.com/*'
const BRIDGE_READY_TIMEOUT_MS = 30000
/** Shorter than a real request: the panel calls this on every open. */
const HEALTH_TIMEOUT_MS = 20000

export class DeepSeekWebDriver implements LlmDriver {
  readonly id = 'deepseek-web'
  readonly label = 'DeepSeek (web)'

  private tabId: number | null = null
  private windowId: number | null = null
  private requestsSinceNewChat = 0

  constructor(private config: LlmConfig) {}

  updateConfig(config: LlmConfig): void {
    this.config = config
  }

  /* ------------------------------------------------------------ tab plumbing */

  private async findExistingTab(): Promise<chrome.tabs.Tab | null> {
    const tabs = await chrome.tabs.query({ url: URL_MATCH })
    // Prefer a tab we already adopted; otherwise take any DeepSeek tab the user
    // happens to have open, which saves opening a second one.
    const mine = tabs.find((t) => t.id === this.tabId)
    return mine ?? tabs[0] ?? null
  }

  private async ensureTab(): Promise<number> {
    const existing = await this.findExistingTab()
    if (existing?.id !== undefined) {
      this.tabId = existing.id
      this.windowId = existing.windowId ?? null
      if (existing.discarded || existing.status === 'unloaded') {
        await chrome.tabs.reload(existing.id)
        await sleep(1500)
      }
      return existing.id
    }

    let created
    try {
      created = await openWorkerWindow(CHAT_URL, {
        minimized: this.config.keepWindowMinimized,
        width: 900,
        height: 700,
      })
    } catch (e) {
      throw new LlmError(`Could not open a DeepSeek window: ${(e as Error).message}`, 'transport')
    }

    this.tabId = created.tabId
    this.windowId = created.windowId
    log.info('Opened DeepSeek worker tab', { tabId: this.tabId })
    return created.tabId
  }

  /**
   * Wait for the bridge to answer, injecting it if the tab predates the
   * extension being loaded.
   *
   * The tab is almost never ready the instant it is created, so this polls
   * rather than asking once -- messaging too early fails with "Receiving end
   * does not exist", which is a race, not a missing script.
   */
  private async ensureBridge(tabId: number, timeoutMs = BRIDGE_READY_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const res = await ensureContentScript<DeepSeekResponse>(
        tabId,
        deepseekBridgeFiles(),
        { type: 'ds:ping' },
        { timeoutMs: Math.max(2000, deadline - Date.now()) }
      )

      if (res && res.ok && res.type === 'ds:pong') {
        if (!res.loggedIn) throw new LlmError('Not signed in to DeepSeek', 'not_logged_in')
        if (res.ready) return
      }
      // Signed in but the composer has not mounted yet: give the app a moment.
      await sleep(600)
    }
    throw new LlmError('DeepSeek loaded but its chat box never appeared', 'not_ready')
  }

  /* ---------------------------------------------------------------- health */

  /**
   * Is the model usable right now?
   *
   * This has to go through the same readiness path as a real request. Asking
   * the tab directly is what produced "Could not establish connection.
   * Receiving end does not exist." on every start: the window had just been
   * created and its page had not loaded yet.
   */
  async health(): Promise<{ status: LlmHealth; detail: string }> {
    try {
      const tabId = await this.ensureTab()
      await waitForTabComplete(tabId, 20000).catch(() => {
        // A slow page is not fatal; the poll below gives it more time.
      })

      const res = await ensureContentScript<DeepSeekResponse>(
        tabId,
        deepseekBridgeFiles(),
        { type: 'ds:status' },
        { timeoutMs: HEALTH_TIMEOUT_MS }
      )

      if (!res || !res.ok) {
        return { status: 'unreachable', detail: res?.ok === false ? res.error : 'no response from the DeepSeek tab' }
      }
      if (res.type !== 'ds:status') return { status: 'unreachable', detail: 'unexpected reply from the bridge' }
      if (!res.loggedIn) return { status: 'needs_login', detail: 'Sign in to chat.deepseek.com' }
      if (!res.ready) {
        return {
          status: 'unreachable',
          detail: 'Signed in, but the chat box was not found. DeepSeek may have changed its page.',
        }
      }
      return { status: 'ok', detail: res.detail }
    } catch (e) {
      if (e instanceof LlmError && e.code === 'not_logged_in') {
        return { status: 'needs_login', detail: e.message }
      }
      const message = (e as Error).message
      if (/receiving end|never responded|Could not establish/i.test(message)) {
        return {
          status: 'unreachable',
          detail: 'The DeepSeek tab did not respond. Open it, let it finish loading, then re-check.',
        }
      }
      return { status: 'unreachable', detail: message }
    }
  }

  async openLogin(): Promise<void> {
    const tabId = await this.ensureTab()
    if (this.windowId !== null) {
      await chrome.windows.update(this.windowId, { focused: true, state: 'normal' })
    }
    await chrome.tabs.update(tabId, { active: true })
  }

  /* -------------------------------------------------------------- complete */

  async complete(req: CompleteRequest): Promise<string> {
    const tabId = await this.ensureTab()
    await this.ensureBridge(tabId)

    const wantsFresh =
      req.freshContext ||
      (this.config.newChatEveryNRequests > 0 &&
        this.requestsSinceNewChat >= this.config.newChatEveryNRequests)

    if (wantsFresh) {
      await this.reset()
      await this.ensureBridge(tabId)
    }

    // The web UI has no system role, so system text is prepended with a clear
    // separator. Models follow this as well as a real system message here.
    const prompt = req.system ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt
    const timeoutMs = req.timeoutMs ?? this.config.requestTimeoutMs
    const requestId = uid('req')

    activity.note('sent the prompt to DeepSeek, waiting for a reply')

    let res: DeepSeekResponse
    try {
      res = (await withTimeout(
        chrome.tabs.sendMessage(tabId, { type: 'ds:send', requestId, prompt, timeoutMs }) as Promise<DeepSeekResponse>,
        timeoutMs + 15000,
        'DeepSeek completion'
      )) as DeepSeekResponse
    } catch (e) {
      throw new LlmError(`DeepSeek transport failed: ${(e as Error).message}`, 'timeout')
    }

    if (!res) throw new LlmError('DeepSeek bridge returned nothing', 'transport')
    if (!res.ok) throw new LlmError(this.explain(res.error, res.code), res.code ?? 'transport')
    if (res.type !== 'ds:reply') throw new LlmError('Unexpected reply from DeepSeek bridge', 'transport')

    this.requestsSinceNewChat++
    return res.text
  }

  /**
   * Add the context an error message cannot carry on its own.
   *
   * Chrome throttles timers in hidden tabs, and a minimized window is hidden:
   * after several minutes it can slow them to roughly once a minute, which the
   * bridge sees as a reply that never finishes. That is not obvious from a bare
   * timeout, so the timeout says it.
   */
  private explain(message: string, code?: string): string {
    if (code === 'timeout' && this.config.keepWindowMinimized) {
      return `${message}. If this keeps happening, turn off "Keep the worker window minimised" in Settings > Model: Chrome throttles timers in minimised windows.`
    }
    return message
  }

  async reset(): Promise<void> {
    if (this.tabId === null) return
    try {
      await chrome.tabs.sendMessage(this.tabId, { type: 'ds:newChat' })
      this.requestsSinceNewChat = 0
      await sleep(800)
    } catch {
      // A failed reset just means a longer conversation, not a failed run.
    }
  }

  async dispose(): Promise<void> {
    // The tab is deliberately left open: closing it would log the user out of
    // nothing but would cost a full page load on the next run.
    this.tabId = null
    this.windowId = null
  }
}
