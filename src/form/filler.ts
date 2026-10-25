/**
 * Writing values into a page.
 *
 * Two things make this harder than `el.value = x`:
 *
 * 1. React (and Angular, and Vue) track input state internally. Assigning
 *    `.value` updates the DOM but not the framework, so the app submits an
 *    empty field. Every write here goes through the native prototype setter and
 *    then dispatches the events the framework actually listens for.
 * 2. Half the controls on a modern ATS form are not real inputs. Custom
 *    comboboxes have to be opened, typed into, and have an option clicked.
 *
 * Every write is read back afterwards. A field that does not hold its value is
 * reported as failed rather than assumed good, because the alternative is
 * submitting an application with a silently empty required field.
 */

import { queryByAttr, oneByAttr, resolveSelector } from './selector'
import { createLogger } from '@/shared/logger'
import { normalizeText, similarity } from '@/shared/text'
import { personaForPage, type Persona } from '@/human/persona'
import { typeInto, typingOptionsFor } from '@/human/typing'
import { driftDuring, humanClick, humanScrollTo, readingPauseMs } from '@/human/pointer'
import type { FilledField } from '@/storage/schemas'

const log = createLogger('filler')

function attr(el: Element, name: string): string {
  return (el.getAttribute(name) ?? '').trim()
}

const TRUTHY = new Set(['true', 'yes', 'y', '1', 'on', 'checked'])

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * Math.max(0, max - min))
}

function fire(el: Element, type: string, init: EventInit = { bubbles: true }): void {
  el.dispatchEvent(new Event(type, init))
}

/** The native setter trick: this is what makes React see the change. */
function setNativeValue(el: HTMLElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value)
  else (el as HTMLInputElement).value = value
}

/**
 * Come to a field the way a person does: scroll to it in a step or two, then
 * focus. The scrolling is not only manners -- lazily rendered controls mount on
 * scroll, and jumping straight to a field and writing into it immediately is a
 * reliable way to write into a widget that has not finished wiring itself up.
 */
async function approach(el: HTMLElement): Promise<void> {
  await humanScrollTo(el)
  el.focus({ preventScroll: true })
}

/** Non-scrolling focus, for the places that only need the caret moved. */
function focusSafely(el: HTMLElement): void {
  el.focus({ preventScroll: true })
}

/**
 * How long typing one value is allowed to take.
 *
 * A prompt to a chat box can afford two seconds; a forty-field application form
 * cannot afford that per field. Short answers still type nearly per character,
 * long ones ride bigger bursts.
 */
function typingBudgetFor(value: string): number {
  return Math.round(Math.min(1100, Math.max(220, value.length * 22)))
}

/* --------------------------------------------------------------- writers */


/**
 * Leave a field the way a person does: Tab, then blur.
 *
 * Plenty of ATS forms validate a field on the Tab keydown rather than on blur,
 * and show their complaint only once you have moved on -- an agent that jumps
 * straight to the next selector never triggers that, so a value the site would
 * have rejected sits there looking accepted until the submit button refuses.
 * It is also simply what leaving a field looks like from the page's side.
 */
function tabAway(el: HTMLElement): void {
  const init: KeyboardEventInit = { key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true, cancelable: true }
  try {
    el.dispatchEvent(new KeyboardEvent('keydown', init))
    el.dispatchEvent(new KeyboardEvent('keyup', init))
  } catch {
    // A DOM that cannot build the event is no reason to skip the blur.
  }
  el.blur()
  fire(el, 'blur')
}

/**
 * Choose an option in a group built from ARIA roles rather than from `<input>`s.
 *
 * Every writer above is written in terms of `HTMLInputElement` and a shared
 * `name`, so a `div[role="radiogroup"]` holding `div[role="radio"]` members hit
 * none of them: no group name to query by, and `fillCheckbox` refused a
 * non-input outright. The result was a `no writer matched` failure on a
 * question the page renders exactly as a person would answer it.
 *
 * These widgets also do not toggle on `.click()` alone -- react-aria and
 * Workday's own widget both keep the selection in `aria-checked` -- so the
 * attribute is verified and set as a fallback, the same way the native writers
 * treat `.checked`.
 */
