/**
 * A model-readable outline of a page.
 *
 * The extension's site adapters are lists of CSS selectors, and a selector is a
 * bet that a site's markup has not changed since the day it was written. That
 * bet loses constantly: Indeed rotates generated class names, a company drops
 * its own careers page in front of an Ashby board, Naukri renames a button.
 * When the bet loses the adapter reports "no application form found" and a
 * perfectly good job is skipped.
 *
 * The fallback is to ask the model, which needs a description of the page that
 * is faithful enough to decide from and small enough to send. Raw `outerHTML`
 * is neither -- half a megabyte of framework noise, most of it invisible. So
 * this walks the rendered page and emits only what a person looking at the
 * screen would use: what is visible, what it says, what it is for, and a
 * selector to address it by.
 *
 * Every element is numbered. The model answers with a number rather than a
 * selector, which is the difference between a choice that can be checked and a
 * string that has to be trusted.
 */

export type OutlineElement = {
  /** The number the model refers to. Stable within a single outline. */
  ref: number
  /** button, link, input, select, textarea. */
  role: string
  /** The words on screen: label, text, aria-label, placeholder. */
  text: string
  /** A CSS selector the runner can use to act on it. */
  selector: string
  /** Present for form controls. */
  type?: string
  disabled?: boolean
  required?: boolean
}

export type PageOutline = {
  url: string
  title: string
  /** Visible headings, in order, as page structure. */
  headings: string[]
  elements: OutlineElement[]
  /** Leading visible text, for context the elements alone do not carry. */
  text: string
  /**
   * Whatever the page is complaining about, verbatim.
   *
   * Leading text is the job advert on every ATS, so a 3 kB sample of it never
   * reaches the form -- and when an application was refused, the refusal is the
   * only part worth keeping. Three separate debugging sessions went blind for
   * exactly this reason.
   */
  problems?: string[]
  /** True when the walk hit its budget and stopped early. */
  truncated: boolean
}

const MAX_ELEMENTS = 120
const MAX_TEXT = 3000
const TEXT_PER_ELEMENT = 140

/**
 * Is this element actually on screen?
 *
 * A page carries a great many controls that exist but cannot be used: closed
 * menus, hidden wizard steps, the mobile layout of a desktop page. Offering
 * those to the model is how it picks a submit button nobody can click.
 */
export function isVisible(el: Element): boolean {
  const html = el as HTMLElement
  if (!html.getClientRects || html.getClientRects().length === 0) return false
  const style = globalThis.getComputedStyle?.(html)
  if (!style) return true
  if (style.visibility === 'hidden' || style.display === 'none') return false
  if (style.opacity !== '' && Number(style.opacity) === 0) return false
  if (html.getAttribute('aria-hidden') === 'true') return false
  return true
}

/** The words a person would read off this control. */
export function elementText(el: Element): string {
  const html = el as HTMLElement
  const candidates = [
    html.innerText,
    html.getAttribute('aria-label'),
    html.getAttribute('title'),
    html.getAttribute('placeholder'),
    html.getAttribute('value'),
    html.getAttribute('name'),
  ]
  for (const candidate of candidates) {
    const text = (candidate ?? '').replace(/\s+/g, ' ').trim()
    if (text) return text.slice(0, TEXT_PER_ELEMENT)
  }
  return ''
}

function tag(el: Element): string {
  return el.tagName.toLowerCase()
}

function cssEscape(value: string): string {
  const escape = globalThis.CSS?.escape
  return escape ? escape(value) : value.replace(/(["\\])/g, '\\$1')
}

function isUnique(doc: Document, selector: string): boolean {
  try {
    return doc.querySelectorAll(selector).length === 1
  } catch {
    return false
  }
}

/** Last resort: a structural path, which is ugly but always resolves. */
function positionalPath(el: Element): string {
  const parts: string[] = []
  let node: Element | null = el
  while (node && node.nodeType === 1 && parts.length < 6) {
    const current: Element = node
    const parent: Element | null = current.parentElement
    if (!parent) {
      parts.unshift(tag(current))
      break
    }
    const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName)
    const index = siblings.indexOf(current) + 1
    parts.unshift(siblings.length > 1 ? `${tag(current)}:nth-of-type(${index})` : tag(current))
    if (current.id && !/\d{5,}/.test(current.id)) {
      parts[0] = `#${cssEscape(current.id)}`
      break
    }
    node = parent
  }
  return parts.join(' > ')
}

/**
 * A selector that will still resolve when the runner uses it.
 *
 * Preference order is stability, not brevity: an id, then a test hook, then a
 * name, and only as a last resort a positional path. Generated class names are
 * never used -- they are exactly the thing that rotates.
 */
export function stableSelector(el: Element, doc: Document = document): string {
  const html = el as HTMLElement

  const id = html.id
  if (id && !/\d{5,}/.test(id) && isUnique(doc, `#${cssEscape(id)}`)) return `#${cssEscape(id)}`

  for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-automation-id', 'data-qa']) {
    const value = html.getAttribute(attr)
    if (!value) continue
    const sel = `[${attr}="${cssEscape(value)}"]`
    if (isUnique(doc, sel)) return sel
  }

  const name = html.getAttribute('name')
  if (name) {
    const sel = `${tag(html)}[name="${cssEscape(name)}"]`
    if (isUnique(doc, sel)) return sel
  }

  const label = html.getAttribute('aria-label')
  if (label) {
    const sel = `${tag(html)}[aria-label="${cssEscape(label)}"]`
    if (isUnique(doc, sel)) return sel
  }

  return positionalPath(html)
}

const INTERACTIVE = [
  'button',
  'a[href]',
  'a[role="button"]',
  '[role="button"]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="link"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
].join(', ')

function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')
  if (explicit === 'button' || explicit === 'link') return explicit
  const name = tag(el)
  if (name === 'a') return 'link'
  if (name === 'input') {
    const type = (el as HTMLInputElement).type
    return type === 'submit' || type === 'button' ? 'button' : 'input'
  }
  if (name === 'button' || name === 'select' || name === 'textarea') return name
  return explicit || 'element'
}

