/**
 * Field harvesting.
 *
 * Walks a page and produces a FieldDescriptor for every question a human would
 * have to answer. The hard part is not finding inputs, it is finding what each
 * input is *asking*: ATS forms label fields through at least six different
 * mechanisms, and getting the label wrong means the answer bank never hits and
 * the model answers the wrong question.
 */

import { buildSelector } from './selector'
import { normalizeQuestion, normalizeText } from '@/shared/text'
import type { FieldDescriptor, FieldKind } from '@/storage/schemas'

/** Inputs that are never questions. */
const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image'])

/** Field names that are search boxes, filters or site chrome, not questions. */
const NOISE_PATTERNS = [
  /\bsearch\b/i,
  /\bfilter\b/i,
  /\bnewsletter\b/i,
  /\bsubscribe\b/i,
  /\bcookie\b/i,
  /\bcaptcha\b/i,
  /^q$/i,
]

/**
 * Visibility, decided without consulting layout.
 *
 * Measuring rectangles looks more accurate and is in fact worse here: file
 * inputs are routinely 1x1 or fully transparent behind a styled button, custom
 * widgets render their real input off-screen, and a headless DOM reports every
 * rectangle as zero. Walking the ancestor chain for an actual hiding rule
 * answers the question we care about -- "would a person ever be asked this?"
 * -- in every one of those environments.
 */
export function isVisible(el: Element): boolean {
  const he = el as HTMLElement
  if (!he.isConnected) return false

  const check = (he as unknown as { checkVisibility?: (o?: object) => boolean }).checkVisibility
  if (typeof check === 'function') {
    try {
      return check.call(he, { checkVisibilityCSS: true, contentVisibilityAuto: true })
    } catch {
      // Older engines reject the options bag; fall through.
    }
  }
  return !hiddenByAncestor(he)
}

function hiddenByAncestor(el: HTMLElement): boolean {
  let node: HTMLElement | null = el
  let depth = 0
  while (node && depth < 30) {
    if (node.hasAttribute?.('hidden')) return true
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return true
    node = node.parentElement
    depth++
  }
  return false
}

function attr(el: Element, name: string): string {
  return (el.getAttribute(name) ?? '').trim()
}

function cleanLabel(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[*∗✱★]\s*$/, '')
    .replace(/^\s*[*∗✱★]\s*/, '')
    .replace(/\(required\)/i, '')
    .replace(/\(optional\)/i, '')
    .trim()
}

/**
 * Label resolution cascade, most authoritative first. Each ATS favours a
 * different one of these, so all six are needed to cover the target set.
 */