function ariaMembers(el: HTMLElement): HTMLElement[] {
  if (attr(el, 'role') === 'radio' || attr(el, 'role') === 'option') return [el]
  if (attr(el, 'role') === 'checkbox' || attr(el, 'role') === 'switch') return [el]
  const radios = Array.from(el.querySelectorAll<HTMLElement>('[role="radio"], [role="option"]'))
  return radios.length ? radios : Array.from(el.querySelectorAll<HTMLElement>('[role="checkbox"]'))
}

function ariaLabel(m: HTMLElement): string {
  return normalizeText(m.innerText ?? m.textContent ?? attr(m, 'aria-label') ?? '')
}

function ariaValue(m: HTMLElement): string {
  return attr(m, 'data-value') || attr(m, 'value') || ariaLabel(m)
}

function isAriaChecked(m: HTMLElement): boolean {
  return attr(m, 'aria-checked') === 'true' || (m as HTMLInputElement).checked === true
}

function setAriaChecked(m: HTMLElement, on: boolean): void {
  if (isAriaChecked(m) === on) return
  m.setAttribute('aria-checked', String(on))
  fire(m, 'input')
  fire(m, 'change')
  fire(m, 'click')
}

/** Match an answer to a member the way the native writers match an option. */
function matchAriaMember(members: HTMLElement[], value: string): HTMLElement | null {
  const target = normalizeText(value)
  const exact =
    members.find((m) => normalizeText(ariaValue(m)) === target) ??
    members.find((m) => ariaLabel(m) === target)
  if (exact) return exact

  let best: { m: HTMLElement; s: number } | null = null
  for (const m of members) {
    const s = Math.max(similarity(value, ariaValue(m)), similarity(value, ariaLabel(m)))
    if (s >= 0.7 && (!best || s > best.s)) best = { m, s }
  }
  return best?.m ?? null
}

async function fillAriaGroup(
  el: HTMLElement,
  value: string,
  persona: Persona,
  multiple: boolean
): Promise<boolean> {
  const members = ariaMembers(el)
  if (members.length === 0) return false

  // A multi-select group may be answered with several options at once.
  const wanted = multiple
    ? value.split(/[,;|\n]|\band\b/).map((v) => v.trim()).filter(Boolean)
    : [value]
  if (wanted.length === 0) return false

  let acted = 0
  for (const want of wanted) {
    const member = matchAriaMember(members, want)
    if (!member) continue
    if (multiple && isAriaChecked(member)) continue
    await humanClick(member, { pressMs: persona.pressMs })
    if (!isAriaChecked(member)) setAriaChecked(member, true)
    if (isAriaChecked(member)) acted++
  }

  return members.some(isAriaChecked) && acted > 0
}

async function fillAriaToggle(el: HTMLElement, value: string, persona: Persona): Promise<boolean> {
  const want = TRUTHY.has(normalizeText(value))
  if (isAriaChecked(el) !== want) {
    await humanClick(el, { pressMs: persona.pressMs })
    if (isAriaChecked(el) !== want) setAriaChecked(el, want)
  }
  return isAriaChecked(el) === want
}

/** Is this a Yes/No button pair rather than a set of options? */
function isYesNoPair(el: HTMLElement): boolean {
  return (
    el.querySelectorAll('button[data-option], [role="radio"][data-option], button[aria-pressed]').length >= 2
  )
}

/**
 * Ashby's Yes/No widget: press the button, not the hidden checkbox behind it.
 *
 * The checkbox is `tabindex="-1"` and carries the value; the two
 * `button[data-option]` elements carry the state, through `aria-pressed`. The
 * control is driven by pressing a button, and the backing checkbox is updated
 * by the widget in response -- writing to it directly would leave the visible
 * control showing the other answer.
 */
