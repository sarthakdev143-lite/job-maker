/**
 * Humanized typing.
 *
 * Writing a whole value into a field in a single assignment is the most obvious
 * tell an automation leaves behind: one input event, thousands of characters,
 * zero keystrokes. This module turns a string into a sequence of small bursts
 * with irregular pauses, the way a person actually types -- word sized chunks,
 * a wobble on every gap, the occasional longer pause after a sentence ends, and
 * now and then a mistyped character that gets backspaced away.
 *
 * It matters for more than disguise. React-select, Workday's combobox and most
 * ATS typeaheads filter their option list on *each* input event, so a value
 * pasted atomically frequently matches nothing at all. Typing it in bursts is
 * what makes those widgets work.
 *
 * The planner is deliberately budget bound. True per-character typing would
 * take minutes on a 4 kB prompt, which is unacceptable for an agent that sends
 * dozens of them, so long text gets bigger bursts rather than more time. The
 * plan stays irregular -- which is the part that matters -- and still finishes
 * inside `budgetMs`.
 *
 * `planTyping` is pure and takes its randomness as an argument, so it can be
 * tested without waiting on wall-clock time.
 */

import { centered, type Rng } from './rng'
import type { Persona } from './persona'

export type TypingStep = {
  /** Text to append. Empty when the step only deletes. */
  chunk: string
  /** Milliseconds to wait *before* applying it. */
  delayMs: number
  /** Characters to delete before appending, i.e. a correction. */
  backspaces?: number
}

export type TypingOptions = {
  /** Soft ceiling on the total of all delays. */
  budgetMs: number
  /** Fastest / slowest gap between bursts. */
  minStepMs: number
  maxStepMs: number
  /** Smallest burst; long text grows past this automatically. */
  minChunk: number
  /** Probability of a longer "thinking" pause at a sentence boundary. */
  pauseChance: number
  /** Upper bound of that longer pause. */
  pauseMs: number
  /** Probability of a mistyped character per burst. 0 disables typos. */
  typoChance: number
  /** How long a noticed typo sits on screen before being corrected. */
  noticeMs: number
}

export const DEFAULT_TYPING: TypingOptions = {
  budgetMs: 2200,
  minStepMs: 26,
  maxStepMs: 110,
  minChunk: 1,
  pauseChance: 0.09,
  pauseMs: 260,
  typoChance: 0,
  noticeMs: 300,
}

/** Fewest bursts a value is ever broken into, budget notwithstanding. */
const MIN_BURSTS = 4

/** Characters after which a human tends to hesitate. */
const SENTENCE_END = /[.!?,;:\n]/

/** Physically adjacent keys, so a typo looks like a slip rather than noise. */
const NEIGHBOURS: Record<string, string> = {
  a: 'sqwz', b: 'vgnh', c: 'xdvf', d: 'sfer', e: 'wrds', f: 'dgrt', g: 'fhty',
  h: 'gjyu', i: 'uokj', j: 'hkui', k: 'jlio', l: 'kop', m: 'njk', n: 'bmhj',
  o: 'ipkl', p: 'ol', q: 'wa', r: 'etdf', s: 'adwx', t: 'ryfg', u: 'yihj',
  v: 'cbfg', w: 'qeas', x: 'zcsd', y: 'tugh', z: 'asx',
}

/** A plausible wrong key for `ch`, or null when there is no good slip. */
function slip(ch: string, rng: Rng): string | null {
  const lower = ch.toLowerCase()
  const row = NEIGHBOURS[lower]
  if (!row) return null
  const pick = row[Math.floor(rng() * row.length)] ?? row[0]
  return ch === lower ? pick : pick.toUpperCase()
}

export type TypeIntoOptions = Partial<TypingOptions> & {
  /** Clear the field before typing. Default true. */
  clear?: boolean
  /** Blur and fire `change` when finished. Default true. */
  commit?: boolean
}

/** Apply a persona's habits on top of the defaults. */
export function typingOptionsFor<T extends TypeIntoOptions>(
  persona: Persona,
  overrides: T = {} as T
): T & Required<Pick<TypingOptions, 'minStepMs' | 'maxStepMs' | 'budgetMs' | 'pauseChance' | 'typoChance'>> {
  const base = { ...DEFAULT_TYPING, ...overrides }
  return {
    ...overrides,
    minStepMs: Math.round(base.minStepMs * persona.typingSpeed),
    maxStepMs: Math.round(base.maxStepMs * persona.typingSpeed),
    budgetMs: Math.round(base.budgetMs * persona.typingBudget),
    pauseChance: persona.pauseChance,
    typoChance: overrides.typoChance === 0 ? 0 : persona.typoChance,
  }
}

/**
 * Break `text` into typing bursts.
 *
 * Invariants the caller (and the tests) rely on:
 *  - applying every step in order reproduces `text` exactly;
 *  - the first step has no delay, so typing starts immediately;
 *  - the sum of all delays never exceeds `budgetMs`.
 */
