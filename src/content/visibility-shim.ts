/**
 * Telling the page it is being looked at.
 *
 * Applications are filled in a worker window that is created minimized and
 * unfocused, on purpose -- the agent must not steal the screen from whoever is
 * using the machine. The cost is that every form is typed into while the page
 * believes nobody is there: `document.visibilityState` is `hidden`,
 * `document.hasFocus()` is false, and Chrome throttles `requestAnimationFrame`
 * in a minimized window to roughly one frame a second.
 *
 * That combination is worse than a disguise problem. Fields that mount on an
 * IntersectionObserver never render, widgets that finish wiring themselves up
 * inside a rAF callback stall, and carousels and steppers that pause when the
 * tab is hidden simply never advance -- so the form the agent harvests is a
 * fraction of the real one. It is also, separately, the single most obvious
 * automation signal a page could ask for: keystrokes and mouse events arriving
 * at a document that reports nobody is watching it.
 *
 * So this runs in the page's own world, before any of its scripts, and answers
 * those three questions the way a foreground tab would. It patches nothing
 * else: no event is faked, no timer is touched, and anything the page does with
 * the answers is its own business.
 *
 * It is registered only for the job sites the extension already holds host
 * permission for, which is where application forms live.
 */

const TRUE_GETTER = { configurable: true, enumerable: true } as const

function define(target: object, prop: string, get: () => unknown): void {
  try {
    Object.defineProperty(target, prop, { ...TRUE_GETTER, get })
  } catch {
    // A property some other extension already locked down is not worth
    // throwing over; the rest of the shim still applies.
  }
}

define(Document.prototype, 'visibilityState', () => 'visible')
define(Document.prototype, 'hidden', () => false)
define(Document.prototype, 'webkitVisibilityState', () => 'visible')
define(Document.prototype, 'webkitHidden', () => false)

try {
  Document.prototype.hasFocus = function hasFocus(this: Document): boolean {
    return true
  }
} catch {
  // Same reasoning as above.
}