async function fillYesNo(el: HTMLElement, value: string, persona: Persona): Promise<boolean> {
  const buttons = Array.from(
    el.querySelectorAll<HTMLElement>('button[data-option], [role="radio"][data-option], button[aria-pressed]')
  )
  if (buttons.length < 2) return false

  const target = normalizeText(value)
  const match =
    buttons.find((b) => normalizeText(ariaValue(b)) === target) ??
    buttons.find((b) => ariaLabel(b) === target)
  if (!match) return false

  if (attr(match, 'aria-pressed') !== 'true') {
    await humanClick(match, { pressMs: persona.pressMs })
    if (attr(match, 'aria-pressed') !== 'true') {
      // The widget did not react; set the state and tell it, rather than
      // reporting a press that visibly did nothing as a success.
      for (const b of buttons) b.setAttribute('aria-pressed', String(b === match))
      fire(match, 'click')
      fire(match, 'change')
    }
  }
  return buttons.some((b) => attr(b, 'aria-pressed') === 'true')
}

async function fillText(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  persona: Persona
): Promise<void> {
  await approach(el)
  await typeInto(el, value, typingOptionsFor(persona, { budgetMs: typingBudgetFor(value) }))
  tabAway(el)
}

async function fillContentEditable(el: HTMLElement, value: string, persona: Persona): Promise<void> {
  await approach(el)
  await typeInto(el, value, typingOptionsFor(persona, { budgetMs: typingBudgetFor(value) }))
  tabAway(el)
}

/** Match a select option by exact value, exact label, then fuzzy label. */
function fillSelect(el: HTMLSelectElement, value: string): boolean {
  const target = normalizeText(value)
  const options = Array.from(el.options)

  let match =
    options.find((o) => o.value === value) ??
    options.find((o) => normalizeText(o.text) === target) ??
    options.find((o) => normalizeText(o.value) === target)

  if (!match) {
    let best: { o: HTMLOptionElement; s: number } | null = null
    for (const o of options) {
      if (!o.text.trim()) continue
      const s = similarity(value, o.text)
      if (s >= 0.7 && (!best || s > best.s)) best = { o, s }
    }
    match = best?.o
  }
  if (!match) return false

  focusSafely(el)
  setNativeValue(el, match.value)
  el.selectedIndex = match.index
  fire(el, 'input')
  fire(el, 'change')
  el.blur()
  return true
}

async function fillRadio(
  groupName: string,
  value: string,
  doc: Document,
  persona: Persona
): Promise<boolean> {
  const members = queryByAttr(doc, 'input[type="radio"]', 'name', groupName) as HTMLInputElement[]
  if (members.length === 0) return false
  const target = normalizeText(value)

  const labelFor = (input: HTMLInputElement): string => optionLabel(input, doc)

  let match =
    members.find((m) => normalizeText(m.value) === target) ?? members.find((m) => labelFor(m) === target)

  if (!match) {
    let best: { m: HTMLInputElement; s: number } | null = null
    for (const m of members) {
      const s = Math.max(similarity(value, labelFor(m)), similarity(value, m.value))
      if (s >= 0.7 && (!best || s > best.s)) best = { m, s }
    }
    match = best?.m
  }
  if (!match) return false

  await humanClick(match, { pressMs: persona.pressMs })
  if (!match.checked) {
    match.checked = true
    fire(match, 'input')
    fire(match, 'change')
  }
  return match.checked
}

/** The visible words next to a checkbox or radio, however the page attaches them. */
function optionLabel(input: HTMLInputElement, doc: Document): string {
  const byFor = input.id ? oneByAttr(doc, 'label', 'for', input.id) : null
  const wrapping = input.closest('label')
  return normalizeText(
    (byFor as HTMLElement | null)?.innerText ??
      (wrapping as HTMLElement | null)?.innerText ??
      input.getAttribute('aria-label') ??
      input.value
  )
}

/**
 * A question answered by ticking one or more boxes.
 *
 * Greenhouse renders every "multi select" question this way -- "Which
 * programming languages can you independently read?" is a group of checkboxes
 * sharing one name, not a dropdown. Sent through `fillCheckbox` the answer
 * "Python" is not a truthy string, so nothing was ticked, and the boolean
 * writer then reported `checked === want` as success: a required question left
 * blank and sworn to be filled. Two real applications were refused by their own
 * form for exactly that.
 */
