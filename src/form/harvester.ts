/**
 * Field harvesting.
 *
 * Walks a page and produces a FieldDescriptor for every question a human would
 * have to answer. The hard part is not finding inputs, it is finding what each
 * input is *asking*: ATS forms label fields through at least six different
 * mechanisms, and getting the label wrong means the answer bank never hits and
 * the model answers the wrong question.
 */

import { buildSelector, oneByAttr, queryByAttr } from './selector'
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
  const id = attr(el, 'id')
  const controlName = attr(el, 'name')

  // 1. <label for="...">
  //
  // Ashby points the label at the control's *name* rather than its id, and its
  // controls carry no id at all, so checking the id alone meant the question
  // was never found: the three work-authorisation questions on a real Ashby
  // form came through as three identical required checkboxes reading "No".
  // An id is tried first because a page may label both.
  const forLabel = (oneByAttr(doc, 'label', 'for', id) ?? oneByAttr(doc, 'label', 'for', controlName)) as
    | HTMLLabelElement
    | null
  if (forLabel?.innerText) return cleanLabel(forLabel.innerText)

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

/**
 * Is this plain-looking input actually the visible half of a custom dropdown?
 *
 * react-select and every widget shaped like it render a real `<input type=
 * "text">` and keep the chosen value somewhere else entirely, so writing into
 * the input sets a value the widget does not read and then wipes on blur.
 * Greenhouse builds Country, Location, the sponsorship question and every EEO
 * field this way: on a live form those are six controls, three of them
 * mandatory, that looked like text boxes and silently refused every value.
 *
 * `role="combobox"` is the decisive signal, with the ARIA autocomplete pair as
 * a fallback for widgets that set one but not the other.
 */
function looksLikeCombobox(el: HTMLElement): boolean {
  if (attr(el, 'role') === 'combobox') return true
  const auto = attr(el, 'aria-autocomplete')
  if (auto === 'list' || auto === 'both') return true
  return attr(el, 'aria-haspopup') === 'listbox' && el.hasAttribute('aria-expanded')
}

