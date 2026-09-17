/**
 * Run state that survives the service worker.
 *
 * The orchestrator kept "am I running?" in a class field on a singleton, which
 * is exactly as durable as the service worker holding it -- that is, about
 * thirty idle seconds. When Chrome evicted the worker mid-run the agent did not
 * pause, it forgot: the next wake read `running: false`, reported itself idle,
 * and waited for a periodic alarm before doing anything again.
 *
 * Storing the flag outside the worker makes eviction a hiccup instead of a
 * stop. `chrome.storage.local` rather than `session` on purpose: an overnight
 * run should also survive Chrome restarting itself for an update at 4am.
 *
 * A stale record is the obvious hazard -- a crash during a run leaves
 * `running: true` for ever -- so every beat stamps the time. Callers can see
 * how long ago the run was last known to be alive and decide for themselves,
 * but nothing here refuses to resume on age alone: the real master switch is
 * `settings.autonomy.enabled`, and second-guessing it from a timestamp is how
 * an agent ends up silently declining to work.
 */

import { createLogger } from '@/shared/logger'

const log = createLogger('run-state')

const KEY = 'agent:runState'

/** Beyond this, the last beat is old enough to be worth mentioning in a log. */
export const STALE_AFTER_MS = 5 * 60_000

export type PersistedRun = {
  running: boolean
  startedAt: number | null
  /**
   * Whether a person pressed Start.
   *
   * Carried across eviction so a resumed run keeps ignoring the active-hours
   * window exactly as the original did. Losing it meant a manual run started at
   * 11pm silently turned itself into a scheduled one on the first resume and
   * then refused to work until 9am.
   */
  manual: boolean
  /** When the run last proved it was alive. */
  lastBeatAt: number
}

const IDLE: PersistedRun = { running: false, startedAt: null, manual: false, lastBeatAt: 0 }

export async function loadRunState(): Promise<PersistedRun> {
  try {
    const stored = await chrome.storage.local.get(KEY)
    const value = stored?.[KEY] as Partial<PersistedRun> | undefined
    if (!value || typeof value !== 'object') return { ...IDLE }
    return {
      running: Boolean(value.running),
      startedAt: typeof value.startedAt === 'number' ? value.startedAt : null,
      manual: Boolean(value.manual),
      lastBeatAt: typeof value.lastBeatAt === 'number' ? value.lastBeatAt : 0,
    }
  } catch (e) {
    log.debug(`Could not read run state: ${(e as Error).message}`)
    return { ...IDLE }
  }
}

export async function saveRunState(state: Omit<PersistedRun, 'lastBeatAt'>): Promise<void> {
  await write({ ...state, lastBeatAt: Date.now() })
}

/** Stamp the clock without touching the rest of the record. */
export async function beat(): Promise<void> {
  const current = await loadRunState()
  if (!current.running) return
  await write({ ...current, lastBeatAt: Date.now() })
}

export async function clearRunState(): Promise<void> {
  await write({ ...IDLE })
}

/** True when a run was in progress and the worker has since been replaced. */
export function looksInterrupted(state: PersistedRun, now = Date.now()): boolean {
  return state.running && now - state.lastBeatAt > STALE_AFTER_MS
}

async function write(state: PersistedRun): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEY]: state })
  } catch (e) {
    // Losing the record degrades resume-after-eviction; it must not fail a run.
    log.debug(`Could not persist run state: ${(e as Error).message}`)
  }
}

const BREAKER_KEY = 'agent:breakerFailures'

/**
 * Consecutive application failures, kept outside the worker.
 *
 * The circuit breaker used to count in a memory field that reset to zero on
 * every eviction -- so a site failing all night never tripped it -- while a
 * trip itself left the persisted run flag on, resurrecting the run it had just
 * killed on the next wake. Persisting the count makes both directions honest.
 */
export async function loadBreakerCount(): Promise<number> {
  try {
    const stored = await chrome.storage.local.get(BREAKER_KEY)
    const value = stored?.[BREAKER_KEY]
    return typeof value === 'number' && value >= 0 ? Math.floor(value) : 0
  } catch {
    return 0
  }
}

export async function saveBreakerCount(count: number): Promise<void> {
  try {
    await chrome.storage.local.set({ [BREAKER_KEY]: Math.max(0, Math.floor(count)) })
  } catch (e) {
    log.debug(`Could not persist breaker count: ${(e as Error).message}`)
  }
}
