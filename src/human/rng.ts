/**
 * Seedable randomness.
 *
 * Everything in `src/human` takes its randomness as an argument rather than
 * calling `Math.random` directly. Two reasons: the plans become testable
 * without waiting on wall-clock time, and a *stable* seed lets one site see a
 * consistent "person" across runs instead of a freshly rolled typist every
 * visit (see `persona.ts`), which is itself a pattern worth not having.
 */

import { hashString } from '@/shared/util'

export type Rng = () => number

/** mulberry32: tiny, fast, good enough spread for timing jitter. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A seeded generator keyed by an arbitrary string (a hostname, usually). */
export function rngFor(key: string): Rng {
  const digits = hashString(key).replace(/[^a-z0-9]/g, '')
  let seed = 0
  for (let i = 0; i < digits.length; i++) seed = (Math.imul(seed, 31) + digits.charCodeAt(i)) >>> 0
  return seededRng(seed || 1)
}

/** Uniform pick in `[min, max)`. */
export function between(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min)
}

/**
 * Bell-ish sample in `[min, max)`.
 *
 * Human timings cluster around a typical value with occasional outliers, which
 * a flat uniform draw does not reproduce -- a histogram of uniform gaps is
 * itself a giveaway. Averaging three draws is the cheapest decent approximation
 * of a normal distribution.
 */
export function centered(rng: Rng, min: number, max: number): number {
  const t = (rng() + rng() + rng()) / 3
  return min + t * (max - min)
}
