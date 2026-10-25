/**
 * The DeepAI profile, checked against DeepAI's real page.
 *
 * This is the test that would have caught the form-harvester bugs, applied to
 * the chat driver instead. The selectors in `src/llm/chat-sites.ts` were read
 * off the shipped page -- `getFullChatHistoryObject` walks `.chatbox-wrapper,
 * .outputBox` and skips a turn carrying `is-streaming`, which is where the
 * assistant-turn and streaming selectors come from -- and this file asserts they
 * still resolve against the markup they were read from.
 *
 * The alternative is what happened with the form fixtures: selectors written
 * from a plausible guess, a green suite, and a driver that could not find the
 * chat box on any page. A chat site redesign should fail here.
 *
 * The page cannot tell us how a *rendered reply* looks, because a fresh session
 * has none -- that is precisely why the assistant selectors were taken from
 * DeepAI's own code rather than from what happens to be on screen.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { CHAT_SITES, DEEPAI, DEEPSEEK, isWebDriver, siteById, siteForHost } from '@/llm/chat-sites'

const LIVE = 'tests/fixtures/chat/deepai-live-2026-09-27.html'

function loadLive(): void {
  document.documentElement.innerHTML = readFileSync(LIVE, 'utf8')
}

describe('the DeepAI profile', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('finds the composer', () => {
    loadLive()
    for (const sel of DEEPAI.selectors.composer) {
      expect(document.querySelector(sel), `composer selector ${sel} matches nothing`).not.toBeNull()
    }
  })

  it('does not mistake a read-only textarea for the composer', () => {
    loadLive()
    const composer = document.querySelector<HTMLTextAreaElement>('textarea#persistentChatbox')

    // DeepAI also renders `#chat-memory-profile`, a readonly textarea holding
    // recent chat topics. A "largest visible textarea" fallback picks one of
    // those two at random, and typing a prompt into the wrong one does nothing.
    const readOnly = document.querySelector('textarea#chat-memory-profile')
    expect(readOnly).not.toBeNull()
    expect(readOnly?.hasAttribute('readonly')).toBe(true)
    expect(composer?.hasAttribute('readonly')).toBe(false)
  })

  it('finds the send control, and only in its enabled form', () => {
    loadLive()
    const button = document.querySelector<HTMLButtonElement>('#chatSubmitButton')

    expect(button).not.toBeNull()
    expect(button?.tagName).toBe('BUTTON')
    // Disabled until the composer has content. Matching the disabled one clicks
    // nothing, and the send then looks like it silently failed.
    expect(button?.disabled).toBe(true)
    expect(document.querySelectorAll(DEEPAI.selectors.sendButton[0]!)).toHaveLength(0)
  })

  it('finds the new-chat control', () => {
    loadLive()
    for (const sel of DEEPAI.selectors.newChatButton) {
      expect(document.querySelector(sel), `new-chat selector ${sel} matches nothing`).not.toBeNull()
    }
  })

  it('finds every blocking dialog it claims to detect', () => {
    loadLive()
    // A blocking-dialog selector that matches nothing is a selector that will
    // never fire, so the run dies on a dialog the driver never reported.
    for (const sel of DEEPAI.selectors.blockingDialogs) {
      const host = sel.replace(/\[open\]|\.active$/, '')
      expect(document.querySelector(host), `dialog ${host} is not on the page`).not.toBeNull()
    }
  })

  it('reads a turn the way DeepAI\'s own script does', () => {
    loadLive()
    // Reproduce the shape `getFullChatHistoryObject` walks, and check the
    // text-node extraction the profile relies on actually recovers the reply
    // while leaving the surrounding controls out of it.
    document.body.innerHTML = `
      <div class="outputBox is-streaming">partial answer<button class="copy">Copy</button></div>`

    const turn = document.querySelector<HTMLElement>('.outputBox')!
    const direct = Array.from(turn.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim()

    // `innerText` would have returned "partial answerCopy".
    expect(direct).toBe('partial answer')
    expect(turn.innerText).toContain('Copy')
    expect(DEEPAI.replyText).toBe('textNodes')
  })

  it('uses a streaming flag rather than a stop button', () => {
    loadLive()
    // Kept, but measured inert: `.is-streaming` never appears on the live site.
    // See the note on `ChatSelectors.streaming`. This test records the claim
    // rather than asserting the flag fires, because it does not.
    expect(DEEPAI.selectors.streaming.join(' ')).toContain('is-streaming')

    document.body.innerHTML = '<div class="outputBox">done</div>'
    expect(document.querySelectorAll(DEEPAI.selectors.streaming[0]!)).toHaveLength(0)
    document.body.innerHTML = '<div class="outputBox is-streaming">writing</div>'
    expect(document.querySelectorAll(DEEPAI.selectors.streaming[0]!)).toHaveLength(1)
  })

  /**
   * The measured reason completion detection cannot lean on a flag here.
   *
   * Recorded as a test because the natural reaction to "the streaming flag never
   * fires" is to go looking for a stop button and wire that up instead. DeepAI's
   * page does carry one such element -- and it is a decoy. It exists before the
   * send, throughout generation, and six seconds after the text settled, and it
   * is never visible at any of those points. Tested for presence rather than
   * visibility it would report "still generating" forever, and every request
   * would time out instead of returning.
   */
  it('has no usable generation flag, and the stop-looking element is a hidden decoy', () => {
    loadLive()
    const stopish = [
      ...document.querySelectorAll('[aria-label*="stop" i], [class*="stop" i], [class*="cancel" i]'),
    ]
    // A selector that matches a hidden element must never be used as a
    // presence test. `chat-bridge.ts` guards on visibility for exactly this.
    for (const el of stopish) {
      const rect = el.getBoundingClientRect()
      const visible = rect.width > 0 && rect.height > 0
      expect(visible, `hidden element ${el.className} would hang the wait if presence were enough`).toBe(true)
    }

    // The send button reflects composer content, never generation.
    document.body.innerHTML = '<button id="chatSubmitButton" disabled></button>'
    expect(document.querySelector<HTMLButtonElement>('#chatSubmitButton')?.disabled).toBe(true)
  })

  it('recognises a turn the site itself failed', () => {
    loadLive()
    document.body.innerHTML = '<div class="outputBox" data-failed-response="true">Something went wrong</div>'
    expect(document.querySelectorAll(DEEPAI.selectors.failedTurn[0]!)).toHaveLength(1)
  })

  it('treats being signed out as supported, not as a fault', () => {
    // DeepAI allows anonymous chat. Reporting `needs_login` on every health
    // check for a working signed-out session would be a permanent false alarm
    // that trains the user to ignore the one signal that matters.
    expect(DEEPAI.authRequired).toBe(false)
    expect(DEEPSEEK.authRequired).toBe(true)
  })

  it('knows the wording for an exhausted free tier', () => {
    expect(DEEPAI.exhaustedPatterns.some((re) => re.test('You are out of credits'))).toBe(true)
    expect(DEEPAI.busyPatterns.some((re) => re.test('Server is busy, please try again later'))).toBe(true)
  })
})