async function fillCheckboxGroup(
  groupName: string,
  value: string,
  doc: Document,
  persona: Persona
): Promise<boolean> {
  const members = queryByAttr(doc, 'input[type="checkbox"]', 'name', groupName) as HTMLInputElement[]
  if (members.length === 0) return false

  // An answer may name several options at once.
  const wanted = value
    .split(/[,;|\n]|\band\b/)
    .map((v) => v.trim())
    .filter(Boolean)
  if (wanted.length === 0) return false

  let ticked = 0
  for (const want of wanted) {
    const target = normalizeText(want)
    let best: { m: HTMLInputElement; s: number } | null = null
    for (const m of members) {
      const text = optionLabel(m, doc)
      const score = text === target ? 1 : Math.max(similarity(want, text), similarity(want, m.value))
      if (score >= 0.7 && (!best || score > best.s)) best = { m, s: score }
    }
    if (!best || best.m.checked) continue
    await humanClick(best.m, { pressMs: persona.pressMs })
    if (!best.m.checked) {
      best.m.checked = true
      fire(best.m, 'input')
      fire(best.m, 'change')
    }
    if (best.m.checked) ticked++
  }

  return members.some((m) => m.checked) && ticked > 0
}

async function fillCheckbox(el: HTMLInputElement, value: string, persona: Persona): Promise<boolean> {
  const want = TRUTHY.has(normalizeText(value))
  if (el.checked !== want) {
    await humanClick(el, { pressMs: persona.pressMs })
    if (el.checked !== want) {
      el.checked = want
      fire(el, 'input')
      fire(el, 'change')
    }
  }
  return el.checked === want
}

/**
 * Custom comboboxes (react-select, select2, Workday's widget).
 *
 * Open it, type to filter, wait for the option list, click the best match.
 * Falls back to keyboard navigation when the list has no clickable role.
 */
async function fillCombobox(
  el: HTMLElement,
  value: string,
  doc: Document,
  persona: Persona
): Promise<boolean> {
  await humanClick(el, { pressMs: persona.pressMs })
  await sleep(jitter(180, 380))

  // Type into whichever input the widget focused (often not `el` itself).
  const typing =
    (doc.activeElement instanceof HTMLInputElement ? doc.activeElement : null) ??
    el.querySelector('input') ??
    (el instanceof HTMLInputElement ? el : null)

  if (typing) {
    // Typed, not pasted. These widgets filter their list on every input event,
    // so a value written in one assignment frequently matches nothing at all --
    // this is the difference between "no option found" and a filled field.
    await typeInto(typing, value, typingOptionsFor(persona, { budgetMs: typingBudgetFor(value), commit: false }))
    await sleep(jitter(380, 620)) // let async option loading settle
  }

  const option = await findOption(el, value, doc)
  if (option) {
    await humanClick(option, { pressMs: persona.pressMs })
    await sleep(jitter(140, 300))
    // The widget having a value now is the honest test. Comparing its display
    // against what we asked for is not: a country picker asked for "India"
    // shows "+91", which is the right answer and matches nothing.
    return readBack(el, doc).trim().length > 0
  }

  // Keyboard fallback: first suggestion is usually the best match after typing.
  const target = typing ?? el
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown', keyCode: 40 }))
  await sleep(jitter(90, 200))
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }))
  await sleep(jitter(140, 300))
  return readBack(el, doc).trim().length > 0
}

