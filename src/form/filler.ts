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

function focusSafely(el: HTMLElement): void {
  try {
    el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
  } catch {
    el.scrollIntoView()
  }
  el.focus({ preventScroll: true })
}

/* --------------------------------------------------------------- writers */

function fillText(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  focusSafely(el)
  fire(el, 'focus')
  setNativeValue(el, '')
  fire(el, 'input')
  setNativeValue(el, value)
  fire(el, 'input')
  fire(el, 'change')
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }))
  el.blur()
  fire(el, 'blur')
}

function fillContentEditable(el: HTMLElement, value: string): void {
  focusSafely(el)
  el.textContent = value
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
  fire(el, 'change')
  el.blur()
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

function fillRadio(groupName: string, value: string, doc: Document): boolean {
  const members = Array.from(
    doc.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(groupName)}"]`)
  )
  if (members.length === 0) return false
  const target = normalizeText(value)

  const labelFor = (input: HTMLInputElement): string => {
    const byFor = input.id ? doc.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null
    const wrapping = input.closest('label')
    return normalizeText(
      (byFor as HTMLElement | null)?.innerText ??
        (wrapping as HTMLElement | null)?.innerText ??
        input.getAttribute('aria-label') ??
        input.value
    )
  }

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

  focusSafely(match)
  match.click()
  if (!match.checked) {
    match.checked = true
    fire(match, 'input')
    fire(match, 'change')
  }
  return match.checked
}

function fillCheckbox(el: HTMLInputElement, value: string): boolean {
  const want = TRUTHY.has(normalizeText(value))
  if (el.checked !== want) {
    focusSafely(el)
    el.click()
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
async function fillCombobox(el: HTMLElement, value: string, doc: Document): Promise<boolean> {
  focusSafely(el)
  el.click()
  await sleep(220)

  // Type into whichever input the widget focused (often not `el` itself).
  const typing =
    (doc.activeElement instanceof HTMLInputElement ? doc.activeElement : null) ??
    el.querySelector('input') ??
    (el instanceof HTMLInputElement ? el : null)

  if (typing) {
    setNativeValue(typing, value)
    fire(typing, 'input')
    await sleep(450) // let async option loading settle
  }

  const option = await findOption(el, value, doc)
  if (option) {
    option.scrollIntoView({ block: 'nearest' })
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    option.click()
    await sleep(180)
    return true
  }

  // Keyboard fallback: first suggestion is usually the best match after typing.
  const target = typing ?? el
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown', keyCode: 40 }))
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }))
  await sleep(180)
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
      const options = Array.from(
        scope.querySelectorAll<HTMLElement>('[role="option"], li[data-value], .select__option, [class*="option"]')
      ).filter((o) => (o.innerText ?? '').trim() && o.offsetParent !== null)

      if (options.length > 0) {
        const exact = options.find((o) => normalizeText(o.innerText) === target)
        if (exact) return exact
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

function readBack(el: HTMLElement, doc: Document): string {
  if (el instanceof HTMLSelectElement) return (el.selectedOptions[0]?.text ?? '').trim()
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') return String(el.checked)
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

  for (const field of plan) {
    if (field.kind === 'file') continue // uploads go through their own message
    const el = resolveSelector(field.selector, doc)
    if (!el) {
      failed.push({ ...field, verified: false, error: 'element not found' })
      continue
    }

    try {
      let wrote = false
      switch (field.kind) {
        case 'select':
          wrote = el instanceof HTMLSelectElement ? fillSelect(el, field.value) : await fillCombobox(el, field.value, doc)
          break
        case 'radio': {
          const group = (field as FilledField & { group?: string }).group || el.getAttribute('name') || ''
          wrote = group ? fillRadio(group, field.value, doc) : false
          if (!wrote && el instanceof HTMLInputElement) wrote = fillCheckbox(el, 'true')
          break
        }
        case 'checkbox':
          wrote = el instanceof HTMLInputElement ? fillCheckbox(el, field.value) : false
          break
        case 'combobox':
          wrote = await fillCombobox(el, field.value, doc)
          break
        case 'textarea':
          if (el instanceof HTMLTextAreaElement) {
            fillText(el, field.value)
            wrote = true
          } else {
            fillContentEditable(el, field.value)
            wrote = true
          }
          break
        default:
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            fillText(el, field.value)
            wrote = true
          } else if (el.isContentEditable) {
            fillContentEditable(el, field.value)
            wrote = true
          }
      }

      await sleep(120)
      const verified = wrote && verifyValue(el, field.value, field.kind, doc)
      const record: FilledField = { ...field, verified, error: verified ? '' : wrote ? 'value did not stick' : 'no writer matched' }
      if (verified) filled.push(record)
      else failed.push(record)
    } catch (e) {
      failed.push({ ...field, verified: false, error: (e as Error).message })
    }

    await sleep(jitter(pacing.min, pacing.max))
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
