/**
 * A stable "person" per site.
 *
 * Rolling fresh random timings on every visit sounds like the safest thing to
 * do, and it is not: a real applicant has one typing speed, one clicking habit
 * and one reading pace, and they keep them from Tuesday to Thursday. A visitor
 * whose timing distribution is redrawn every session is more distinctive than
 * one who is merely fast.
 *
 * So the persona is derived deterministically from the hostname plus a salt
 * generated once per install. The same site always sees the same typist; two
 * different sites see two different ones; and two installs of this extension
 * share nothing.
 */

import { between, rngFor, type Rng } from './rng'
import { hostOf } from '@/shared/util'

export type Persona = {
  /** Multiplier on typing gaps. Below 1 is a fast typist, above 1 a slow one. */
  typingSpeed: number
  /** Multiplier on the typing time budget for a field. */
  typingBudget: number
  /** Chance of a mistyped character (and its correction) per burst. */
  typoChance: number
  /** Chance of a longer pause at a sentence boundary. */
  pauseChance: number
  /** How long a mouse button stays down, in milliseconds. */
  pressMs: { min: number; max: number }
  /** Reading speed, words per minute, for pauses before answering. */
  wpm: number
  /** Multiplier on the gap between applications. */
  pacing: number
}

const SALT_KEY = 'human:salt'

/** Pure derivation, so tests and the planner can share one persona. */
export function derivePersona(key: string): Persona {
  const rng: Rng = rngFor(key)
  return {
    typingSpeed: between(rng, 0.72, 1.45),
    typingBudget: between(rng, 0.8, 1.35),
    // Typing accuracy varies far more between people than speed does.
    typoChance: between(rng, 0.004, 0.03),
    pauseChance: between(rng, 0.05, 0.18),
    pressMs: { min: Math.round(between(rng, 38, 62)), max: Math.round(between(rng, 90, 150)) },
    wpm: Math.round(between(rng, 180, 320)),
    pacing: between(rng, 0.85, 1.3),
  }
}

let saltPromise: Promise<string> | null = null

/**
 * The per-install salt. Generated once and kept, so personas are stable for
 * this install and unrelated to anyone else's.
 */
async function installSalt(): Promise<string> {
  if (!saltPromise) {
    saltPromise = (async () => {
      try {
        const bag = await chrome.storage.local.get(SALT_KEY)
        const existing = bag?.[SALT_KEY]
        if (typeof existing === 'string' && existing) return existing
        const fresh = Math.random().toString(36).slice(2) + Date.now().toString(36)
        await chrome.storage.local.set({ [SALT_KEY]: fresh })
        return fresh
      } catch {
        // No storage (a bare test page, a locked profile): fall back to a
        // constant. Timing still varies per host, just not per install.
        return 'default-salt'
      }
    })()
  }
  return saltPromise
}

const cache = new Map<string, Persona>()

/** Persona for a URL or hostname. Cached, so repeat calls are free. */
export async function personaFor(urlOrHost: string): Promise<Persona> {
  const host = hostOf(urlOrHost) || urlOrHost || 'unknown'
  const hit = cache.get(host)
  if (hit) return hit
  const persona = derivePersona(`${host}|${await installSalt()}`)
  cache.set(host, persona)
  return persona
}

/** Persona for the page this content script is running in. */
export function personaForPage(): Promise<Persona> {
  return personaFor(typeof location === 'undefined' ? 'unknown' : location.hostname)
}

/** Test seam: forget cached personas and the resolved salt. */
export function resetPersonaCache(): void {
  cache.clear()
  saltPromise = null
}
