/**
 * Chat-site web driver.
 *
 * Owns one tab on a chat site and talks to the bridge content script inside it.
 * The tab lives in its own minimized window so it never steals the user's focus
 * or clutters their working window, and it is reused for the life of the
 * session.
 *
 * Which site is a parameter, not a constant: DeepAI is the default and the
 * fallback, DeepSeek is kept as an alternative because a free web driver you
 * cannot switch away from is a single point of failure. Everything below is
 * site-agnostic -- the selectors live in `chat-sites.ts`.
 *
 * Everything here is serialized by the broker: this driver assumes one prompt
 * in flight at a time and the bridge enforces that assumption.
 */

import type { CompleteRequest, LlmDriver, LlmHealth } from '../driver'
import { LlmError } from '../driver'
import type { ChatResponse } from '@/shared/messages'
import type { LlmConfig } from '@/storage/schemas'
import { createLogger } from '@/shared/logger'
import { sleep, uid, withTimeout } from '@/shared/util'
import { chatBridgeFiles, ensureContentScript, waitForTabComplete } from '@/shared/injection'
import { openWorkerWindow } from '@/shared/windows'
import { activity } from '@/shared/activity'
import { DEEPAI, type ChatSite } from '../chat-sites'

const log = createLogger('llm:chat')

const BRIDGE_READY_TIMEOUT_MS = 30000
/** Shorter than a real request: the panel calls this on every open. */
const HEALTH_TIMEOUT_MS = 20000

export class ChatWebDriver implements LlmDriver {
  readonly id: string
  readonly label: string

  private site: ChatSite
  private tabId: number | null = null
  private windowId: number | null = null
  private requestsSinceNewChat = 0
  private lastSentAt = 0

  constructor(
    private config: LlmConfig,
    site: ChatSite = DEEPAI
  ) {
    this.site = site
    this.id = site.id
    this.label = site.label
  }

  /** The site this instance is talking to, for the broker and the UI. */
  get chatSite(): ChatSite {
    return this.site
  }

  /**
   * Hold off until `minRequestGapMs` has passed since the last prompt.
   *
   * A run can produce prompts back to back for hours. The chat product is not
   * built for that, and hammering it is both rude and the fastest way to get an
   * account limited. If this pacing is too slow for the volume you want, the
   * answer is the paid API driver, which is sold for exactly this.
   */
  private async pace(): Promise<void> {
    const gap = Math.max(0, this.config.minRequestGapMs ?? 0)
    if (gap === 0 || this.lastSentAt === 0) return
    const waitMs = gap - (Date.now() - this.lastSentAt)
    if (waitMs > 0) {
      log.debug('Pacing the next chat prompt', { site: this.site.id, waitMs })
      await sleep(waitMs)
    }
  }

  updateConfig(config: LlmConfig): void {
    this.config = config
  }

  /* ------------------------------------------------------------ tab plumbing */

  private async findExistingTab(): Promise<chrome.tabs.Tab | null> {
    const tabs = await chrome.tabs.query({ url: this.site.match })
    // Prefer a tab we already adopted; otherwise take any tab the user happens
    // to have open on that site, which saves opening a second one.
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
      created = await openWorkerWindow(this.site.chatUrl, {
        minimized: this.config.keepWindowMinimized,
        width: 900,
        height: 700,
      })
    } catch (e) {
      throw new LlmError(`Could not open a ${this.site.label} window: ${(e as Error).message}`, 'transport')
    }

    this.tabId = created.tabId
    this.windowId = created.windowId
    log.info('Opened chat worker tab', { site: this.site.id, tabId: this.tabId })
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
      const res = await ensureContentScript<ChatResponse>(
        tabId,
        chatBridgeFiles(),
        { type: 'chat:ping' },
        { timeoutMs: Math.max(2000, deadline - Date.now()) }
      )

      if (res && res.ok && res.type === 'chat:pong') {
        if (!res.loggedIn) {
          throw new LlmError(
            this.site.authRequired
              ? `Not signed in to ${this.site.label}`
              : `${this.site.label} is showing a sign-in dialog over the chat box`,
            'not_logged_in'
          )
        }
        if (res.ready) return
      }
      // Signed in but the composer has not mounted yet: give the app a moment.
      await sleep(600)
    }
    throw new LlmError(`${this.site.label} loaded but its chat box never appeared`, 'not_ready')
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

      const res = await ensureContentScript<ChatResponse>(
        tabId,
        chatBridgeFiles(),
        { type: 'chat:status' },
        { timeoutMs: HEALTH_TIMEOUT_MS }
      )

      if (!res || !res.ok) {
        return {
          status: 'unreachable',
          detail: res?.ok === false ? res.error : `no response from the ${this.site.label} tab`,
        }
      }
      if (res.type !== 'chat:status') return { status: 'unreachable', detail: 'unexpected reply from the bridge' }
      if (!res.loggedIn) {
        return {
          status: 'needs_login',
          detail: this.site.authRequired
            ? `Sign in to ${this.site.chatUrl}`
            : `${this.site.label} has a dialog over the chat box. Sign in and close it.`,
        }
      }
      if (!res.ready) {
        return {
          status: 'unreachable',
          detail: `Signed in, but the chat box was not found. ${this.site.label} may have changed its page.`,
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
          detail: `The ${this.site.label} tab did not respond. Open it, let it finish loading, then re-check.`,
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

    await this.pace()
    this.lastSentAt = Date.now()
    activity.note(`sent the prompt to ${this.site.label}, waiting for a reply`)

    let res: ChatResponse
    try {
      res = (await withTimeout(
        chrome.tabs.sendMessage(tabId, { type: 'chat:send', requestId, prompt, timeoutMs }) as Promise<ChatResponse>,
        timeoutMs + 15000,
        `${this.site.label} completion`
      )) as ChatResponse
    } catch (e) {
      throw new LlmError(`${this.site.label} transport failed: ${(e as Error).message}`, 'timeout')
    }

    if (!res) throw new LlmError('Chat bridge returned nothing', 'transport')
    if (!res.ok) throw new LlmError(this.explain(res.error, res.code), this.toCode(res.code))
    if (res.type !== 'chat:reply') throw new LlmError(`Unexpected reply from the ${this.site.label} bridge`, 'transport')

    this.requestsSinceNewChat++
    return res.text
  }

  /** A bridge error code expressed in the driver's vocabulary. */
  private toCode(code?: string): 'not_ready' | 'not_logged_in' | 'timeout' | 'busy' | 'dom_changed' | 'transport' {
    if (code === 'exhausted') return 'transport'
    if (
      code === 'not_ready' ||
      code === 'not_logged_in' ||
      code === 'timeout' ||
      code === 'busy' ||
      code === 'dom_changed'
    ) {
      return code
    }
    return 'transport'
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
      await chrome.tabs.sendMessage(this.tabId, { type: 'chat:newChat' })
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
