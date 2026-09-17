/**
 * Opening the background windows the agent works in.
 *
 * There is one rule here and it is the reason this file exists:
 * `chrome.windows.create` refuses `state` when it is passed alongside `left`,
 * `top`, `width` or `height`, and fails the whole call with
 *
 *   "The 'state' property cannot be used with 'left', 'top', 'width', or 'height'."
 *
 * Every window the agent opens was asking for both, so the first call of every
 * run threw and the agent never started. Centralising window creation means
 * that combination cannot be reintroduced in one call site and missed in the
 * others.
 */

import { createLogger } from './logger'

const log = createLogger('windows')

export type WorkerWindow = { tabId: number; windowId: number }

export type OpenOptions = {
  /** Keep the window out of the way. Bounds are ignored when this is set. */
  minimized?: boolean
  width?: number
  height?: number
}

export async function openWorkerWindow(url: string, options: OpenOptions = {}): Promise<WorkerWindow> {
  const minimized = options.minimized ?? true

  // Bounds and a minimized state are mutually exclusive, so a minimized window
  // is created without them. Its size does not matter while it is minimized.
  const args: chrome.windows.CreateData = minimized
    ? { url, focused: false, type: 'normal', state: 'minimized' }
    : {
        url,
        focused: false,
        type: 'normal',
        ...(options.width === undefined ? {} : { width: options.width }),
        ...(options.height === undefined ? {} : { height: options.height }),
      }

  try {
    return await unpack(await chrome.windows.create(args))
  } catch (e) {
    if (!minimized) throw e

    // Some platforms and window managers refuse `state` at creation time.
    // Creating a plain unfocused window and minimizing it immediately gets to
    // the same place, at the cost of a brief flicker.
    log.debug(`Minimized window creation refused (${(e as Error).message}); retrying plainly`)
    const created = await unpack(await chrome.windows.create({ url, focused: false, type: 'normal' }))
    await chrome.windows.update(created.windowId, { state: 'minimized' }).catch(() => {})
    return created
  }
}

async function unpack(win: chrome.windows.Window | undefined): Promise<WorkerWindow> {
  const tabId = win?.tabs?.[0]?.id
  if (win?.id === undefined || tabId === undefined) {
    throw new Error('Could not open a background window. Chrome refused the request.')
  }
  // Awaited on purpose: an eviction between `windows.create` resolving and the
  // ownership write left a minimized window nobody owned and nobody reaped --
  // one invisible window per occurrence, all night long.
  await remember(win.id)
  return { tabId, windowId: win.id }
}

/** Record an id the agent did not create but has taken over (adopted tab windows). */
export async function rememberOwnedWindow(windowId: number): Promise<void> {
  await remember(windowId)
}

/**
 * Windows this agent created, by id.
 *
 * Ownership has to be tracked explicitly because the agent is not the only
 * thing opening windows on this machine. Without it, "close the window we
 * finished with" and "tidy up anything left behind" both degrade into "close
 * whatever looks agent-shaped", which is how a run ends up closing the user's
 * own tabs while they are working.
 *
 * Kept in `chrome.storage.session` as well as memory: the service worker can be
 * evicted mid-run, and a window whose owner has been forgotten is exactly the
 * window that leaks.
 */
const owned = new Set<number>()
const OWNED_KEY = 'windows:owned'

async function remember(windowId: number): Promise<void> {
  owned.add(windowId)
  try {
    await chrome.storage.session.set({ [OWNED_KEY]: [...owned] })
  } catch {
    // Memory-only tracking still covers the common case.
  }
}

async function forget(windowId: number): Promise<void> {
  owned.delete(windowId)
  try {
    await chrome.storage.session.set({ [OWNED_KEY]: [...owned] })
  } catch {
    // Ignore.
  }
}

/** Re-read ownership after a service worker restart. */
export async function loadOwnedWindows(): Promise<Set<number>> {
  try {
    const stored = await chrome.storage.session.get(OWNED_KEY)
    for (const id of (stored?.[OWNED_KEY] as number[] | undefined) ?? []) owned.add(id)
  } catch {
    // Ignore.
  }
  return new Set(owned)
}

export function isOwnedWindow(windowId: number | null | undefined): boolean {
  return windowId !== null && windowId !== undefined && owned.has(windowId)
}

/**
 * Close a window the agent opened.
 *
 * Refuses windows it does not own, so a mistaken id cannot take the user's
 * work with it.
 */
export async function closeWorkerWindow(windowId: number | null | undefined): Promise<void> {
  if (windowId === null || windowId === undefined) return
  if (!owned.has(windowId)) {
    log.debug(`Refusing to close window ${windowId}: not one of ours`)
    return
  }
  await chrome.windows.remove(windowId).catch(() => {})
  await forget(windowId)
}

/** Close every window still open from this run. Used on stop and on wake. */
export async function closeAllWorkerWindows(): Promise<number> {
  await loadOwnedWindows()
  let closed = 0
  for (const windowId of [...owned]) {
    const existing = await chrome.windows.get(windowId).catch(() => null)
    if (existing) {
      await chrome.windows.remove(windowId).catch(() => {})
      closed++
    }
    await forget(windowId)
  }
  return closed
}
