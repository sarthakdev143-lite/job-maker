/**
 * DeepSeek web bridge.
 *
 * Runs inside chat.deepseek.com and does exactly one job: accept a prompt from
 * the service worker, type it into the composer, wait for the streamed reply to
 * finish, and hand back the text.
 *
 * This is the most brittle file in the extension by design -- it is the only
 * place that knows anything about DeepSeek's DOM, so when their UI changes this
 * is the only file to repair. Every selector below is overridable at runtime
 * from the options page (storage key `deepseekSelectors`) so a break can be
 * fixed without rebuilding the extension.
 */

import type { DeepSeekRequest, DeepSeekResponse } from '@/shared/messages'

type SelectorSet = {
  composer: string[]
  sendButton: string[]
  stopButton: string[]
  assistantMessage: string[]
  newChatButton: string[]
  loginIndicator: string[]
}

const DEFAULT_SELECTORS: SelectorSet = {
  composer: ['textarea#chat-input', 'textarea[placeholder]', 'div[contenteditable="true"]'],
  sendButton: [
    'div[role="button"][aria-disabled="false"]:has(svg)',
    'button[type="submit"]',
    'div[class*="send"]',
  ],
  stopButton: ['div[class*="stop"]', 'button[aria-label*="Stop" i]', 'div[aria-label*="Stop" i]'],
  assistantMessage: ['.ds-markdown', '[class*="ds-markdown"]', '[class*="markdown"]'],
  newChatButton: [
    'div[class*="new-chat"]',
    'a[href="/"]',
    'button[aria-label*="New chat" i]',
    'div[aria-label*="New chat" i]',
  ],
  loginIndicator: ['input[type="password"]', 'form[action*="login"]'],
}

/** Text stability window: the reply is done once it stops changing for this long. */
const STABLE_MS = 1400
const POLL_MS = 300

/** DeepSeek's own overload message. Treated as retryable rather than an answer. */
const BUSY_PATTERNS = [
  /the server is busy/i,
  /please try again later/i,
  /rate limit/i,
  /too many requests/i,
]

let selectors: SelectorSet = DEFAULT_SELECTORS
let busy = false

void loadSelectorOverrides()

async function loadSelectorOverrides(): Promise<void> {
  try {
    const bag = await chrome.storage.local.get('deepseekSelectors')
    const override = bag.deepseekSelectors as Partial<SelectorSet> | undefined
    if (!override) return
    selectors = {
      composer: override.composer?.length ? override.composer : DEFAULT_SELECTORS.composer,
      sendButton: override.sendButton?.length ? override.sendButton : DEFAULT_SELECTORS.sendButton,
      stopButton: override.stopButton?.length ? override.stopButton : DEFAULT_SELECTORS.stopButton,
      assistantMessage: override.assistantMessage?.length
        ? override.assistantMessage
        : DEFAULT_SELECTORS.assistantMessage,
      newChatButton: override.newChatButton?.length ? override.newChatButton : DEFAULT_SELECTORS.newChatButton,
      loginIndicator: override.loginIndicator?.length ? override.loginIndicator : DEFAULT_SELECTORS.loginIndicator,
    }
  } catch {
    selectors = DEFAULT_SELECTORS
  }
}

/* ------------------------------------------------------------- DOM helpers */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** First element matching any selector in the list. Bad selectors are skipped. */
function queryAny<T extends Element = HTMLElement>(list: string[]): T | null {
  for (const sel of list) {
    try {
      const el = document.querySelector<T>(sel)
      if (el) return el
    } catch {
      // ':has()' and friends throw on older engines; try the next candidate.
    }
  }
  return null
}

function queryAllAny<T extends Element = HTMLElement>(list: string[]): T[] {
  for (const sel of list) {
    try {
      const els = Array.from(document.querySelectorAll<T>(sel))
      if (els.length > 0) return els
    } catch {
      // Ignore and try the next candidate.
    }
  }
  return []
}

