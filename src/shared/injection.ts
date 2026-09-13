/**
 * Resolving content script paths at runtime.
 *
 * The bundler emits hashed filenames, and they change on every build, so
 * nothing may hard-code a path to an injected script. Reading them back out of
 * the live manifest is the only version that keeps working -- in the dev server
 * and in a packed release alike.
 *
 * Injection is needed in two situations the declared content scripts do not
 * cover: a tab that was already open when the extension was installed or
 * reloaded, and a domain the user added by hand.
 */

const DEEPSEEK_HINT = 'deepseek'

function manifestScripts(): chrome.runtime.ManifestV3['content_scripts'] {
  return chrome.runtime.getManifest().content_scripts ?? []
}

/** Built file paths for the DeepSeek bridge. */
export function deepseekBridgeFiles(): string[] {
  const entry = manifestScripts()?.find((s) => s.matches?.some((m) => m.includes(DEEPSEEK_HINT)))
  return entry?.js ?? []
}

/** Built file paths for the form agent. */
export function formAgentFiles(): string[] {
  const entry = manifestScripts()?.find((s) => !s.matches?.some((m) => m.includes(DEEPSEEK_HINT)))
  return entry?.js ?? []
}

/**
 * Inject a script into a tab, ignoring the failures that are expected rather
 * than exceptional: a page we lack host permission for, a tab that navigated
 * away mid-call, a restricted chrome:// URL.
 */
export async function injectFiles(
  tabId: number,
  files: string[],
  options: { allFrames?: boolean } = {}
): Promise<boolean> {
  if (files.length === 0) return false
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: options.allFrames ?? false },
      files,
    })
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Wait until a tab has finished loading.
 *
 * chrome.windows.create and chrome.tabs.create both resolve the moment the tab
 * exists, long before the page has parsed or its content scripts have run.
 * Messaging a tab in that window fails with "Could not establish connection.
 * Receiving end does not exist.", which reads like a missing script rather than
 * the race it actually is.
 */
export async function waitForTabComplete(tabId: number, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab) throw new Error(`Tab ${tabId} is gone`)
    if (tab.status === 'complete') return
    await sleep(250)
  }
  throw new Error(`Tab ${tabId} never finished loading`)
}

/**
 * Get a content script to answer, whatever state the tab is in.
 *
 * Handles the three ways the receiving end can be missing, in the order they
 * actually happen: the page has not loaded yet, the tab predates the extension
 * being installed or reloaded so no declared script ever ran, and the page is
 * simply slow to register its listener. Returns the reply to `ping` so the
 * caller can inspect it -- readiness is the caller's judgement, not ours.
 */
export async function ensureContentScript<T = unknown>(
  tabId: number,
  files: string[],
  ping: object,
  options: { timeoutMs?: number; allFrames?: boolean } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 25000
  const deadline = Date.now() + timeoutMs
  let injectAttempts = 0
  let lastError = 'no reply'

  while (Date.now() < deadline) {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, ping)) as T | undefined
      if (res !== undefined) return res
      lastError = 'content script returned nothing'
    } catch (e) {
      lastError = (e as Error).message
    }

    // A page that is still loading will register its script on its own; there
    // is nothing to fix by injecting, so wait it out first.
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab) throw new Error(`Tab ${tabId} is gone`)

    if (tab.status === 'complete' && injectAttempts < 2) {
      injectAttempts++
      await injectFiles(tabId, files, { allFrames: options.allFrames })
    }

    await sleep(300)
  }

  throw new Error(`Content script never responded on tab ${tabId}: ${lastError}`)
}
