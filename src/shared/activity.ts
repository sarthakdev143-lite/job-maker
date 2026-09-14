/**
 * What the agent is doing, right now.
 *
 * The agent spends most of its time waiting -- on a chat reply, on a page load,
 * on a deliberate pause between form fields -- and none of that waiting looked
 * different from being hung. This is the one place that tracks the current step
 * so every surface can show it, and so "still working" and "actually stuck" are
 * distinguishable rather than both presenting as a motionless screen.
 *
 * Two layers, deliberately:
 *   - `label` is the coarse step, set by whoever owns the loop.
 *   - `detail` is the fine-grained truth underneath it, set by whatever is
 *     actually blocking. A model reply that is streaming in updates `detail`
 *     every few hundred milliseconds, which is what proves liveness.
 */

export type ActivityKind =
  | 'idle'
  | 'discovering'
  | 'scoring'
  | 'applying'
  | 'thinking'
  | 'paused'
  | 'stopped'

export type ActivityStep = {
  kind: ActivityKind
  /** The coarse step, e.g. "Scoring 7 of 25: Senior Backend Engineer". */
  label: string
  /** What is blocking right now, e.g. "model is replying (412 characters)". */
  detail: string
  startedAt: number
  /** Roughly how long this step should take. 0 when genuinely unknown. */
  expectedMs: number
  /** Last time anything about this step changed. Staleness is measured here. */
  updatedAt: number
}

export function idleStep(label = ''): ActivityStep {
  const now = Date.now()
  return { kind: 'idle', label, detail: '', startedAt: now, expectedMs: 0, updatedAt: now }
}

type Listener = (step: ActivityStep) => void

class Activity {
  private step: ActivityStep = idleStep()
  private listeners = new Set<Listener>()

  get(): ActivityStep {
    return { ...this.step }
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    const snapshot = this.get()
    for (const fn of this.listeners) {
      try {
        fn(snapshot)
      } catch {
        // A failing listener must never break the work it is reporting on.
      }
    }
  }

  /** Start a new coarse step. Clears any detail from the previous one. */
  begin(kind: ActivityKind, label: string, expectedMs = 0): void {
    const now = Date.now()
    this.step = { kind, label, detail: '', startedAt: now, expectedMs, updatedAt: now }
    this.emit()
  }

  /** Update the coarse label without restarting the clock. */
  relabel(label: string): void {
    if (label === this.step.label) return
    this.step = { ...this.step, label, updatedAt: Date.now() }
    this.emit()
  }

  /**
   * Report what is blocking. Called often and cheaply -- every note is a
   * heartbeat, and the absence of notes is what staleness detection measures.
   */
  note(detail: string): void {
    this.step = { ...this.step, detail, updatedAt: Date.now() }
    this.emit()
  }

  /** Nothing is happening; `label` explains what happened last. */
  end(label = ''): void {
    this.step = idleStep(label)
    this.emit()
  }
}

export const activity = new Activity()

/* --------------------------------------------------------------- analysis */

export type ActivityHealth = 'idle' | 'working' | 'slow' | 'stuck' | 'unreachable'

export type ActivityReading = {
  health: ActivityHealth
  /** How long the current step has been running. */
  elapsedMs: number
  /** How long since anything changed. This is the real staleness signal. */
  staleMs: number
  message: string
}

/** Past this with no change at all, something is wrong regardless of step. */
const STUCK_MS = 180_000
const SLOW_MS = 45_000

/**
 * Turn a step into a judgement.
 *
 * Kept pure and separate from the UI so the thresholds are testable: getting
 * these wrong in either direction is the whole problem -- crying stuck during a
 * slow model reply is as bad as staying calm while genuinely hung.
 */
export function readActivity(
  step: ActivityStep,
  options: { now?: number; running: boolean; workerReachable?: boolean } = { running: false }
): ActivityReading {
  const now = options.now ?? Date.now()
  const elapsedMs = Math.max(0, now - step.startedAt)
  const staleMs = Math.max(0, now - step.updatedAt)

  if (options.workerReachable === false) {
    return {
      health: 'unreachable',
      elapsedMs,
      staleMs,
      message: 'The background worker is not responding. Reload the extension.',
    }
  }

  if (!options.running || step.kind === 'idle' || step.kind === 'stopped') {
    return { health: 'idle', elapsedMs, staleMs, message: step.label || 'Idle' }
  }

  if (step.kind === 'paused') {
    return { health: 'idle', elapsedMs, staleMs, message: step.label || 'Paused' }
  }

  // A step that told us how long it should take gets judged against that;
  // anything else falls back to the generic thresholds.
  const slowAfter = step.expectedMs > 0 ? Math.max(SLOW_MS, step.expectedMs * 2) : SLOW_MS
  const stuckAfter = step.expectedMs > 0 ? Math.max(STUCK_MS, step.expectedMs * 6) : STUCK_MS

  if (staleMs > stuckAfter) {
    return {
      health: 'stuck',
      elapsedMs,
      staleMs,
      message: `Nothing has changed for ${formatDuration(staleMs)}. It is probably stuck.`,
    }
  }

  if (staleMs > slowAfter) {
    return {
      health: 'slow',
      elapsedMs,
      staleMs,
      message: `Still on this step after ${formatDuration(elapsedMs)}. Waiting on ${step.detail || 'the page'}.`,
    }
  }

  return { health: 'working', elapsedMs, staleMs, message: step.detail || step.label }
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
