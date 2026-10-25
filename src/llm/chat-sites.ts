/**
 * The chat sites the agent can be driven through.
 *
 * One bridge implementation serves every site here; this file is the only place
 * that knows what any of them look like. When a site changes its markup, this is
 * the only file to repair, and the options page can override any selector in it
 * at runtime so a break is fixable without a rebuild.
 *
 * Every selector below was read off the shipped page rather than guessed. That
 * distinction is the whole point of the file: DeepAI's own script hands over the
 * contract in `getFullChatHistoryObject`, which walks `.chatbox-wrapper,
 * .outputBox` -- the first for a user turn, the second for the assistant's --
 * and skips a turn while it carries `is-streaming`. Guessing here is what the
 * form harvester did wrong for weeks, and the suite did not catch it because the
 * fixtures were written from the same guesses.
 */

export type ChatSelectors = {
  /** The text box a prompt is typed into. */
  composer: string[]
  /** The control that sends. Matched only when it is enabled. */
  sendButton: string[]
  /**
   * Present while the model is still writing.
   *
   * Read off DeepAI's own script, which skips a turn carrying `is-streaming` --
   * and then measured against the live site, where it never appears. Across a
   * 26-second, 17,847-character reply, a MutationObserver recorded 2,837
   * changes and not one mentioned it. The send button stays disabled throughout
   * (it tracks composer content, not generation) and the only element matching
   * a stop/cancel selector is static chrome present before, during and after.
   *
   * So this list is currently inert, and the bridge's real completion test is
   * text stability. It is kept because it costs nothing and DeepAI's own code
   * still guards for it, meaning it may come back -- but nothing may depend on
   * it, and the DeepSeek entry below is the one that genuinely fires.
   */
  streaming: string[]
  /** A turn the site itself failed. Reported instead of returned as an answer. */
  failedTurn: string[]
  /** One node per assistant turn, in document order. */
  assistantMessage: string[]
  newChatButton: string[]
  /**
   * Auth state that means "this session cannot continue".
   *
   * Only a dialog that is actually open counts. DeepAI lets an anonymous visitor
   * chat, so merely being signed out is not a fault -- but its login nudge and
   * its out-of-credits dialog both sit over the composer and stop the run, and
   * those are reported rather than waited out.
   */
  blockingDialogs: string[]
  /** A visible control that offers to sign in. Advisory, not blocking. */
  loginIndicator: string[]
}

export type ChatSite = {
  id: string
  label: string
  /** Chrome match pattern for the worker's tab. */
  match: string
  /** Where a worker tab is opened. */
  chatUrl: string
  /** Storage key holding the user's selector overrides for this site. */
  storageKey: string
  selectors: ChatSelectors
  /**
   * How to read the reply out of a turn node.
   *
   * `textNodes` sums only direct text-node children, which is what DeepAI's own
   * code does: the reply is plain text under `.outputBox`, and `innerText`
   * would also pick up the copy/share buttons sitting beside it. `innerText` is
   * right for a site that renders the answer as markdown elements.
   */
  replyText: 'textNodes' | 'innerText'
  /**
   * Whether a reply is refused without an account.
   *
   * True for a site that will not talk at all when signed out. False for one
   * that allows anonymous use, where reporting `needs_login` on every health
   * check would be a permanent false alarm.
   */
  authRequired: boolean
  /** Wording that means "try again later", treated as retryable, not as an answer. */
  busyPatterns: RegExp[]
  /** Wording that means the account has nothing left to spend. */
  exhaustedPatterns: RegExp[]
}

/* ------------------------------------------------------------------ DeepAI */

