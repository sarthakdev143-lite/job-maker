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
import { deepseekBridgeFiles, injectFiles } from '@/shared/injection'
import { openWorkerWindow } from '@/shared/windows'

const log = createLogger('llm:deepseek')

const CHAT_URL = 'https://chat.deepseek.com/'
const URL_MATCH = 'https://chat.deepseek.com/*'
const BRIDGE_READY_TIMEOUT_MS = 30000

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
   * The content script is declared in the manifest, but a tab that was already
   * open when the extension was installed or updated has no bridge in it. Ping,
   * and inject on failure rather than making the user reload by hand.
   */
  private async ensureBridge(tabId: number): Promise<void> {
    const start = Date.now()
    let injected = false

    while (Date.now() - start < BRIDGE_READY_TIMEOUT_MS) {
      try {
        const res = (await chrome.tabs.sendMessage(tabId, { type: 'ds:ping' })) as DeepSeekResponse | undefined
        if (res && res.ok && res.type === 'ds:pong') {
          if (!res.loggedIn) throw new LlmError('Not signed in to DeepSeek', 'not_logged_in')
          if (res.ready) return
        }
      } catch (e) {
        if (e instanceof LlmError) throw e
        if (!injected) {
          injected = true
          const ok = await injectFiles(tabId, deepseekBridgeFiles())
          log.debug(ok ? 'Injected DeepSeek bridge into an existing tab' : 'Bridge injection was refused')
        }
      }
      await sleep(600)
    }
    throw new LlmError('DeepSeek tab never became ready', 'not_ready')
  }

  /* ---------------------------------------------------------------- health */

  async health(): Promise<{ status: LlmHealth; detail: string }> {
    try {
      const tabId = await this.ensureTab()
      const res = (await withTimeout(
        chrome.tabs.sendMessage(tabId, { type: 'ds:status' }) as Promise<DeepSeekResponse>,
        8000,
        'DeepSeek status'
      )) as DeepSeekResponse
      if (!res || !res.ok) return { status: 'unreachable', detail: res?.ok === false ? res.error : 'no response' }
      if (res.type !== 'ds:status') return { status: 'unreachable', detail: 'unexpected reply' }
      if (!res.loggedIn) return { status: 'needs_login', detail: 'Sign in to chat.deepseek.com' }
      if (!res.ready) return { status: 'unreachable', detail: 'Composer not found (DeepSeek UI may have changed)' }
      return { status: 'ok', detail: res.detail }
    } catch (e) {
      if (e instanceof LlmError && e.code === 'not_logged_in') {
        return { status: 'needs_login', detail: e.message }
      }
      return { status: 'unreachable', detail: (e as Error).message }
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
    if (!res.ok) throw new LlmError(res.error, res.code ?? 'transport')
    if (res.type !== 'ds:reply') throw new LlmError('Unexpected reply from DeepSeek bridge', 'transport')

    this.requestsSinceNewChat++
    return res.text
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