export function resolveLabel(el: HTMLElement, doc: Document = document): string {
  const id = el.getAttribute('id')

  // 1. <label for="...">
  if (id) {
    try {
      const forLabel = doc.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`)
      if (forLabel?.innerText) return cleanLabel(forLabel.innerText)
    } catch {
      // Malformed id; fall through.
    }
  }

  // 2. aria-labelledby (Workday leans on this heavily)
  const labelledBy = attr(el, 'aria-labelledby')
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((ref) => doc.getElementById(ref)?.innerText ?? '')
      .filter(Boolean)
      .join(' ')
    if (text.trim()) return cleanLabel(text)
  }

  // 3. aria-label
  const ariaLabel = attr(el, 'aria-label')
  if (ariaLabel) return cleanLabel(ariaLabel)

  // 4. wrapping <label>
  const wrapping = el.closest('label')
  if (wrapping) {
    const clone = wrapping.cloneNode(true) as HTMLElement
    clone.querySelectorAll('input, select, textarea').forEach((n) => n.remove())
    const text = clone.innerText ?? clone.textContent ?? ''
    if (text.trim()) return cleanLabel(text)
  }

  // 5. A label-ish sibling inside the same field wrapper. ATS markup almost
  //    always groups a question and its control in one container.
  const wrapper = el.closest(
    '[class*="field"], [class*="form-group"], [class*="question"], [class*="input"], fieldset, .application-field, [data-automation-id]'
  )
  if (wrapper) {
    const labelNode = wrapper.querySelector('label, legend, [class*="label"], [id*="label"]')
    if (labelNode && !labelNode.contains(el)) {
      const text = (labelNode as HTMLElement).innerText ?? ''
      if (text.trim()) return cleanLabel(text)
    }
  }

  // 6. Nearest preceding text node with content.
  const preceding = previousTextual(el)
  if (preceding) return cleanLabel(preceding)

  // 7. Fall back to placeholder, then name.
  const placeholder = attr(el, 'placeholder')
  if (placeholder) return cleanLabel(placeholder)
  const name = attr(el, 'name')
  if (name) return cleanLabel(name.replace(/[_\-\[\]]+/g, ' '))

  return ''
}

function previousTextual(el: HTMLElement): string {
  let node: Element | null = el
  let hops = 0
  while (node && hops < 6) {
    let sib: Element | null = node.previousElementSibling
    let sibHops = 0
    while (sib && sibHops < 4) {
      const text = (sib as HTMLElement).innerText?.trim() ?? ''
      if (text && text.length < 220 && !sib.querySelector('input, select, textarea')) return text
      sib = sib.previousElementSibling
      sibHops++
    }
    node = node.parentElement
    hops++
  }
  return ''
}

export function isRequired(el: HTMLElement, label: string): boolean {
  if ((el as HTMLInputElement).required) return true
  if (attr(el, 'aria-required') === 'true') return true
  if (/\*/.test(label)) return true
  const wrapper = el.closest('[class*="field"], [class*="form-group"], [class*="question"]')
  if (wrapper) {
    if (/required/i.test(wrapper.className)) return true
    const marker = wrapper.querySelector('[class*="required"], .asterisk, abbr[title="required"]')
    if (marker) return true
  }
  return false
}

function kindOf(el: HTMLElement): FieldKind {
  if (el instanceof HTMLTextAreaElement) return 'textarea'
  if (el instanceof HTMLSelectElement) return 'select'
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case 'email':
        return 'email'
      case 'tel':
        return 'tel'
      case 'url':
        return 'url'
      case 'number':
        return 'number'
      case 'date':
      case 'month':
        return 'date'
      case 'radio':
        return 'radio'
      case 'checkbox':
        return 'checkbox'
      case 'file':
        return 'file'
      default:
        return 'text'
    }
  }
  const role = attr(el, 'role')
  if (role === 'combobox' || role === 'listbox') return 'combobox'
  if (role === 'radiogroup') return 'radio'
  if (role === 'checkbox' || role === 'switch') return 'checkbox'
  if (el.isContentEditable) return 'textarea'
  return 'unknown'
}

function optionsOfSelect(el: HTMLSelectElement): Array<{ value: string; label: string }> {
  return Array.from(el.options)
    .filter((o) => o.value !== '' || o.text.trim() !== '')
    .map((o) => ({ value: o.value, label: (o.text ?? '').trim() }))
}

/**
 * Options for a custom combobox, when the widget exposes them without being
 * opened. Many do not, in which case the filler opens it and reads them live.
 */
function optionsOfCombobox(el: HTMLElement, doc: Document): Array<{ value: string; label: string }> {
  const listId = attr(el, 'aria-owns') || attr(el, 'aria-controls')
  const list = listId ? doc.getElementById(listId) : el.parentElement?.querySelector('[role="listbox"]')
  if (!list) return []
  return Array.from(list.querySelectorAll('[role="option"]'))
    .map((o) => {
      const text = ((o as HTMLElement).innerText ?? '').trim()
      return { value: attr(o, 'data-value') || text, label: text }
    })
    .filter((o) => o.label)
    .slice(0, 200)
}

function isNoise(label: string, name: string): boolean {
  const haystack = `${label} ${name}`
  return NOISE_PATTERNS.some((re) => re.test(haystack))
}

/** Elements that could carry a question, in document order. */
function candidateElements(root: ParentNode): HTMLElement[] {
  const selector = [
    'input',
    'textarea',
    'select',
    '[role="combobox"]',
    '[role="radiogroup"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[contenteditable="true"]',
  ].join(',')
  return Array.from(root.querySelectorAll<HTMLElement>(selector))
}

/**
 * Harvest every answerable field on the page.
 *
 * Radio and checkbox members sharing a `name` collapse into one descriptor with
 * the members as options, because "Are you authorised to work?" is one question
 * even when it is rendered as three separate inputs.
 */
export function harvestFields(doc: Document = document): FieldDescriptor[] {
  const out: FieldDescriptor[] = []
  const seenGroups = new Set<string>()

  for (const el of candidateElements(doc)) {
    if (el instanceof HTMLInputElement && SKIP_TYPES.has(el.type)) continue
    if ((el as HTMLInputElement).disabled) continue
    if (attr(el, 'aria-hidden') === 'true') continue
    if (!isVisible(el)) continue

    const kind = kindOf(el)
    if (kind === 'unknown') continue

    const name = attr(el, 'name')
    const label = resolveLabel(el, doc)
    if (isNoise(label, name)) continue

    // Collapse radio and multi-checkbox groups.
    if ((kind === 'radio' || kind === 'checkbox') && name) {
      const groupKey = `${kind}:${name}`
      if (seenGroups.has(groupKey)) continue
      const members = Array.from(
        doc.querySelectorAll<HTMLInputElement>(`input[type="${kind}"][name="${CSS.escape(name)}"]`)
      ).filter(isVisible)

      if (members.length > 1 || kind === 'radio') {
        seenGroups.add(groupKey)
        const first = members[0] ?? el
        const options = members.map((m) => ({
          value: m.value,
          label: cleanLabel(resolveLabel(m, doc)) || m.value,
        }))
        const groupLabel = groupQuestion(members, doc) || label
        const checked = members.find((m) => m.checked)
        out.push(
          descriptor({
            el: first,
            doc,
            kind,
            label: groupLabel,
            options,
            currentValue: checked ? cleanLabel(resolveLabel(checked, doc)) || checked.value : '',
            group: name,
          })
        )
        continue
      }
    }

    const options =
      el instanceof HTMLSelectElement
        ? optionsOfSelect(el)
        : kind === 'combobox'
          ? optionsOfCombobox(el, doc)
          : []

    const currentValue =
      el instanceof HTMLSelectElement
        ? (el.selectedOptions[0]?.text ?? '').trim()
        : el instanceof HTMLInputElement && el.type === 'checkbox'
          ? String(el.checked)
          : el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
            ? el.value
            : (el.innerText ?? '').trim()

    out.push({ ...descriptor({ el, doc, kind, label, options, currentValue, group: '' }) })
  }

  return dedupeBySelector(out)
}

/**
 * The question a radio group is asking. The individual options are labelled
 * "Yes"/"No"; the question itself lives on the enclosing fieldset or wrapper.
 */
function groupQuestion(members: HTMLInputElement[], doc: Document): string {
  const first = members[0]
  if (!first) return ''
  const fieldset = first.closest('fieldset')
  const legend = fieldset?.querySelector('legend')
  if (legend?.innerText?.trim()) return cleanLabel(legend.innerText)

  const wrapper = first.closest(
    '[class*="field"], [class*="question"], [class*="form-group"], [role="radiogroup"], [data-automation-id]'
  )
  if (wrapper) {
    const groupLabel = attr(wrapper, 'aria-label')
    if (groupLabel) return cleanLabel(groupLabel)

    // A radiogroup usually points at its question rather than containing it.
    const labelledBy = attr(wrapper, 'aria-labelledby')
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((ref) => doc.getElementById(ref)?.innerText ?? '')
        .filter(Boolean)
        .join(' ')
      if (text.trim()) return cleanLabel(text)
    }
    const labelNode = wrapper.querySelector('label:not([for]), legend, [class*="label"]')
    const text = (labelNode as HTMLElement | null)?.innerText ?? ''
    // Reject a "label" that is just one of the options.
    const optionTexts = new Set(members.map((m) => normalizeText(resolveLabel(m, doc))))
    if (text.trim() && !optionTexts.has(normalizeText(text))) return cleanLabel(text)
  }
  return ''
}

function descriptor(input: {
  el: HTMLElement
  doc: Document
  kind: FieldKind
  label: string
  options: Array<{ value: string; label: string }>
  currentValue: string
  group: string
}): FieldDescriptor {
  const { el, doc, kind, label, options, currentValue, group } = input
  const maxLengthAttr = Number(attr(el, 'maxlength'))
  return {
    selector: buildSelector(el, doc),
    frameId: 0,
    kind,
    label,
    normalizedLabel: normalizeQuestion(label),
    placeholder: attr(el, 'placeholder'),
    name: attr(el, 'name'),
    id: attr(el, 'id'),
    required: isRequired(el, label),
    options,
    currentValue: String(currentValue ?? ''),
    maxLength: Number.isFinite(maxLengthAttr) && maxLengthAttr > 0 ? maxLengthAttr : null,
    group,
  }
}

function dedupeBySelector(fields: FieldDescriptor[]): FieldDescriptor[] {
  const seen = new Set<string>()
  const out: FieldDescriptor[] = []
  for (const f of fields) {
    if (!f.selector) continue // no stable handle; cannot be replayed reliably
    if (seen.has(f.selector)) continue
    seen.add(f.selector)
    out.push(f)
  }
  return out
}

/** Page text used for vendor detection and submission verification. */
export function pageText(doc: Document = document, max = 20000): string {
  return (doc.body?.innerText ?? '').slice(0, max)
}
