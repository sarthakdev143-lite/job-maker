/**
 * Reading a custom dropdown's choices by opening it.
 *
 * `harvestFields` is synchronous and pure, which is what makes it testable, and
 * it can only report the options a widget has already rendered. React-select
 * renders nothing until the control is clicked, so a live Greenhouse form came
 * back with three mandatory questions carrying zero options each:
 *
 *     Are you legally authorized to work in the country…   options(0)
 *     What is the source of your right to work…            options(0)
 *     Voluntary Self-Identification of Gender              options(0)
 *
 * Every tier downstream needs those choices. The profile answer for a gender
 * question is "decline to self-identify", which is an option or it is nothing;
 * the guess tier picks the most defensible option on offer and has none to pick
 * from; and the model is asked to answer a multiple-choice question without
 * being shown the choices. All three were parked, and a Greenhouse application
 * with a mandatory question left blank is rejected on submit.
 *
 * So this opens each option-less dropdown, reads the menu, and closes it again.
 * It runs once per page after harvesting, costs about a second, and is the
 * difference between a form that can be submitted and one that cannot.
 */

import { humanClick } from '@/human/pointer'
import type { FieldDescriptor } from '@/storage/schemas'

/** How long to wait for a menu to render before giving up on one widget. */
const MENU_TIMEOUT_MS = 700

/** More than this and it is a country list; nobody needs all of it to choose. */
const MAX_OPTIONS = 200

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The same selectors the filler uses to find an option to click, so a menu this
 * can read is a menu the filler can operate.
 */
const OPTION_SELECTOR =
  '[role="option"], li[data-value], .select__option, [class*="option"], ' +
  '[class*="dropdown-location"], [class*="suggestion"], [class*="autocomplete"] li'

function readMenu(anchor: HTMLElement, doc: Document): Array<{ value: string; label: string }> {
  const listId = anchor.getAttribute('aria-owns') || anchor.getAttribute('aria-controls')
  const scopes: ParentNode[] = []
  const byId = listId ? doc.getElementById(listId) : null
  if (byId) scopes.push(byId)
  scopes.push(doc)

  for (const scope of scopes) {
    const candidates = Array.from(scope.querySelectorAll<HTMLElement>(OPTION_SELECTOR)).filter(
      (o) => (o.innerText ?? '').trim() && o.offsetParent !== null
    )
    // Keep the leaves: the container matches these selectors too, and reading
    // it would produce one "option" holding the text of the whole list.
    const leaves = candidates.filter((o) => !candidates.some((other) => other !== o && o.contains(other)))
    if (leaves.length === 0) continue

    return leaves
      .map((o) => {
        const label = (o.innerText ?? '').trim()
        return { value: o.getAttribute('data-value') || label, label }
      })
      .filter((o) => o.label)
      .slice(0, MAX_OPTIONS)
  }
  return []
}

function close(el: HTMLElement, doc: Document): void {
  const target = doc.activeElement instanceof HTMLElement ? doc.activeElement : el
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', keyCode: 27 }))
  if (target instanceof HTMLElement) target.blur()
}

/**
 * Fill in the options of every dropdown that reported none, in place.
 *
 * Returns how many fields gained options, which is worth logging: a page where
 * this does nothing is a page where the widgets render their menus up front,
 * and a page where it does a lot is one that would otherwise have parked half
 * its questions.
 *
 * Widgets that legitimately have nothing to show until you type -- a city
 * typeahead backed by a search API -- come back empty, which is the same
 * answer as before and costs one click.
 */
export async function revealComboboxOptions(
  fields: FieldDescriptor[],
  doc: Document = document
): Promise<number> {
  let filled = 0

  for (const field of fields) {
    if (field.kind !== 'combobox' || field.options.length > 0) continue

    let el: HTMLElement | null = null
    try {
      el = doc.querySelector<HTMLElement>(field.selector)
    } catch {
      continue // a selector the browser will not parse is not worth a retry
    }
    if (!el) continue

    try {
      await humanClick(el)
      const deadline = Date.now() + MENU_TIMEOUT_MS
      let options: Array<{ value: string; label: string }> = []
      while (Date.now() < deadline) {
        options = readMenu(el, doc)
        if (options.length > 0) break
        await sleep(60)
      }
      if (options.length > 0) {
        field.options = options
        filled++
      }
    } catch {
      // One widget refusing to open is not a reason to stop reading the rest.
    } finally {
      close(el, doc)
      // Let the menu finish unmounting before the next one is opened, so two
      // open listboxes are never on the page at the same time.
      await sleep(120)
    }
  }

  return filled
}
