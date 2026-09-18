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

/**
 * Built file paths for the form agent.
 *
 * Two declared scripts now match the job sites -- the agent itself and the
 * page-world visibility shim -- so "the entry that is not DeepSeek" is no
 * longer specific enough. The shim runs in the MAIN world and is never injected
 * programmatically, which is exactly what distinguishes them.
 */
export function formAgentFiles(): string[] {
  const entry = manifestScripts()?.find(
    (s) =>
      !s.matches?.some((m) => m.includes(DEEPSEEK_HINT)) &&
      (s as { world?: string }).world !== 'MAIN'
  )
  return entry?.js ?? []
}

/**
 * Does the extension hold host permission for this URL?
 *
 * Worth asking before blaming the page. Without permission Chrome runs no
 * declared content script, refuses every programmatic injection, and reports
 * the eventual sendMessage failure as "Could not establish connection.
 * Receiving end does not exist." -- which reads like a broken content script
 * and sent this project chasing selectors for an afternoon.
 */
export async function hasHostAccess(url: string): Promise<boolean> {
  if (!/^https?:/i.test(url)) return true
  try {
    return await chrome.permissions.contains({ origins: [originPattern(url)] })
  } catch {
    // Only a definite "no" is allowed to block an application. If the question
    // itself failed -- an unparseable URL, an API this runtime does not expose
    // -- assume access and let the real failure speak for itself, rather than
    // inventing a permission problem the user cannot act on.
    return true
  }
}

/** `https://jobs.example.com/x?y` -> `https://jobs.example.com/*`. */
export function originPattern(url: string): string {
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.hostname}/*`
}

/**
 * Inject a script into a tab.
 *
 * Returns the reason it failed rather than a bare false. The failures are not
 * interchangeable: a missing host permission is a standing condition the user
 * has to fix once, while a tab that navigated away mid-call is noise. Treating
 * both as "false" is what turned a one-click permission grant into an
 * unreadable connection error on every single application.
 */
export async function injectFiles(
  tabId: number,
  files: string[],
  options: { allFrames?: boolean } = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (files.length === 0) return { ok: false, error: 'no content script files in the manifest' }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: options.allFrames ?? false },
      files,
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
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
  let injectError = ''

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

    // No host permission means no declared script ran and no injection will
    // ever succeed, so there is nothing to wait out. Fail immediately with the
    // grant the user actually has to make -- twenty-five seconds of silence
    // followed by a connection error taught them nothing.
    const url = tab.url ?? tab.pendingUrl ?? ''
    if (url && !(await hasHostAccess(url))) {
      throw new PermissionError(url)
    }

    if (tab.status === 'complete' && injectAttempts < 2) {
      injectAttempts++
      const injected = await injectFiles(tabId, files, { allFrames: options.allFrames })
      if (!injected.ok) injectError = injected.error
    }

    await sleep(300)
  }

  const detail = injectError ? `${lastError}; injection failed: ${injectError}` : lastError
  throw new Error(`Content script never responded on tab ${tabId}: ${detail}`)
}

/**
 * A missing host permission, carrying the origin that needs granting.
 *
 * Typed rather than a plain Error so the runner can tell the one failure the
 * user can fix in a single click apart from the ones it should just retry.
 */
export class PermissionError extends Error {
  readonly origin: string

  constructor(url: string) {
    const origin = (() => {
      try {
        return originPattern(url)
      } catch {
        return url
      }
    })()
    super(
      `No access to ${origin}. Chrome blocks every script on a site the extension was not granted, ` +
        `so this application could not even be read. Open Settings -> Advanced -> Site access and ` +
        `grant access to job sites, then run again.`
    )
    this.name = 'PermissionError'
    this.origin = origin
  }
}