export const DEEPAI: ChatSite = {
  id: 'deepai-web',
  label: 'DeepAI (web)',
  match: 'https://deepai.org/*',
  chatUrl: 'https://deepai.org/chat',
  storageKey: 'deepaiSelectors',
  replyText: 'textNodes',
  // Anonymous chat works, so this is false: a signed-out session is a supported
  // one, not a broken one.
  authRequired: false,
  selectors: {
    composer: ['textarea#persistentChatbox', 'textarea.chatbox'],
    // The button is a real <button disabled> until the composer has content, so
    // matching the disabled one would click nothing and look like it worked.
    sendButton: ['button#chatSubmitButton:not([disabled])'],
    failedTurn: ['.outputBox[data-failed-response="true"]'],
    assistantMessage: ['.outputBox'],
    newChatButton: ['#sidebarNewChatBtn', '.sidebar-new-chat-btn'],
    // Measured on the live site and currently never matching -- see the
    // `streaming` note on ChatSelectors. Kept for the day it returns.
    streaming: ['.outputBox.is-streaming'],
    // `<dialog>.showModal()` sets [open]; the nudge popup toggles `.active`.
    blockingDialogs: [
      'dialog#login-modal[open]',
      'dialog#out-of-credits-modal[open]',
      '#nudge-popup.active',
    ],
    loginIndicator: ['#login-via-email-id', '#social-auth-google'],
  },
  busyPatterns: [
    /server is busy/i,
    /please try again later/i,
    /rate limit/i,
    /too many requests/i,
    /high demand/i,
  ],
  exhaustedPatterns: [/out of credits/i, /upgrade to pro/i, /purchase credits/i],
}

/* ---------------------------------------------------------------- DeepSeek */

export const DEEPSEEK: ChatSite = {
  id: 'deepseek-web',
  label: 'DeepSeek (web)',
  match: 'https://chat.deepseek.com/*',
  chatUrl: 'https://chat.deepseek.com/',
  storageKey: 'deepseekSelectors',
  replyText: 'innerText',
  authRequired: true,
  selectors: {
    composer: ['textarea#chat-input', 'textarea[placeholder]', 'div[contenteditable="true"]'],
    sendButton: [
      'div[role="button"][aria-disabled="false"]:has(svg)',
      'button[type="submit"]',
      'div[class*="send"]',
    ],
    // No per-turn streaming flag to read, so the stop control is the signal.
    streaming: ['div[class*="stop"]', 'button[aria-label*="Stop" i]', 'div[aria-label*="Stop" i]'],
    failedTurn: ['[class*="ErrorMessage"]'],
    assistantMessage: ['.ds-markdown', '[class*="ds-markdown"]', '[class*="markdown"]'],
    newChatButton: [
      'div[class*="new-chat"]',
      'a[href="/"]',
      'button[aria-label*="New chat" i]',
      'div[aria-label*="New chat" i]',
    ],
    blockingDialogs: ['input[type="password"]', 'form[action*="login"]'],
    loginIndicator: ['input[type="password"]', 'form[action*="login"]'],
  },
  busyPatterns: [
    /the server is busy/i,
    /please try again later/i,
    /rate limit/i,
    /too many requests/i,
  ],
  exhaustedPatterns: [],
}

export const CHAT_SITES: ChatSite[] = [DEEPAI, DEEPSEEK]

/** The site a URL belongs to, or null. */
export function siteForHost(url: string): ChatSite | null {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  for (const site of CHAT_SITES) {
    const siteHost = new URL(site.match.replace('/*', '')).hostname
    if (host === siteHost || host.endsWith(`.${siteHost}`)) return site
  }
  return null
}

export function siteById(id: string): ChatSite | null {
  return CHAT_SITES.find((s) => s.id === id) ?? null
}

/**
 * Is this driver a browser-driven chat site rather than an API?
 *
 * Several decisions are the same for every chat site and the opposite for every
 * API driver: which timeout an unattended run should use, whether a model name
 * is worth assessing at all, whether there is a second driver to fail over to.
 * Asking "is it a web driver" once beats repeating the id list, and adding a
 * third chat site does not mean finding every one of those places.
 */
export function isWebDriver(driverId: string): boolean {
  return driverId.endsWith('-web')
}
