/**
 * Chat-site bridge.
 *
 * Runs inside whichever chat site the driver has opened and does exactly one
 * job: accept a prompt from the service worker, type it into the composer, wait
 * for the streamed reply to finish, and hand back the text.
 *
 * This is the most brittle file in the extension by design -- it is the only
 * place that runs inside somebody else's page, so when their UI changes this is
 * the only file to repair. Everything site-specific lives in
 * `src/llm/chat-sites.ts` instead of here, and every selector in it is
 * overridable at runtime from the options page (storage key
 * `deepaiSelectors` / `deepseekSelectors`) so a break can be fixed without
 * rebuilding the extension.
 */

import type { ChatBridgeErrorCode, ChatRequest, ChatResponse } from '@/shared/messages'
import { siteForHost, type ChatSelectors, type ChatSite } from '@/llm/chat-sites'
import { personaForPage, type Persona } from '@/human/persona'
import { typeInto, typingOptionsFor } from '@/human/typing'
import { humanClick } from '@/human/pointer'

/**
 * Which site this page is.
 *
 * Resolved from the URL rather than injected, so one built file serves every
 * site the manifest matches and adding a third needs no new content script.
 */
const site: ChatSite | null = siteForHost(location.href)

const DEFAULT_SELECTORS: ChatSelectors | null = site?.selectors ?? null

/**
 * Text stability window: the reply is done once it stops changing for this long.
 *
 * For DeepAI this is not a belt-and-braces check, it is the whole test. Their
 * `is-streaming` class never appears on a live page -- measured over a
 * 26-second, 17,847-character reply, where a MutationObserver saw 2,837 changes
 * and none of them mentioned it -- and the send button tracks composer content
 * rather than generation. So nothing on that page says "still writing", and
 * "stopped changing" is the only evidence available.
 *
 * The number comes from measurement rather than taste: chunks arrived every
 * 60-650ms across that reply, so 1.4s was barely twice the largest observed gap
 * and a single slow chunk boundary could truncate a reply. A truncated reply
 * fails JSON validation in the broker and costs a retry, which is survivable --
 * but the window is set to roughly four times the largest gap seen so that
 * truncation is the exception rather than the rule.
 */
const STABLE_MS = 2600
const POLL_MS = 300

let selectors: ChatSelectors = DEFAULT_SELECTORS ?? {
  composer: [],
  sendButton: [],
  streaming: [],
  failedTurn: [],
  assistantMessage: [],
  newChatButton: [],
  blockingDialogs: [],
  loginIndicator: [],
}
let busy = false

if (!site) {
  // Injected on a page we have no profile for. Say so rather than sitting mute,
  // which reads as a hung worker.
  console.warn('[autoapply] chat bridge loaded on an unrecognised host:', location.hostname)
}

void loadSelectorOverrides()

