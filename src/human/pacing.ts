/**
 * Session-level rhythm.
 *
 * The gap between applications was a flat random draw from a fixed range. Over
 * an eight-hour run that produces something no person produces: the two
 * hundredth application arrives as briskly as the first, and the histogram of
 * gaps is dead flat from the first minute to the last.
 *
 * People slow down. They also stop -- for coffee, for a phone call, for the
 * thing that just appeared in another tab. This module adds both: a fatigue
 * curve that stretches the gap as the session wears on, and occasional short
 * breaks that are much longer than any normal gap.
 *
 * Pure functions, so the worker can use them and the tests do not have to wait.
 */

import type { Rng } from './rng'
import { between } from './rng'
import { clamp } from '@/shared/util'

export type SessionState = {
  /** Milliseconds since this run started. */
  sessionMs: number
  /** Applications attempted so far in this run. */
  completed: number
}

/** Ceiling on how much fatigue can stretch a gap. */
const MAX_FATIGUE = 2.0

/**
 * How much longer a gap should be, given how long the run has been going.
 *
 * Time on task dominates and volume adds to it, because the tiring part of
 * applying for jobs is both the hours and the repetition.
 */
export function fatigueMultiplier(state: SessionState): number {
  const hours = Math.max(0, state.sessionMs) / 3_600_000
  const fromTime = hours * 0.28
  const fromVolume = Math.max(0, state.completed) * 0.015
  return clamp(1 + fromTime + fromVolume, 1, MAX_FATIGUE)
}

export type Break = { ms: number; reason: string }

/**
 * Should the agent step away for a few minutes?
 *
 * Nothing happens in the first few applications -- a break two minutes into a
 * session is its own kind of odd -- and the chance then climbs, so a long run
 * takes a handful of breaks rather than none or one every time.
 */
export function maybeMicroBreak(state: SessionState, rng: Rng = Math.random): Break | null {
  if (state.completed < 5) return null
  const chance = clamp((state.completed - 4) * 0.035, 0, 0.3)
  if (rng() >= chance) return null
  const ms = Math.round(between(rng, 3 * 60_000, 8 * 60_000))
  return { ms, reason: `Taking a ${Math.round(ms / 60_000)} minute break` }
}

export type Gap = { ms: number; isBreak: boolean; reason: string }

/**
 * The wait before the next application: the configured range, stretched by
 * fatigue and by this install's pacing habit, and now and then replaced
 * outright by a break.
 */
export function nextGap(
  base: { min: number; max: number },
  state: SessionState,
  pacing = 1,
  rng: Rng = Math.random
): Gap {
  const brk = maybeMicroBreak(state, rng)
  if (brk) return { ms: brk.ms, isBreak: true, reason: brk.reason }

  const raw = between(rng, Math.max(0, base.min), Math.max(base.min, base.max))
  const ms = Math.round(raw * fatigueMultiplier(state) * clamp(pacing, 0.5, 2))
  return { ms, isBreak: false, reason: `Pausing ${Math.round(ms / 1000)}s before the next application` }
}
