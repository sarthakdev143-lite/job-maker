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

import { resolveSelector } from './selector'
import { normalizeText, similarity } from '@/shared/text'
import { personaForPage, type Persona } from '@/human/persona'
import { typeInto, typingOptionsFor } from '@/human/typing'
import { humanClick, humanScrollTo, readingPauseMs } from '@/human/pointer'
import type { FilledField } from '@/storage/schemas'

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

async function fillText(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  persona: Persona
): Promise<void> {
  await approach(el)
  await typeInto(el, value, typingOptionsFor(persona, { budgetMs: typingBudgetFor(value) }))
  el.blur()
  fire(el, 'blur')
}

async function fillContentEditable(el: HTMLElement, value: string, persona: Persona): Promise<void> {
  await approach(el)
  await typeInto(el, value, typingOptionsFor(persona, { budgetMs: typingBudgetFor(value) }))
  el.blur()
  fire(el, 'blur')
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
  const members = Array.from(
    doc.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(groupName)}"]`)
  )
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
  const byFor = input.id ? doc.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null
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
  const members = Array.from(
    doc.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name="${CSS.escape(groupName)}"]`)
  )
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

/**
 * Note, for the log, that a field needed the dropdown treatment. Kept as a
 * separate hook so the content script stays free of storage imports.
 */
async function applicationsNote(label: string): Promise<void> {
  try {
    console.debug(`[autoapply] "${label}" only accepted a value chosen from its dropdown`)
  } catch {
    // Logging is never worth failing a fill over.
  }
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
      await sleep(readingPauseMs(field.label, persona))

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
          const group = (field as FilledField & { group?: string }).group || el.getAttribute('name') || ''
          wrote = group ? await fillRadio(group, field.value, doc, persona) : false
          if (!wrote && el instanceof HTMLInputElement) wrote = await fillCheckbox(el, 'true', persona)
          break
        }
        case 'checkbox': {
          // A named group of boxes is a multi-select question, not a yes/no.
          const group = (field as FilledField & { group?: string }).group || el.getAttribute('name') || ''
          const members = group
            ? doc.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(group)}"]`).length
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
      if (wrote && !verified && !isDropdown && !readBack(el, doc).trim()) {
        const picked = await fillCombobox(el, field.value, doc, persona)
        verified = picked && Boolean(readBack(el, doc).trim())
        if (verified) {
          await applicationsNote(field.label)
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