function isVisible(el: Element | null): boolean {
  if (!el) return false
  const rect = (el as HTMLElement).getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  const style = getComputedStyle(el as HTMLElement)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

function findComposer(): HTMLTextAreaElement | HTMLElement | null {
  const el = queryAny<HTMLTextAreaElement>(selectors.composer)
  if (el && isVisible(el)) return el
  // Last resort: the largest visible textarea on the page.
  const areas = Array.from(document.querySelectorAll('textarea')).filter(isVisible)
  if (areas.length === 0) return null
  return areas.sort(
    (a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width
  )[0] as HTMLTextAreaElement
}

function assistantNodes(): HTMLElement[] {
  return queryAllAny<HTMLElement>(selectors.assistantMessage).filter(isVisible)
}

function isGenerating(): boolean {
  const stop = queryAny(selectors.stopButton)
  return Boolean(stop && isVisible(stop))
}

function loggedIn(): boolean {
  if (queryAny(selectors.loginIndicator)) return false
  if (/\/sign_in|\/login/i.test(location.pathname)) return false
  return Boolean(findComposer())
}

/**
 * Set a value the way a user would, so React's controlled input sees it.
 * Assigning `.value` directly updates the DOM but not React's internal state,
 * and the app then sends an empty message.
 */
function setComposerValue(el: HTMLElement, value: string): void {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    el.focus()
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }
  // contenteditable composer
  el.focus()
  el.textContent = value
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
}

function pressEnter(el: HTMLElement): void {
  const init: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  }
  el.dispatchEvent(new KeyboardEvent('keydown', init))
  el.dispatchEvent(new KeyboardEvent('keypress', init))
  el.dispatchEvent(new KeyboardEvent('keyup', init))
}

/**
 * Send by clicking the send control when we can identify it, falling back to
 * Enter. Enter alone is unreliable when the composer is a contenteditable that
 * treats it as a newline, and clicking alone is unreliable because the button's
 * class names are obfuscated and change between deploys -- so we try both.
 */
function submitComposer(composer: HTMLElement): void {
  const explicit = queryAny<HTMLElement>(selectors.sendButton)
  if (explicit && isVisible(explicit) && explicit.getAttribute('aria-disabled') !== 'true') {
    explicit.click()
    return
  }
  const form = composer.closest('form')
  if (form) {
    pressEnter(composer)
    return
  }
  pressEnter(composer)
}

/* ------------------------------------------------------------- the flow */

async function waitForComposer(timeoutMs = 20000): Promise<HTMLElement> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const el = findComposer()
    if (el) return el
    await sleep(250)
  }
  throw Object.assign(new Error('DeepSeek composer not found'), { code: 'dom_changed' })
}

/**
 * Wait for a reply that started after `baselineCount` messages existed.
 *
 * Completion is "text stopped changing for STABLE_MS and no stop button is
 * showing". Watching only the stop button is not enough (it is absent for a
 * beat before streaming starts); watching only text stability is not enough
 * (the stream pauses mid-answer). Together they are reliable in practice.
 */
async function waitForReply(baselineCount: number, timeoutMs: number, requestId = ''): Promise<string> {
  const start = Date.now()
  let lastText = ''
  let stableSince = 0
  let sawNewNode = false
  let lastReported = -1

  /**
   * Tell the worker how much text has arrived.
   *
   * A thirty-second reply with no outward sign is indistinguishable from a
   * hang. Reporting the character count makes waiting visibly different from
   * being stuck, which is the whole point.
   */
  const report = (chars: number, generating: boolean): void => {
    if (chars === lastReported) return
    lastReported = chars
    void chrome.runtime.sendMessage({ type: 'ds:progress', requestId, chars, generating }).catch(() => {})
  }

  while (Date.now() - start < timeoutMs) {
    const nodes = assistantNodes()
    if (nodes.length > baselineCount) {
      sawNewNode = true
      const node = nodes[nodes.length - 1]
      const text = (node?.innerText ?? '').trim()
      report(text.length, true)
      if (text && text === lastText) {
        if (stableSince === 0) stableSince = Date.now()
        else if (Date.now() - stableSince >= STABLE_MS && !isGenerating()) {
          report(text.length, false)
          return text
        }
      } else {
        lastText = text
        stableSince = 0
      }
    }
    await sleep(POLL_MS)
  }

  if (!sawNewNode) {
    throw Object.assign(new Error('DeepSeek produced no reply node before timeout'), { code: 'timeout' })
  }
  if (lastText) return lastText
  throw Object.assign(new Error('DeepSeek reply timed out'), { code: 'timeout' })
}