async function findOption(anchor: HTMLElement, value: string, doc: Document): Promise<HTMLElement | null> {
  const deadline = Date.now() + 2500
  const target = normalizeText(value)

  while (Date.now() < deadline) {
    const listId = anchor.getAttribute('aria-owns') || anchor.getAttribute('aria-controls')
    const scopes: ParentNode[] = []
    if (listId) {
      const byId = doc.getElementById(listId)
      if (byId) scopes.push(byId)
    }
    scopes.push(doc)

    for (const scope of scopes) {
      const candidates = Array.from(
        scope.querySelectorAll<HTMLElement>(
          '[role="option"], li[data-value], .select__option, [class*="option"], ' +
            // Lever's location picker, and every Places-style dropdown like it,
            // renders plain divs with no ARIA at all.
            '[class*="dropdown-location"], [class*="suggestion"], [class*="autocomplete"] li'
        )
      ).filter((o) => (o.innerText ?? '').trim() && o.offsetParent !== null)

      // Keep the leaves. A results container matches these selectors too, and
      // picking it would click the whole list instead of one entry.
      const options = candidates.filter((o) => !candidates.some((other) => other !== o && o.contains(other)))

      if (options.length > 0) {
        const exact = options.find((o) => normalizeText(o.innerText) === target)
        if (exact) return exact
        // "India" against an option reading "India +91": a prefix match is the
        // right answer and scores far too low to survive the fuzzy threshold.
        //
        // The closest prefix, though, not the first one in the DOM. Typing
        // "India" into a location picker offers "Indianapolis, Indiana, United
        // States" among the matches, and taking whichever came first put a
        // candidate in Indiana on a real application to a role in India.
        let prefix: { o: HTMLElement; extra: number } | null = null
        for (const o of options) {
          const text = normalizeText(o.innerText)
          if (!text.startsWith(target) && !target.startsWith(text)) continue
          const extra = Math.abs(text.length - target.length)
          if (!prefix || extra < prefix.extra) prefix = { o, extra }
        }
        if (prefix) return prefix.o
        let best: { o: HTMLElement; s: number } | null = null
        for (const o of options) {
          const s = similarity(value, o.innerText)
          if (s >= 0.72 && (!best || s > best.s)) best = { o, s }
        }
        if (best) return best.o
      }
    }
    await sleep(200)
  }
  return null
}

/* ------------------------------------------------------------ verification */

/**
 * What a custom dropdown is showing.
 *
 * react-select and its imitators clear the search input the moment an option is
 * chosen and render the choice in a separate node, so reading `input.value`
 * after a successful selection returns an empty string. Every Greenhouse
 * dropdown was reported as "value did not stick" for exactly this reason --
 * including the ones that had been filled correctly.
 */
function comboboxDisplay(el: HTMLElement): string {
  let scope: HTMLElement | null = el
  for (let i = 0; i < 4 && scope; i++) {
    // Never climb out of this widget. Application forms stack their fields
    // closely, and one more step up finds the *neighbouring* dropdown's value
    // -- which reported an empty required question as filled, and sent a form
    // to a real employer with a mandatory answer missing.
    const otherWidgets = scope.querySelectorAll('input[role="combobox"], select').length
    if (otherWidgets > 1) break

    const shown = scope.querySelector<HTMLElement>(
      '[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"]'
    )
    if (shown && (shown.innerText ?? '').trim()) return shown.innerText.trim()
    scope = scope.parentElement
  }
  // Some widgets keep the real answer in a hidden input beside the visible one.
  const form = el.closest('[class*="select"], [class*="field"], form') ?? el.parentElement
  const hidden = form?.querySelector<HTMLInputElement>('input[type="hidden"][value]:not([value=""])')
  return (hidden?.value ?? '').trim()
}

function readBack(el: HTMLElement, doc: Document): string {
  if (el instanceof HTMLSelectElement) return (el.selectedOptions[0]?.text ?? '').trim()
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') return String(el.checked)
    // A combobox input is emptied on selection; ask the widget instead.
    if (!el.value && (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete'))) {
      return comboboxDisplay(el)
    }
    return el.value
  }
  if (el instanceof HTMLTextAreaElement) return el.value

  // A choice group built from ARIA roles. Its innerText is every option
  // concatenated ("YesNo"), so reading it back would verify an unanswered
  // group as filled. What matters is which member is selected.
  const role = attr(el, 'role')
  if (role === 'radio' || role === 'option') {
    return isAriaChecked(el) ? ariaLabel(el) : ''
  }
  if (role === 'checkbox' || role === 'switch') {
    return String(isAriaChecked(el))
  }
  if (role === 'radiogroup' || role === 'listbox') {
    const checked = ariaMembers(el).find(isAriaChecked)
    return checked ? ariaLabel(checked) : ''
  }

  // A Yes/No button pair. The backing checkbox holds the value for the widget's
  // own bookkeeping and reads empty, so verifying against it reported a press
  // that had visibly worked as "value did not stick" -- the same reason the
  // combobox display is read from the widget rather than the input.
  const yesNo = Array.from(
    el.querySelectorAll<HTMLElement>('button[data-option], [role="radio"][data-option], button[aria-pressed]')
  )
  if (yesNo.length >= 2) {
    const pressed = yesNo.find((b) => attr(b, 'aria-pressed') === 'true')
    return pressed ? ariaLabel(pressed) : ''
  }

  const inner = el.querySelector('input')
  if (inner) return inner.value
  return (el.innerText ?? '').trim()
}

