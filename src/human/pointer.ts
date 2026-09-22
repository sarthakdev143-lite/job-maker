/**
 * Humanized pointing, scrolling and reading pauses.
 *
 * `el.click()` fires exactly one event: `click`, with no coordinates, no
 * preceding hover, and no button press. A real click is a small storm --
 * pointermove, pointerover, mouseover, pointerdown, mousedown, focus,
 * pointerup, mouseup, click -- at a point that is never the same twice and
 * never the exact centre of the element.
 *
 * That difference is not only about looking human. Plenty of ATS widgets open
 * their menu on `mousedown` and never see a bare `click` at all, so the richer
 * sequence is also what makes them respond.
 *
 * The final activation still goes through `el.click()` rather than a dispatched
 * click event, so checkboxes, radios and links keep their native default
 * behaviour exactly as before.
 */

import { between, centered, type Rng } from './rng'
import type { Persona } from './persona'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

type Point = { x: number; y: number }

/**
 * A point inside the element, biased towards the middle but rarely on it.
 * Clicks landing on the exact pixel centre, every time, is a fingerprint.
 */
function aimAt(el: Element, rng: Rng): Point {
  const rect = el.getBoundingClientRect()
  const w = rect.width || 1
  const h = rect.height || 1
  return {
    x: Math.round(rect.left + w / 2 + (centered(rng, -0.3, 0.3) * w)),
    y: Math.round(rect.top + h / 2 + (centered(rng, -0.3, 0.3) * h)),
  }
}

/** PointerEvent is missing in some test DOMs; fall back to MouseEvent. */
function pointer(type: string, p: Point, extra: MouseEventInit = {}): Event {
  const init: MouseEventInit & { pointerId?: number; pointerType?: string; isPrimary?: boolean } = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: p.x,
    clientY: p.y,
    ...extra,
  }
  if (typeof PointerEvent === 'function') {
    return new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
  }
  return new MouseEvent(type.replace('pointer', 'mouse'), init)
}

function emit(el: Element, type: string, p: Point, extra: MouseEventInit = {}): void {
  try {
    el.dispatchEvent(pointer(type, p, extra))
  } catch {
    // A DOM that cannot construct the event is not a reason to skip the click.
  }
}

/**
 * Scroll an element into view the way a person does: in a couple of steps with
 * a beat between them, rather than teleporting to it.
 *
 * The pause is also load-bearing -- lazily rendered fields mount on scroll, and
 * an instant jump followed by an immediate click regularly hits the element
 * before the widget has finished wiring itself up.
 */
export async function humanScrollTo(el: Element, rng: Rng = Math.random): Promise<void> {
  const inView = (): boolean => {
    const r = el.getBoundingClientRect()
    const h = typeof window === 'undefined' ? 800 : window.innerHeight || 800
    return r.top >= h * 0.1 && r.bottom <= h * 0.9
  }
  if (inView()) return

  const steps = 1 + Math.floor(rng() * 2)
  for (let i = 0; i < steps; i++) {
    try {
      el.scrollIntoView({ block: i === steps - 1 ? 'center' : 'nearest', behavior: 'smooth' })
    } catch {
      el.scrollIntoView()
    }
    await sleep(Math.round(between(rng, 90, 260)))
    if (inView()) break
  }
}

/**
 * Would a real mousedown move focus here?
 *
 * Only for a genuine control or something explicitly in the tab order. This
 * matters more than it looks: a react-select option is a `div` with
 * `tabindex="-1"`, and focusing it blurs the search input, which closes the
 * menu *before* the click lands. Every dropdown on a live Greenhouse form
 * failed that way -- the browser itself does not move focus there either,
 * because the widget cancels the mousedown default.
 */
function takesFocus(el: HTMLElement): boolean {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLButtonElement ||
    el instanceof HTMLAnchorElement
  ) {
    return true
  }
  const ti = el.getAttribute('tabindex')
  return ti !== null && Number(ti) >= 0
}