async function loadSelectorOverrides(): Promise<void> {
  if (!site) return
  try {
    const bag = await chrome.storage.local.get(site.storageKey)
    const override = bag[site.storageKey] as Partial<ChatSelectors> | undefined
    if (!override) return
    // An empty override list means "I cleared this to try the defaults", so
    // only a non-empty list replaces anything.
    const merged: ChatSelectors = { ...selectors }
    for (const key of Object.keys(selectors) as Array<keyof ChatSelectors>) {
      const list = override[key]
      if (Array.isArray(list) && list.length > 0) {
        ;(merged as Record<string, unknown>)[key] = list
      }
    }
    selectors = merged
  } catch {
    // Storage unavailable: the shipped selectors are the fallback, and being
    // unable to read an override is no reason to fail a request.
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

/** Selector used for the composer's node, for log and error text. */
const siteName = site?.label ?? 'this chat site'

function fail(message: string, code: ChatBridgeErrorCode): Error {
  return Object.assign(new Error(message), { code })
}

function findComposer(): HTMLTextAreaElement | HTMLElement | null {
  const el = queryAny<HTMLTextAreaElement>(selectors.composer)
  if (el && isVisible(el)) return el
  if (el) return el
  // Last resort: the largest visible textarea on the page.
  const areas = Array.from(document.querySelectorAll('textarea')).filter(
    (a) => isVisible(a) && !a.hasAttribute('readonly')
  )
  if (areas.length === 0) return null
  return areas.sort(
    (a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width
  )[0] as HTMLTextAreaElement
}

function assistantNodes(): HTMLElement[] {
  return queryAllAny<HTMLElement>(selectors.assistantMessage).filter(isVisible)
}

/**
 * The reply text out of one turn node.
 *
 * `textNodes` mirrors what DeepAI's own script does: the answer is plain text
 * directly under the turn, and `innerText` would swallow the copy and share
 * controls sitting beside it. `innerText` is correct for a site that renders the
 * answer as markdown elements, and is also the fallback when the direct text
 * nodes turn out to be empty.
 */
function readTurn(el: HTMLElement): string {
  if (site?.replyText === 'textNodes') {
    const hidden = el.querySelector('.hiddenTextContainer')
    const source = hidden ?? el
    let text = ''
    for (const child of Array.from(source.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? ''
    }
    if (text.trim()) return text.trim()
  }
  return (el.innerText ?? '').trim()
}

/**
 * Is the model still writing?
 *
 * The visibility check is not optional, and losing it is a hang rather than a
 * wrong answer. DeepAI's page carries a hidden `class*="stop"` element that
 * exists before, during and after generation and is never once visible --
 * measured at every stage of a real reply. Testing only for its presence
 * therefore reports "still generating" permanently, and the wait never ends.
 * Anything matched here has to be on screen.
 */
function isGenerating(): boolean {
  const el = queryAny(selectors.streaming)
  return Boolean(el && isVisible(el))
}

/** A turn the site itself declared failed, if the newest one is. */
function failedTurnText(): string {
  const failed = queryAllAny<HTMLElement>(selectors.failedTurn).filter(isVisible)
  const last = failed[failed.length - 1]
  if (!last) return ''
  return readTurn(last) || last.getAttribute('data-failed-response') || 'the site reported a failed response'
}

/**
 * A dialog sitting over the composer, which stops the run.
 *
 * Distinct from being signed out: DeepAI allows anonymous chat, so a signed-out
 * session is a working one. What cannot be worked around is its login nudge and
 * its out-of-credits dialog, both of which cover the composer and neither of
 * which goes away on its own.
 */
function blockingDialog(): HTMLElement | null {
  for (const sel of selectors.blockingDialogs) {
    try {
      const el = document.querySelector<HTMLElement>(sel)
      if (el && isVisible(el)) return el
    } catch {
      // Ignore and try the next candidate.
    }
  }
  return null
}

function loggedIn(): boolean {
  const blocked = blockingDialog()
  // Out of credits is not an auth problem and must not be reported as one.
  if (blocked && /credit/i.test(blocked.id + ' ' + blocked.className)) return true
  if (blocked) return false
  if (site && !site.authRequired) return true
  if (queryAny(selectors.loginIndicator)) return false
  return Boolean(findComposer())
}

/**
 * Type the prompt into the composer in irregular bursts.
 *
 * Writing the whole prompt in one assignment is the clearest automation tell
 * there is, and some composers only enable their send control after a run of
 * input events. `typeInto` also goes through the native value setter, which is
 * what makes React's controlled input actually see the text -- assigning
 * `.value` updates the DOM but not the app's state, and it then sends an empty
 * message. The plan is budget bound, so even a very long prompt finishes in
 * about two seconds.
 */
async function typeComposerValue(el: HTMLElement, value: string, persona: Persona): Promise<void> {
  await typeInto(el, value, typingOptionsFor(persona, { budgetMs: 2200 }))
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
async function submitComposer(composer: HTMLElement, persona: Persona): Promise<void> {
  const explicit = queryAny<HTMLElement>(selectors.sendButton)
  if (explicit && isVisible(explicit) && (explicit as HTMLButtonElement).disabled !== true) {
    await humanClick(explicit, { pressMs: persona.pressMs, scroll: false })
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
  throw fail(`${siteName} composer not found`, 'dom_changed')
}

/**
 * Wait for a reply that started after `baselineCount` turns existed.
 *
 * Completion is "text stopped changing for STABLE_MS and nothing is streaming".
 * On a site with a real streaming flag that is a genuine two-signal test; on
 * DeepAI only the first half fires. See STABLE_MS for what that costs and what
 * catches it when it goes wrong.
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
    void chrome.runtime.sendMessage({ type: 'chat:progress', requestId, chars, generating }).catch(() => {})
  }

  while (Date.now() - start < timeoutMs) {
    const failure = failedTurnText()
    if (failure) {
      if (site?.exhaustedPatterns.some((re) => re.test(failure))) {
        throw fail(`${siteName} has no credits left: ${failure.slice(0, 160)}`, 'exhausted')
      }
      throw fail(`${siteName} reported a failed response: ${failure.slice(0, 200)}`, 'dom_changed')
    }

    const dialog = blockingDialog()
    if (dialog) {
      const text = `${dialog.id} ${dialog.className}`
      if (/credit/i.test(text)) throw fail(`${siteName} is out of credits`, 'exhausted')
      throw fail(`${siteName} is showing a dialog over the chat box (${dialog.id || 'unknown'}). Sign in and close it.`, 'not_logged_in')
    }

    const nodes = assistantNodes()
    if (nodes.length > baselineCount) {
      sawNewNode = true
      const node = nodes[nodes.length - 1]
      const text = node ? readTurn(node) : ''
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
    throw fail(`${siteName} produced no reply before the timeout`, 'timeout')
  }
  if (lastText) return lastText
  throw fail(`${siteName} reply timed out`, 'timeout')
}

async function sendPrompt(prompt: string, timeoutMs: number, requestId = ''): Promise<string> {
  if (busy) throw fail('Bridge is already handling a prompt', 'busy')
  busy = true
  try {
    if (site && !loggedIn()) {
      throw fail(`Not signed in to ${site.label}`, 'not_logged_in')
    }
    const composer = await waitForComposer()
    const persona = await personaForPage()
    const baseline = assistantNodes().length

    await typeComposerValue(composer, prompt, persona)
    // Give the app a beat to enable its send control after the input event.
    await sleep(180)
    await submitComposer(composer, persona)

    // If the composer still holds our text after a moment, the send did not
    // take; try once more with the other mechanism before giving up.
    await sleep(600)
    const stillThere =
      composer instanceof HTMLTextAreaElement
        ? composer.value.trim().length > 0
        : (composer.textContent ?? '').trim().length > 0
    if (stillThere && assistantNodes().length === baseline) {
      await submitComposer(composer, persona)
    }

    const reply = await waitForReply(baseline, timeoutMs, requestId)
    if (site?.busyPatterns.some((re) => re.test(reply)) && reply.length < 400) {
      throw fail(`${site.label} is rate limiting: ${reply.slice(0, 120)}`, 'busy')
    }
    return reply
  } finally {
    busy = false
  }
}

async function startNewChat(): Promise<void> {
  if (!site) return
  const btn = queryAny<HTMLElement>(selectors.newChatButton)
  if (btn && isVisible(btn)) {
    await humanClick(btn, { scroll: false })
    await sleep(900)
    return
  }
  // Navigating to the chat root reliably opens a blank conversation when the
  // button moves.
  const root = new URL(site.chatUrl).pathname
  if (location.pathname !== root) {
    location.href = site.chatUrl
    await sleep(1500)
  }
}

/* ------------------------------------------------------------- messaging */

chrome.runtime.onMessage.addListener((msg: ChatRequest, _sender, sendResponse) => {
  const respond = (r: ChatResponse) => sendResponse(r)
  const siteId = site?.id ?? 'unknown'

  if (!msg || typeof msg !== 'object' || !('type' in msg)) return false
  if (!String(msg.type).startsWith('chat:')) return false

  switch (msg.type) {
    case 'chat:ping':
      respond({ ok: true, type: 'chat:pong', ready: Boolean(findComposer()), loggedIn: loggedIn(), site: siteId })
      return false

    case 'chat:status': {
      const dialog = blockingDialog()
      respond({
        ok: true,
        type: 'chat:status',
        ready: Boolean(findComposer()),
        loggedIn: loggedIn(),
        busy,
        detail: dialog ? `blocked by #${dialog.id || 'unknown'}` : location.href,
        site: siteId,
      })
      return false
    }

    case 'chat:newChat':
      void startNewChat().then(
        () => respond({ ok: true, type: 'chat:newChat' }),
        (e: Error) => respond({ ok: false, error: e.message })
      )
      return true

    case 'chat:send': {
      const { requestId, prompt, timeoutMs } = msg
      void sendPrompt(prompt, timeoutMs, requestId).then(
        (text) => respond({ ok: true, type: 'chat:reply', requestId, text }),
        (e: Error & { code?: ChatBridgeErrorCode }) =>
          respond({ ok: false, error: e.message, code: e.code })
      )
      return true
    }

    default:
      return false
  }
})

// Announce readiness so a worker waiting on a fresh tab can proceed promptly.
void chrome.runtime.sendMessage({ type: 'chat:bridgeReady', site: site?.id ?? 'unknown' }).catch(() => {})