/** Did the write take? Compared loosely, because widgets reformat values. */
function verifyValue(el: HTMLElement, expected: string, kind: string, doc: Document): boolean {
  const actual = readBack(el, doc)
  if (kind === 'checkbox') return normalizeText(actual) === String(TRUTHY.has(normalizeText(expected)))
  if (!actual.trim()) return false
  const a = normalizeText(actual)
  const b = normalizeText(expected)
  if (a === b) return true
  if (a.includes(b) || b.includes(a)) return true
  // Phone and currency fields reformat; compare digits when both are numeric.
  const digitsA = a.replace(/\D/g, '')
  const digitsB = b.replace(/\D/g, '')
  if (digitsA && digitsA === digitsB) return true
  return similarity(a, b) >= 0.8
}

/* ------------------------------------------------------------------ entry */

export type FillOutcome = { filled: FilledField[]; failed: FilledField[] }

/**
 * Apply a fill plan. Radio groups are addressed by `group` rather than by
 * selector because every member shares a name and only the group is meaningful.
 */
export async function applyFillPlan(
  plan: FilledField[],
  pacing: { min: number; max: number },
  doc: Document = document
): Promise<FillOutcome> {
  const filled: FilledField[] = []
  const failed: FilledField[] = []
  const persona = await personaForPage()

  for (const field of plan) {
    if (field.kind === 'file') continue // uploads go through their own message
    const el = resolveSelector(field.selector, doc)
    if (!el) {
      failed.push({ ...field, verified: false, error: 'element not found' })
      continue
    }

    try {
      // Read the question before answering it. Filling a two-line eligibility
      // question as fast as a first-name box is not a timing any person
      // produces, and the pause costs a fraction of a second.
      // Reading the question. The pointer drifts while it happens, because a
      // frozen cursor through every pause is its own signature.
      await driftDuring(readingPauseMs(field.label, persona))

      let wrote = false
      // A ticked checkbox group is judged by the boxes, not by re-reading a
      // single input's boolean.
      let groupTicked = false
      switch (field.kind) {
        case 'select':
          wrote =
            el instanceof HTMLSelectElement
              ? fillSelect(el, field.value)
              : await fillCombobox(el, field.value, doc, persona)
          break
        case 'radio': {
          // Ashby's Yes/No pair: the buttons are the control.
          if (!(el instanceof HTMLInputElement) && isYesNoPair(el)) {
            wrote = await fillYesNo(el, field.value, persona)
            break
          }
          // A group rendered with ARIA roles instead of `<input type=radio>`
          // carries no `name` and is not an input; the native writers cannot
          // address it, so it is driven directly.
          if (!(el instanceof HTMLInputElement)) {
            wrote = await fillAriaGroup(el, field.value, persona, false)
            break
          }
          const group = (field as FilledField & { group?: string }).group || el.getAttribute('name') || ''
          wrote = group ? await fillRadio(group, field.value, doc, persona) : false
          if (!wrote && el instanceof HTMLInputElement) wrote = await fillCheckbox(el, 'true', persona)
          break
        }
        case 'checkbox': {
          if (!(el instanceof HTMLInputElement)) {
            // A group of boxes is a multi-select question; a lone switch is a
            // yes/no. More than one member means the former.
            const members = ariaMembers(el)
            wrote =
              members.length > 1
                ? await fillAriaGroup(el, field.value, persona, true)
                : await fillAriaToggle(el, field.value, persona)
            groupTicked = wrote
            break
          }
          // A named group of boxes is a multi-select question, not a yes/no.
          const group = (field as FilledField & { group?: string }).group || el.getAttribute('name') || ''
          const members = group
            ? queryByAttr(doc, 'input[type="checkbox"]', 'name', group).length
            : 0
          if (members > 1) {
            wrote = await fillCheckboxGroup(group, field.value, doc, persona)
            groupTicked = wrote
          } else {
            wrote = el instanceof HTMLInputElement ? await fillCheckbox(el, field.value, persona) : false
          }
          break
        }
        case 'combobox':
          wrote = await fillCombobox(el, field.value, doc, persona)
          break
        case 'textarea':
          if (el instanceof HTMLTextAreaElement) {
            await fillText(el, field.value, persona)
            wrote = true
          } else {
            await fillContentEditable(el, field.value, persona)
            wrote = true
          }
          break
        default:
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            await fillText(el, field.value, persona)
            wrote = true
          } else if (el.isContentEditable) {
            await fillContentEditable(el, field.value, persona)
            wrote = true
          }
      }

      await sleep(jitter(90, 220))
      // A dropdown we drove deliberately is judged by whether it now holds a
      // value, not by whether that value reads like the one we asked for --
      // widgets reformat their selection beyond recognition ("India" -> "+91").
      const isDropdown = field.kind === 'combobox' || (field.kind === 'select' && !(el instanceof HTMLSelectElement))
      if (groupTicked) {
        const record: FilledField = { ...field, verified: true, error: '' }
        filled.push(record)
        await sleep(Math.round(jitter(pacing.min, pacing.max) * persona.typingSpeed))
        continue
      }
      let verified =
        wrote &&
        (verifyValue(el, field.value, field.kind, doc) || (isDropdown && readBack(el, doc).trim().length > 0))

      // A typed value that vanished belongs to a picker wearing a text input's
      // clothes: Lever's location field has no ARIA whatsoever and simply
      // discards anything not chosen from its dropdown. Try it as one before
      // reporting a required field as unfillable.
      //
      // Never for a choice widget: those hold no text, so an unselected group
      // always reads back empty and this would re-drive it as a dropdown,
      // typing into a radiogroup and clicking whatever member it landed on.
      const isChoice = field.kind === 'radio' || field.kind === 'checkbox'
      if (wrote && !verified && !isDropdown && !isChoice && !readBack(el, doc).trim()) {
        const picked = await fillCombobox(el, field.value, doc, persona)
        verified = picked && Boolean(readBack(el, doc).trim())
        if (verified) {
          log.debug(`"${field.label}" only accepted a value chosen from its dropdown`)
        }
      }
      const record: FilledField = { ...field, verified, error: verified ? '' : wrote ? 'value did not stick' : 'no writer matched' }
      if (verified) filled.push(record)
      else failed.push(record)
    } catch (e) {
      failed.push({ ...field, verified: false, error: (e as Error).message })
    }

    // Between fields, at this install's own tempo.
    await sleep(Math.round(jitter(pacing.min, pacing.max) * persona.typingSpeed))
  }

  return { filled, failed }
}