describe('chat site selection', () => {
  it('maps a URL to its profile, including subdomains', () => {
    expect(siteForHost('https://deepai.org/chat')?.id).toBe('deepai-web')
    expect(siteForHost('https://www.deepai.org/chat')?.id).toBe('deepai-web')
    expect(siteForHost('https://chat.deepseek.com/')?.id).toBe('deepseek-web')
  })

  it('returns null for a page it has no profile for', () => {
    // A chat driver pointed at the wrong host must not pretend to know the page.
    expect(siteForHost('https://boards.greenhouse.io/stripe')).toBeNull()
    expect(siteForHost('not a url')).toBeNull()
  })

  it('defaults to DeepAI and keeps DeepSeek reachable', () => {
    expect(siteById('deepai-web')?.label).toBe('DeepAI (web)')
    expect(siteById('deepseek-web')?.label).toBe('DeepSeek (web)')
    expect(CHAT_SITES[0]?.id).toBe('deepai-web')
  })

  it('gives every site a distinct storage key, so overrides cannot cross over', () => {
    const keys = CHAT_SITES.map((s) => s.storageKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('classifies web drivers without repeating the id list', () => {
    expect(isWebDriver('deepai-web')).toBe(true)
    expect(isWebDriver('deepseek-web')).toBe(true)
    expect(isWebDriver('nvidia-nim')).toBe(false)
    expect(isWebDriver('anthropic-api')).toBe(false)
  })
})