export type ClickOptions = {
  /** Press duration bounds; a persona's habit by default. */
  pressMs?: { min: number; max: number }
  /** Scroll to the element first. Default true. */
  scroll?: boolean
}

/** Move to an element, press, release, activate. */
export async function humanClick(
  el: HTMLElement,
  opts: ClickOptions = {},
  rng: Rng = Math.random
): Promise<void> {
  const press = opts.pressMs ?? { min: 45, max: 120 }
  if (opts.scroll !== false) await humanScrollTo(el, rng)

  const target = aimAt(el, rng)
  // Approach: a couple of moves ending on the target, not a teleport.
  const approach: Point = { x: target.x + Math.round(between(rng, -24, 24)), y: target.y + Math.round(between(rng, -18, 18)) }
  emit(el, 'pointerover', approach)
  emit(el, 'mouseover', approach)
  emit(el, 'pointermove', approach)
  emit(el, 'mousemove', approach)
  await sleep(Math.round(between(rng, 20, 70)))
  emit(el, 'pointermove', target)
  emit(el, 'mousemove', target)
  await sleep(Math.round(between(rng, 15, 55)))

  emit(el, 'pointerdown', target, { button: 0, buttons: 1 })
  emit(el, 'mousedown', target, { button: 0, buttons: 1 })
  if (takesFocus(el)) {
    try {
      el.focus({ preventScroll: true })
    } catch {
      // Not every clickable is focusable.
    }
  }
  await sleep(Math.round(centered(rng, press.min, press.max)))
  emit(el, 'pointerup', target, { button: 0, buttons: 0 })
  emit(el, 'mouseup', target, { button: 0, buttons: 0 })

  // Native activation, so default behaviour (checkbox toggle, link follow,
  // form submit) is identical to what it was before this indirection existed.
  el.click()
}

/**
 * How long a person would spend reading `text` before answering.
 *
 * Answering a two-line eligibility question in the same 120 ms as a first-name
 * field is not a timing that any human produces. Capped at a few seconds --
 * this is realism, not a simulation of actually reading.
 */
export function readingPauseMs(text: string, persona: Pick<Persona, 'wpm'>, rng: Rng = Math.random): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  if (words === 0) return 0
  const ms = (words / Math.max(60, persona.wpm)) * 60_000
  return Math.round(Math.min(4000, Math.max(120, ms * between(rng, 0.7, 1.4))))
}

/**
 * Small, aimless movement while the agent is thinking.
 *
 * Between fields the agent pauses to "read" the question, and during that pause
 * nothing at all happens: no movement, no scrolling, a cursor frozen at the
 * pixel where it last clicked. A person reading a form is never that still, and
 * the stillness is trivially measurable from the page. This drifts the pointer
 * a little and occasionally nudges the scroll, for exactly as long as the pause
 * was going to last anyway -- it costs no extra time.
 */
export async function driftDuring(totalMs: number, rng: Rng = Math.random): Promise<void> {
  if (totalMs <= 0) return
  const started = Date.now()
  let x = typeof window === 'undefined' ? 400 : Math.round(between(rng, 100, Math.max(200, window.innerWidth - 100)))
  let y = typeof window === 'undefined' ? 300 : Math.round(between(rng, 100, Math.max(200, window.innerHeight - 100)))

  while (Date.now() - started < totalMs) {
    const step = Math.min(Math.round(between(rng, 120, 380)), totalMs - (Date.now() - started))
    if (step <= 0) break
    await sleep(step)

    x += Math.round(centered(rng, -40, 40))
    y += Math.round(centered(rng, -30, 30))
    const target = document?.elementFromPoint?.(x, y) ?? document?.body
    if (target) emit(target, 'pointermove', { x, y })
    if (target) emit(target, 'mousemove', { x, y })

    // Now and then the page moves a little under the cursor, the way it does
    // when someone is skimming.
    if (rng() < 0.12 && typeof window !== 'undefined') {
      try {
        window.scrollBy({ top: Math.round(centered(rng, -60, 90)), behavior: 'smooth' })
      } catch {
        // Not every document scrolls.
      }
    }
  }
}
