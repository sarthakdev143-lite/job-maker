/**
 * Keeping the service worker alive across long waits.
 *
 * Manifest V3 evicts an extension service worker after roughly 30 seconds with
 * no extension API activity. A pending `setTimeout` does not count: the timer
 * keeps ticking, but the worker holding it is gone, so the continuation never
 * runs. Every wait in this agent longer than half a minute was therefore a
 * guaranteed kill -- most visibly the 45-180s pause between applications, which
 * meant an unattended overnight run died at the first gap and only resumed when
 * the next periodic alarm fired up to thirty minutes later.
 *
 * Calling any extension API resets that idle timer. So the fix is not to sleep
 * for a long time at all: sleep in short chunks and touch an API between them.
 *
 * Two shapes are offered because there are two kinds of wait:
 *
 *  - `durableSleep` for a wait of known length (the pause between applications).
 *  - `startHeartbeat` for an open-ended stretch of work that might itself go
 *    quiet (the model driver waiting on a reply in another tab).
 *
 * Both take their ticker as an argument so they can be tested without Chrome.
 */

import { sleep } from './util'

/**
 * How long to go between pokes.
 *
 * Comfortably inside the ~30s eviction window, with enough margin that a busy
 * machine delaying the timer by a few seconds does not lose the worker anyway.
 */
export const HEARTBEAT_INTERVAL_MS = 20_000

/** Something cheap that counts as extension API activity. */
export type Ticker = () => Promise<unknown>

/**
 * The default poke.
 *
 * `getPlatformInfo` is the cheapest always-available call that reaches the
 * browser process; it takes no arguments and cannot fail for reasons we would
 * care about. Errors are swallowed because a failed keepalive must never be the
 * thing that breaks a run.
 */
export const defaultTicker: Ticker = async () => {
  try {
    return await chrome.runtime.getPlatformInfo()
  } catch {
    return null
  }
}

/**
 * Run a ticker without letting it throw.
 *
 * A keepalive that can fail the thing it is keeping alive is worse than no
 * keepalive at all, so every poke in this module goes through here. A ticker
 * that rejects has already failed at its one job; propagating the rejection
 * would additionally abort the caller's wait and, from `setInterval`, surface
 * as an unhandled rejection.
 */
async function poke(ticker: Ticker): Promise<void> {
  try {
    await ticker()
  } catch {
    // Nothing useful to do: the next beat tries again.
  }
}

export type DurableSleepOptions = {
  ticker?: Ticker
  /** Checked between chunks so a stop request does not wait out the full delay. */
  shouldStop?: () => boolean
  /** Injectable for tests; defaults to the real timer. */
  sleepFn?: (ms: number) => Promise<void>
  intervalMs?: number
}

/**
 * Wait `totalMs`, staying alive throughout.
 *
 * Returns early when `shouldStop` turns true, so pressing stop during the gap
 * between applications takes effect immediately rather than up to three minutes
 * later.
 */
export async function durableSleep(totalMs: number, options: DurableSleepOptions = {}): Promise<void> {
  const {
    ticker = defaultTicker,
    shouldStop,
    sleepFn = sleep,
    intervalMs = HEARTBEAT_INTERVAL_MS,
  } = options

  let remaining = Math.max(0, totalMs)
  while (remaining > 0) {
    if (shouldStop?.()) return
    await poke(ticker)
    const chunk = Math.min(intervalMs, remaining)
    await sleepFn(chunk)
    remaining -= chunk
  }
  // One final poke, so the caller resumes with a full idle window ahead of it
  // rather than whatever was left of the last chunk's.
  await poke(ticker)
}

export type Heartbeat = {
  /** Stop poking. Safe to call more than once. */
  stop: () => void
}

/**
 * Poke the browser on an interval until stopped.
 *
 * Used to wrap a whole run rather than one wait: the model driver can sit
 * waiting on a reply in a DeepSeek tab for minutes without touching an
 * extension API itself, and that is just as fatal as a long sleep.
 */
export function startHeartbeat(options: { ticker?: Ticker; intervalMs?: number } = {}): Heartbeat {
  const { ticker = defaultTicker, intervalMs = HEARTBEAT_INTERVAL_MS } = options

  const handle = setInterval(() => {
    void poke(ticker)
  }, intervalMs)

  let stopped = false
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      clearInterval(handle)
    },
  }
}