/**
 * Attach a file to an input.
 *
 * `input.files` is read-only, so the only way to set it is to build a
 * DataTransfer and assign its FileList. Drag-and-drop zones that hide the real
 * input get a synthetic drop event carrying the same DataTransfer.
 */
export async function attachFile(
  selector: string,
  fileName: string,
  mimeType: string,
  dataUrl: string,
  doc: Document = document
): Promise<{ success: boolean; detail: string }> {
  const el = resolveSelector(selector, doc)
  if (!el) return { success: false, detail: 'file input not found' }

  const input =
    el instanceof HTMLInputElement && el.type === 'file'
      ? el
      : el.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) return { success: false, detail: 'no file input under selector' }

  const blob = await (await fetch(dataUrl)).blob()
  const file = new File([blob], fileName, { type: mimeType || blob.type || 'application/pdf' })

  const dt = new DataTransfer()
  dt.items.add(file)
  input.files = dt.files
  fire(input, 'input')
  fire(input, 'change')

  await sleep(250)
  if (input.files?.length === 1) {
    // Some dropzones only react to a drop event, even with files set.
    const dropzone = input.closest('[class*="drop"], [class*="upload"], [data-testid*="upload"]')
    if (dropzone) {
      dropzone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    }
    return { success: true, detail: `attached ${fileName}` }
  }
  return { success: false, detail: 'file list did not update' }
}