/**
 * Walk the rendered page and describe it.
 *
 * Interactive controls first and in document order, because the questions the
 * model is asked -- "which of these applies?", "which of these submits?" -- are
 * always about something clickable. Headings and leading text follow as the
 * context that tells a confirmation page from a form.
 */
export function outlinePage(doc: Document = document, href = ''): PageOutline {
  const elements: OutlineElement[] = []
  let truncated = false
  let ref = 0

  const headings = Array.from(doc.querySelectorAll('h1, h2, h3'))
    .filter(isVisible)
    .slice(0, 12)
    .map((h) => ((h as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  for (const el of Array.from(doc.querySelectorAll(INTERACTIVE))) {
    if (elements.length >= MAX_ELEMENTS) {
      truncated = true
      break
    }
    if (!isVisible(el)) continue

    const text = elementText(el)
    const role = roleOf(el)
    // A control with no words on it cannot be chosen by description, and an
    // outline full of them crowds out the ones that can. Form inputs are kept
    // regardless: an unlabelled input is still a fact about the page.
    if (!text && role !== 'input' && role !== 'select' && role !== 'textarea') continue

    ref++
    const entry: OutlineElement = { ref, role, text, selector: stableSelector(el, doc) }
    const input = el as HTMLInputElement
    // A <button> reports type "submit" by default, which says nothing about the
    // page and costs a token on every single control. Only a type that adds
    // information is carried -- the kind of an input, mostly.
    if (input.type && !(role === 'button' && (input.type === 'submit' || input.type === 'button'))) {
      entry.type = input.type
    }
    if (input.disabled) entry.disabled = true
    if (input.required || el.getAttribute('aria-required') === 'true') entry.required = true
    elements.push(entry)
  }

  const bodyText = ((doc.body as HTMLElement | null)?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim()

  return {
    url: href,
    title: doc.title ?? '',
    headings,
    elements,
    text: bodyText.slice(0, MAX_TEXT),
    problems: problemsOn(doc),
    truncated,
  }
}

/**
 * Every visible complaint the page is making.
 *
 * Error containers, ARIA alerts, anything marked invalid, and the browser's own
 * validation message for each control that fails it. Short, deduplicated, and
 * the first thing worth reading when an application was refused.
 */
function problemsOn(doc: Document): string[] {
  const found = new Set<string>()

  const add = (text: string | null | undefined): void => {
    const clean = (text ?? '').replace(/\s+/g, ' ').trim()
    if (clean && clean.length < 300) found.add(clean)
  }

  const selectors = [
    '[role="alert"]',
    '[aria-invalid="true"]',
    '[class*="error"]',
    '[class*="invalid"]',
    '[class*="warning"]',
    '.field_with_errors',
  ]
  for (const sel of selectors) {
    try {
      for (const el of Array.from(doc.querySelectorAll<HTMLElement>(sel)).slice(0, 12)) {
        if (!isVisible(el)) continue
        add(el.innerText || el.getAttribute('aria-label'))
      }
    } catch {
      // A selector this engine dislikes is not worth losing the rest over.
    }
  }

  // The browser's own verdict, which is often the only thing on offer when a
  // form refuses silently.
  for (const form of Array.from(doc.querySelectorAll('form')).slice(0, 3)) {
    for (const el of Array.from((form as HTMLFormElement).elements).slice(0, 200)) {
      const control = el as HTMLInputElement
      if (typeof control.willValidate !== 'boolean' || !control.willValidate) continue
      if (typeof control.checkValidity !== 'function' || control.checkValidity()) continue
      const name = control.name || control.id || control.getAttribute('aria-label') || control.type
      add(`${name}: ${control.validationMessage}`)
    }
  }

  // A refusal stated in prose, which matches no error selector at all.
  const body = ((doc.body as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ')
  for (const re of [
    /there was an error processing your application[^.]*\.?/i,
    /(your )?application could not be (submitted|processed)[^.]*\.?/i,
    /something went wrong[^.]{0,60}(application|submit)[^.]*\.?/i,
    /please (try again|complete the reCAPTCHA|verify)[^.]{0,60}\.?/i,
  ]) {
    const hit = body.match(re)
    if (hit) add(hit[0])
  }

  return Array.from(found).slice(0, 15)
}

/**
 * Render an outline as the text the model sees.
 *
 * Deliberately flat and numbered. A nested or JSON-shaped rendering costs more
 * tokens and gives a smaller model more ways to answer in a format the schema
 * will reject.
 */
export function renderOutline(outline: PageOutline): string {
  const lines: string[] = [`URL: ${outline.url}`, `Title: ${outline.title}`]
  if (outline.headings.length > 0) lines.push(`Headings: ${outline.headings.join(' | ')}`)
  lines.push('', 'Controls on screen:')

  for (const el of outline.elements) {
    const bits = [`[${el.ref}] ${el.role}`]
    if (el.type && el.type !== el.role) bits.push(`(${el.type})`)
    if (el.disabled) bits.push('(disabled)')
    if (el.required) bits.push('(required)')
    bits.push(`"${el.text || '(no label)'}"`)
    lines.push(`  ${bits.join(' ')}`)
  }
  if (outline.truncated) lines.push('  ... (more controls not listed)')

  lines.push('', 'Page text:', outline.text.slice(0, 2000))
  return lines.join('\n')
}