export function planTyping(
  text: string,
  opts: Partial<TypingOptions> = {},
  rng: Rng = Math.random
): TypingStep[] {
  const o = { ...DEFAULT_TYPING, ...opts }
  if (!text) return []

  const avgStep = (o.minStepMs + o.maxStepMs) / 2
  // Never collapse to a single burst, however tight the budget: a typeahead
  // that filters on each input event needs several of them, and once the budget
  // is spent the extra steps simply run back to back at no cost.
  const maxSteps = Math.max(MIN_BURSTS, Math.floor(o.budgetMs / avgStep))
  // Short text types nearly character by character; long text rides bigger
  // bursts so the whole thing still lands inside the budget.
  const baseChunk = Math.max(o.minChunk, Math.ceil(text.length / maxSteps))

  const steps: TypingStep[] = []
  let i = 0
  let spent = 0

  /** Record a step, charging its delay against the budget. */
  const push = (chunk: string, rawDelay: number, backspaces?: number): void => {
    let delay = steps.length === 0 ? 0 : Math.round(Math.max(0, rawDelay))
    if (spent + delay > o.budgetMs) delay = Math.max(0, o.budgetMs - spent)
    spent += delay
    steps.push(backspaces ? { chunk, delayMs: delay, backspaces } : { chunk, delayMs: delay })
  }

  while (i < text.length) {
    // Jitter the burst length by +/-40% so no two runs look alike.
    let len = Math.max(1, Math.round(baseChunk * (0.6 + rng() * 0.8)))

    // Prefer to stop on a word boundary: people type words, not fixed widths.
    if (len >= 3 && i + len < text.length) {
      const window = text.slice(i, Math.min(text.length, i + len + 4))
      const space = window.lastIndexOf(' ')
      if (space >= 2) len = space + 1
    }

    const chunk = text.slice(i, i + len)
    const prev = text[i - 1] ?? ''

    // A slip: type one wrong character, notice it, take it back.
    if (steps.length > 0 && spent < o.budgetMs * 0.8 && rng() < o.typoChance) {
      const wrong = slip(chunk[0] ?? '', rng)
      if (wrong) {
        push(wrong, centered(rng, o.minStepMs, o.maxStepMs))
        push('', o.noticeMs * (0.6 + rng() * 0.8), 1)
      }
    }

    let delay = centered(rng, o.minStepMs, o.maxStepMs)
    if (SENTENCE_END.test(prev) && rng() < o.pauseChance) delay += rng() * o.pauseMs
    push(chunk, delay)
    i += chunk.length

    // Budget exhausted with a lot still to type: append the rest in one final
    // burst rather than stalling the run to keep up appearances. A short
    // remainder keeps its bursts -- they cost nothing once the delays are zero.
    if (spent >= o.budgetMs && text.length - i > Math.max(40, baseChunk * 2)) {
      push(text.slice(i), 0)
      break
    }
  }

  return steps
}

/** Replay a plan against a string, which is what the DOM writer does too. */
export function replay(steps: TypingStep[]): string {
  let out = ''
  for (const s of steps) {
    if (s.backspaces) out = out.slice(0, Math.max(0, out.length - s.backspaces))
    out += s.chunk
  }
  return out
}

/* ------------------------------------------------------------ DOM writing */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function isValueField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
}

/**
 * The native setter trick. Assigning `.value` updates the DOM but not React's
 * internal state, and the app then submits an empty field.
 */
function setNativeValue(el: HTMLElement, value: string): void {
  if (isValueField(el)) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
    try {
      el.selectionStart = el.selectionEnd = value.length
    } catch {
      // Number and email inputs throw on selection access; harmless.
    }
    return
  }
  el.textContent = value
}

export function readValue(el: HTMLElement): string {
  if (isValueField(el)) return el.value
  return el.textContent ?? ''
}

function fireInput(el: HTMLElement, data: string, inputType: string): void {
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: data || null, inputType }))
}

/** Key traffic for one character, so key listeners see motion. */
function tapKey(el: HTMLElement, key: string): void {
  const init: KeyboardEventInit = { key, bubbles: true, cancelable: true }
  el.dispatchEvent(new KeyboardEvent('keydown', init))
  if (key.length === 1) el.dispatchEvent(new KeyboardEvent('keypress', init))
  el.dispatchEvent(new KeyboardEvent('keyup', init))
}

/**
 * Type `value` into a field, burst by burst.
 *
 * Returns whether the field ended up holding the value. A composer or widget
 * that rejects synthetic partial input gets one atomic write as a fallback --
 * looking human is never worth losing the application over.
 */
export async function typeInto(
  el: HTMLElement,
  value: string,
  opts: TypeIntoOptions = {},
  rng: Rng = Math.random
): Promise<boolean> {
  const { clear = true, commit = true, ...planOpts } = opts

  el.focus({ preventScroll: true })
  el.dispatchEvent(new Event('focus', { bubbles: true }))

  if (clear && readValue(el)) {
    setNativeValue(el, '')
    fireInput(el, '', 'deleteContentBackward')
  }

  let typed = clear ? '' : readValue(el)
  for (const step of planTyping(value, planOpts, rng)) {
    if (step.delayMs > 0) await sleep(step.delayMs)

    if (step.backspaces) {
      typed = typed.slice(0, Math.max(0, typed.length - step.backspaces))
      setNativeValue(el, typed)
      tapKey(el, 'Backspace')
      fireInput(el, '', 'deleteContentBackward')
    }
    if (!step.chunk) continue

    typed += step.chunk
    setNativeValue(el, typed)
    fireInput(el, step.chunk, 'insertText')
    const last = step.chunk[step.chunk.length - 1]
    if (last) tapKey(el, last)
  }

  // Fallback: a field that refused the incremental writes still gets the value.
  if (readValue(el) !== value) {
    setNativeValue(el, value)
    fireInput(el, value, 'insertText')
  }

  if (commit) {
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  return readValue(el) === value
}
