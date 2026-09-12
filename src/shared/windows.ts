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
    return unpack(await chrome.windows.create(args))
  } catch (e) {
    if (!minimized) throw e

    // Some platforms and window managers refuse `state` at creation time.
    // Creating a plain unfocused window and minimizing it immediately gets to
    // the same place, at the cost of a brief flicker.
    log.debug(`Minimized window creation refused (${(e as Error).message}); retrying plainly`)
    const created = unpack(await chrome.windows.create({ url, focused: false, type: 'normal' }))
    await chrome.windows.update(created.windowId, { state: 'minimized' }).catch(() => {})
    return created
  }
}

function unpack(win: chrome.windows.Window | undefined): WorkerWindow {
  const tabId = win?.tabs?.[0]?.id
  if (win?.id === undefined || tabId === undefined) {
    throw new Error('Could not open a background window. Chrome refused the request.')
  }
  return { tabId, windowId: win.id }
}

export async function closeWorkerWindow(windowId: number | null | undefined): Promise<void> {
  if (windowId === null || windowId === undefined) return
  await chrome.windows.remove(windowId).catch(() => {})
}
