/**
 * Audit log.
 *
 * An autonomous agent that touches real employers needs a record of every
 * decision it made and why. Logs go to IndexedDB (queryable from the side
 * panel), to the console (for devtools), and out as a broadcast event so an
 * open panel updates live.
 */

import { logsRepo } from '@/storage/db'
import { uid } from './util'

export type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let minLevel: Level = 'info'
let broadcaster: ((level: Level, scope: string, message: string, at: number) => void) | null = null

export function setLogLevel(level: Level): void {
  minLevel = level
}

/** The worker wires this to its port broadcast so the panel streams events. */
export function setLogBroadcaster(fn: typeof broadcaster): void {
  broadcaster = fn
}

async function write(level: Level, scope: string, message: string, data?: unknown, jobId = ''): Promise<void> {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
  const at = Date.now()

  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  consoleFn(`[${scope}] ${message}`, data ?? '')

  try {
    broadcaster?.(level, scope, message, at)
  } catch {
    // A dead panel port must never break the run.
  }

  // Debug lines are noisy and short-lived; keep them out of persistent storage.
  if (level === 'debug') return
  try {
    await logsRepo.put({
      id: uid('log'),
      at,
      level,
      scope,
      message,
      data: serializable(data),
      jobId,
    })
  } catch {
    // Storage failures are not worth failing a run over.
  }
}

/** Strip anything IndexedDB cannot structured-clone (Errors, DOM nodes, fns). */
function serializable(data: unknown): unknown {
  if (data === undefined || data === null) return undefined
  if (data instanceof Error) return { name: data.name, message: data.message, stack: data.stack }
  if (typeof data === 'function') return '[function]'
  try {
    return JSON.parse(JSON.stringify(data))
  } catch {
    return String(data)
  }
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, data?: unknown, jobId?: string) => void write('debug', scope, message, data, jobId),
    info: (message: string, data?: unknown, jobId?: string) => void write('info', scope, message, data, jobId),
    warn: (message: string, data?: unknown, jobId?: string) => void write('warn', scope, message, data, jobId),
    error: (message: string, data?: unknown, jobId?: string) => void write('error', scope, message, data, jobId),
    /** Awaitable variant, for the last line before a crash or a stop. */
    flush: (level: Level, message: string, data?: unknown, jobId?: string) => write(level, scope, message, data, jobId),
  }
}

export type Logger = ReturnType<typeof createLogger>