function kindOf(el: HTMLElement): FieldKind {
  if (el instanceof HTMLTextAreaElement) return 'textarea'
  if (el instanceof HTMLSelectElement) return 'select'
  if (el instanceof HTMLInputElement) {
    // Checked and file inputs are never dropdowns; everything else might be.
    const fixed = el.type === 'radio' || el.type === 'checkbox' || el.type === 'file'
    if (!fixed && looksLikeCombobox(el)) return 'combobox'
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

/**
 * The selectable members of an ARIA choice group.
 *
 * A React-rendered yes/no or multiple-choice question is a `div[role=
 * "radiogroup"]` holding `div[role="radio"]` members. It has no `name` to group
 * by and no `<option>`s to enumerate, so the collapse in `harvestFields` --
 * which is written entirely in terms of `input[type=radio][name=...]` -- could
 * not see it. Such a group was harvested as a radio question carrying *zero*
 * options, which left the resolver and the model with nothing to choose from,
 * and the filler with no writer at all, so the field was reported unfillable
 * and parked. Workable, SmartRecruiters and the current Lever and Ashby forms
 * all render their choice questions this way, so this was not an edge case: it
 * was most of the mandatory questions on the forms the agent actually meets.
 *
 * A `radiogroup` holds `role="radio"`; a multi-select holds a `role="group"` of
 * `role="checkbox"`. Both are searched, in that order, because a container is
 * free to mix them and a question is whichever kind it actually holds.
 */
function ariaMembersOf(el: HTMLElement, role: 'radio' | 'checkbox'): HTMLElement[] {
  if (attr(el, 'role') === role) return [el]
  return Array.from(el.querySelectorAll<HTMLElement>(`[role="${role}"], [role="option"]`)).filter(isVisible)
}

function optionsFromMembers(members: HTMLElement[]): Array<{ value: string; label: string }> {
  return members
    .map((m) => {
      const text = ((m.innerText ?? m.textContent ?? '') || attr(m, 'aria-label')).trim()
      return { value: attr(m, 'data-value') || attr(m, 'value') || text, label: text }
    })
    .filter((o) => o.label)
    .slice(0, 200)
}

/** Selection state, for both real inputs and ARIA members. */
function isAriaChecked(el: HTMLElement): boolean {
  return attr(el, 'aria-checked') === 'true' || (el as HTMLInputElement).checked === true
}

/** The label of the selected member, or '' when the question is unanswered. */
function ariaCheckedLabel(members: HTMLElement[]): string {
  const checked = members.find(isAriaChecked)
  if (!checked) return ''
  return ((checked.innerText ?? checked.textContent ?? '') || attr(checked, 'aria-label')).trim()
}

/**
 * A stable key for a choice group with no `name`, so the filler can find the
 * same group again after a re-render. `id` and `aria-labelledby` survive; a
 * generated id is no better than nothing, so the element's own selector is the
 * fallback.
 */
function ariaGroupKey(el: HTMLElement, doc: Document): string {
  return (
    attr(el, 'name') ||
    (() => {
      const id = attr(el, 'id')
      if (id && !/^[:.]|[:.]$/.test(id)) return `aria:${id}`
      const labelledBy = attr(el, 'aria-labelledby')
      if (labelledBy) return `aria:by:${labelledBy}`
      return buildSelector(el, doc)
    })()
  )
}

/**
 * Ashby's Yes/No widget: two buttons and a hidden checkbox behind them.
 *
 *   <label for="<uuid>">Are you authorised to work in the country where the job
 *   is located?</label>
 *   <div class="ashby-application-form-input-yesno">
 *     <button data-option="yes" aria-pressed="false">Yes</button>
 *     <button data-option="no"  aria-pressed="false">No</button>
 *     <input type="checkbox" tabindex="-1" name="<uuid>">
 *   </div>
 *
 * The checkbox is a value store, not the control, and it is the only element
 * the harvester used to see. It produced one required boolean per question,
 * labelled "No" -- the visible text of whichever button came last -- so the
 * three questions that matter most on the whole form (work authorisation,
 * sponsorship, office attendance) arrived as three identical, mutually
 * indistinguishable fields. Nothing upstream could answer them, because the
 * answer bank matched on question text and there was none.
 *
 * The container is harvested instead, with the buttons as the options.
 */
function yesNoButtons(el: HTMLElement): HTMLElement[] {
  const buttons = Array.from(
    el.querySelectorAll<HTMLElement>('button[data-option], [role="radio"][data-option]')
  )
  if (buttons.length >= 2) return buttons
  // Fall back on the ARIA toggle pair, which is the same widget without the
  // vendor's class name.
  const pressed = Array.from(el.querySelectorAll<HTMLElement>('button[aria-pressed]'))
  return pressed.length >= 2 ? pressed : []
}

function isYesNoContainer(el: HTMLElement): boolean {
  return yesNoButtons(el).length >= 2
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
    '[role="group"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[class*="yesno"]',
    '[contenteditable="true"]',
  ].join(',')
  // `role="radio"` members are deliberately absent: a radiogroup is harvested as
  // one question with its members as options, so collecting the members too
  // would emit one empty descriptor per Yes/No.
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

    // The hidden checkbox behind a Yes/No pair holds the value; the buttons
    // beside it are the control. Emitting both produced the same question
    // twice, once of them unreadable.
    if (el instanceof HTMLInputElement && el.type === 'checkbox' && isYesNoContainer(el.parentElement ?? el)) {
      continue
    }

    const kind = kindOf(el)

    const name = attr(el, 'name')
    const label = resolveLabel(el, doc)
    if (isNoise(label, name)) continue

    // A choice group built from ARIA roles rather than from `<input>`s, handled
    // before the `unknown` skip below -- a `role="group"` container is not a
    // control in its own right, so it is classified as unknown and discarded
    // before anything could harvest the question it carries.
    //
    // The container carries the question and the members carry the options, so
    // the container is what gets harvested and every member is suppressed. Both
    // halves matter: harvesting each member separately produced one field per
    // "Yes"/"No" with no question attached, and a multi-select question
    // collapsed into N independent booleans that could each only be true or
    // false -- so a candidate who reads three languages had three boxes ticked
    // to describe one answer, and the answer bank had nothing coherent to match.
    const ariaRole = attr(el, 'role')
    if (ariaRole === 'radiogroup' || ariaRole === 'group' || (ariaRole === 'radio' && !name)) {
      const groupKey = `aria:${ariaGroupKey(el, doc)}`
      if (seenGroups.has(groupKey)) continue

      const radioMembers = ariaMembersOf(el, 'radio')
      const checkMembers = radioMembers.length ? [] : ariaMembersOf(el, 'checkbox')
      const members = radioMembers.length ? radioMembers : checkMembers
      const groupKind: FieldKind = radioMembers.length ? 'radio' : 'checkbox'

      if (members.length > 1) {
        seenGroups.add(groupKey)
        const options = optionsFromMembers(members)
        out.push(
          descriptor({
            el,
            doc,
            kind: groupKind,
            label: groupQuestionAria(el, doc) || label,
            options,
            currentValue: ariaCheckedLabel(members),
            group: groupKey,
          })
        )
      }
      // Anything this branch did not claim is not a question of its own.
      continue
    }

    // A standalone `role="checkbox"`/`role="switch"` toggle: one question, no
    // group, no input behind it. Harvested on the same terms as a native one.
    if ((ariaRole === 'checkbox' || ariaRole === 'switch') && !(el instanceof HTMLInputElement)) {
      // ...unless it is a member of a group the container branch already claimed.
      const parent = el.parentElement
      if (parent && parent !== el && ariaMembersOf(parent, 'checkbox').length > 1) continue
      out.push(
        descriptor({
          el,
          doc,
          kind: 'checkbox',
          label,
          options: [],
          currentValue: String(isAriaChecked(el)),
          group: '',
        })
      )
      continue
    }

    // Ashby's Yes/No button pair, before anything reads the hidden checkbox
    // behind it. See `yesNoButtons` for why that checkbox is not the control.
    if (isYesNoContainer(el)) {
      const groupKey = `yesno:${ariaGroupKey(el, doc)}`
      if (!seenGroups.has(groupKey)) {
        seenGroups.add(groupKey)
        const buttons = yesNoButtons(el)
        const options = optionsFromMembers(buttons)
        // The question lives on the label for the backing input, which is where
        // `resolveLabel` now looks too, so `label` already carries it.
        out.push(
          descriptor({
            el,
            doc,
            kind: 'radio',
            label: label,
            options,
            currentValue: ariaCheckedLabel(buttons),
            group: groupKey,
          })
        )
      }
      continue
    }

    if (kind === 'unknown') continue

    // Collapse radio and multi-checkbox groups.
    if ((kind === 'radio' || kind === 'checkbox') && name) {
      const groupKey = `${kind}:${name}`
      if (seenGroups.has(groupKey)) continue
      const members = queryByAttr(
        doc,
        `input[type="${kind}"]`,
        'name',
        name
      ).filter(isVisible) as HTMLInputElement[]

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
 * The question an ARIA choice group is asking.
 *
 * A radiogroup points at its question with `aria-labelledby` far more often
 * than it contains it, and its own `aria-label` is the next most common. Both
 * are checked before the wrapper scan, because the wrapper almost always
 * contains the "Yes"/"No" member text and would hand back an option as if it
 * were the question.
 */
function groupQuestionAria(el: HTMLElement, doc: Document): string {
  const groupLabel = attr(el, 'aria-label')
  if (groupLabel) return cleanLabel(groupLabel)

  const labelledBy = attr(el, 'aria-labelledby')
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((ref) => doc.getElementById(ref)?.innerText ?? '')
      .filter(Boolean)
      .join(' ')
    if (text.trim()) return cleanLabel(text)
  }

  const wrapper = el.closest(
    '[class*="field"], [class*="question"], [class*="form-group"], [data-automation-id], fieldset'
  )
  if (wrapper) {
    const labelNode = wrapper.querySelector('label:not([for]), legend, [class*="label"], [id*="label"]')
    const text = (labelNode as HTMLElement | null)?.innerText ?? ''
    const optionTexts = new Set(
      Array.from(el.querySelectorAll<HTMLElement>('[role="radio"], [role="option"]')).map((m) =>
        normalizeText(m.innerText ?? m.textContent ?? '')
      )
    )
    if (text.trim() && !optionTexts.has(normalizeText(text))) return cleanLabel(text)
  }
  return ''
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
