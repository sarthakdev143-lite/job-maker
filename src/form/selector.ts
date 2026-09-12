/**
 * Stable element selectors.
 *
 * A fill plan is computed in the service worker and replayed in the page,
 * possibly minutes later and after a re-render. The selector is the only thing
 * connecting the two, so it has to survive React re-mounting the subtree. That
 * rules out class chains (obfuscated and volatile) and favours id, name and
 * data attributes, with a structural path only as a last resort.
 */

const STABLE_ATTRS = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-qa',
  'data-automation-id', // Workday puts a durable key here on nearly everything
  'data-ui',
  'aria-label',
]

/** CSS.escape is present in every Chrome we target; this is belt and braces. */
function cssEscape(value: string): string {
  const fn = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape
  if (fn) return fn(value)
  return value.replace(/([^\w-])/g, '\\$1')
}

/** React and Emotion generate ids like ":r3:" and "css-1x2y3z" that change per render. */
function looksGenerated(value: string): boolean {
  if (!value) return true
  if (/^[:.]|[:.]$/.test(value)) return true // React 18 useId
  if (/^(css|sc|emotion|mui|chakra)-[a-z0-9]{4,}$/i.test(value)) return true
  if (/^[a-f0-9]{8,}$/i.test(value)) return true
  if (/^radix-/.test(value)) return true
  if (/\d{6,}/.test(value)) return true
  return false
}

function isUnique(root: Document | Element, selector: string): boolean {
  try {
    return root.querySelectorAll(selector).length === 1
  } catch {
    return false
  }
}

function tagOf(el: Element): string {
  return el.tagName.toLowerCase()
}

/**
 * Build the most durable unique selector we can for `el`.
 * Returns '' when no unique selector can be produced, which the caller treats
 * as "skip this field" rather than guessing.
 */
export function buildSelector(el: Element, doc: Document = document): string {
  const tag = tagOf(el)

  const id = el.getAttribute('id')
  if (id && !looksGenerated(id)) {
    const sel = `#${cssEscape(id)}`
    if (isUnique(doc, sel)) return sel
  }

  for (const attr of STABLE_ATTRS) {
    const value = el.getAttribute(attr)
    if (!value || looksGenerated(value)) continue
    const sel = `${tag}[${attr}="${cssEscape(value)}"]`
    if (isUnique(doc, sel)) return sel
  }

  const name = el.getAttribute('name')
  if (name) {
    const sel = `${tag}[name="${cssEscape(name)}"]`
    if (isUnique(doc, sel)) return sel
    // Radio groups legitimately share a name; disambiguate by value.
    const value = el.getAttribute('value')
    if (value) {
      const withValue = `${tag}[name="${cssEscape(name)}"][value="${cssEscape(value)}"]`
      if (isUnique(doc, withValue)) return withValue
    }
  }

  const type = el.getAttribute('type')
  if (type === 'file') {
    const sel = `${tag}[type="file"]`
    if (isUnique(doc, sel)) return sel
  }

  return structuralPath(el, doc)
}

/**
 * Structural fallback: walk up to a stable anchor (an element with a usable id)
 * or the body, recording nth-of-type at each hop.
 */
function structuralPath(el: Element, doc: Document): string {
  const parts: string[] = []
  let current: Element | null = el
  let depth = 0

  while (current && current !== doc.documentElement && depth < 12) {
    const tag = tagOf(current)
    const parent: Element | null = current.parentElement
    if (!parent) break

    const siblings = Array.from(parent.children).filter((c) => tagOf(c) === tag)
    const part = siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag
    parts.unshift(part)

    const parentId = parent.getAttribute('id')
    if (parentId && !looksGenerated(parentId)) {
      const candidate = `#${cssEscape(parentId)} > ${parts.join(' > ')}`
      if (isUnique(doc, candidate)) return candidate
    }

    const candidate = parts.join(' > ')
    if (isUnique(doc, candidate)) return candidate

    current = parent
    depth++
  }

  const full = parts.join(' > ')
  return isUnique(doc, full) ? full : ''
}

/** Resolve a selector produced by buildSelector back to its element. */
export function resolveSelector(selector: string, doc: Document = document): HTMLElement | null {
  if (!selector) return null
  try {
    return doc.querySelector<HTMLElement>(selector)
  } catch {
    return null
  }
}