async function sendPrompt(prompt: string, timeoutMs: number, requestId = ''): Promise<string> {
  if (busy) throw Object.assign(new Error('Bridge is already handling a prompt'), { code: 'busy' })
  busy = true
  try {
    if (!loggedIn()) {
      throw Object.assign(new Error('Not signed in to DeepSeek'), { code: 'not_logged_in' })
    }
    const composer = await waitForComposer()
    const baseline = assistantNodes().length

    setComposerValue(composer, prompt)
    // Give the app a beat to enable its send control after the input event.
    await sleep(180)
    submitComposer(composer)

    // If the composer still holds our text after a moment, the send did not
    // take; try once more with the other mechanism before giving up.
    await sleep(600)
    const stillThere =
      composer instanceof HTMLTextAreaElement ? composer.value.trim().length > 0 : (composer.textContent ?? '').trim().length > 0
    if (stillThere && assistantNodes().length === baseline) {
      submitComposer(composer)
    }

    const reply = await waitForReply(baseline, timeoutMs, requestId)
    if (BUSY_PATTERNS.some((re) => re.test(reply)) && reply.length < 400) {
      throw Object.assign(new Error(`DeepSeek is rate limiting: ${reply.slice(0, 120)}`), { code: 'busy' })
    }
    return reply
  } finally {
    busy = false
  }
}

async function startNewChat(): Promise<void> {
  const btn = queryAny<HTMLElement>(selectors.newChatButton)
  if (btn && isVisible(btn)) {
    btn.click()
    await sleep(900)
    return
  }
  // Navigating to the root reliably opens a blank chat when the button moves.
  if (location.pathname !== '/') {
    location.href = 'https://chat.deepseek.com/'
    await sleep(1500)
  }
}

/* ------------------------------------------------------------- messaging */

chrome.runtime.onMessage.addListener((msg: DeepSeekRequest, _sender, sendResponse) => {
  const respond = (r: DeepSeekResponse) => sendResponse(r)

  if (!msg || typeof msg !== 'object' || !('type' in msg)) return false

  switch (msg.type) {
    case 'ds:ping':
      respond({ ok: true, type: 'ds:pong', ready: Boolean(findComposer()), loggedIn: loggedIn() })
      return false

    case 'ds:status':
      respond({
        ok: true,
        type: 'ds:status',
        ready: Boolean(findComposer()),
        loggedIn: loggedIn(),
        busy,
        detail: location.href,
      })
      return false

    case 'ds:newChat':
      void startNewChat().then(
        () => respond({ ok: true, type: 'ds:newChat' }),
        (e: Error) => respond({ ok: false, error: e.message })
      )
      return true

    case 'ds:send': {
      const { requestId, prompt, timeoutMs } = msg
      void sendPrompt(prompt, timeoutMs, requestId).then(
        (text) => respond({ ok: true, type: 'ds:reply', requestId, text }),
        (e: Error & { code?: DeepSeekResponse extends { code?: infer C } ? C : never }) =>
          respond({ ok: false, error: e.message, code: (e as { code?: 'not_ready' | 'not_logged_in' | 'timeout' | 'busy' | 'dom_changed' }).code })
      )
      return true
    }

    default:
      return false
  }
})

// Announce readiness so a worker waiting on a fresh tab can proceed promptly.
void chrome.runtime.sendMessage({ type: 'ds:bridgeReady', href: location.href }).catch(() => {})
