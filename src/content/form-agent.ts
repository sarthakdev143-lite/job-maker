/**
 * Form agent.
 *
 * Lives in every application page and does the things that can only be done
 * from inside the page: describe the form, write values, attach files, advance
 * a wizard, click submit, and confirm the submission landed.
 *
 * All judgement happens in the service worker. This script has no opinion about
 * what to fill in -- it receives a plan and executes it -- which keeps the
 * risky, site-specific code small and the decision-making code testable.
 */

import { harvestFields, pageText } from '@/form/harvester'
import { outlinePage } from '@/form/outline'
import { applyFillPlan, attachFile } from '@/form/filler'
import { adapterForUrl } from '@/sites/registry'
import { findSubmitByText } from '@/sites/generic'
import { GENERIC_NEXT_TEXT, firstMatch } from '@/sites/types'
import { workdayNeedsAccount } from '@/sites/workday'
import { humanClick } from '@/human/pointer'
import { personaForPage } from '@/human/persona'
import type { FormRequest, FormResponse } from '@/shared/messages'

/**
 * Press a control the way a person does -- approach, hover, press, release --
 * rather than firing a bare `click` at its dead centre. Some wizard controls
 * only react to `mousedown`, so this is also the more reliable press.
 */
async function pressControl(el: HTMLElement): Promise<void> {
  const persona = await personaForPage()
  await humanClick(el, { pressMs: persona.pressMs })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const HIGHLIGHT_STYLE_ID = 'autoapply-highlight-style'

/* ------------------------------------------------------------- submission */

function clickableSubmit(): { el: HTMLElement; selector: string } | null {
  const adapter = adapterForUrl(location.href)

  // A wizard that drives every step with one relabelled button can only be
  // told apart by the page it is on, which no selector can express.
  if (adapter.canSubmit && !adapter.canSubmit(document, location.href)) return null

  for (const sel of adapter.submitSelectors) {
    try {
      const el = document.querySelector<HTMLElement>(sel)
      if (el && !(el as HTMLButtonElement).disabled) return { el, selector: sel }
    } catch {
      // Bad selector; keep looking.
    }
  }
  const byText = findSubmitByText(document)
  return byText ? { el: byText, selector: '(matched by button text)' } : null
}

/**
 * A cheap fingerprint of the step currently on screen.
 *
 * Used to tell a wizard that moved from one that quietly refused to. Indeed's
 * "Save and continue" does nothing at all when the user's stored profile fails
 * its validation, with no thrown error and no navigation -- so the only way to
 * know is to look at the page before and after.
 */
function stepSignature(): string {
  const heading = (document.querySelector('h1, h2')?.textContent ?? '').trim().slice(0, 80)
  const fields = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select'))
    .map((el) => el.getAttribute('name') ?? el.id ?? '')
    .join('|')
  return `${location.pathname}::${heading}::${fields}`.slice(0, 600)
}

/** A control that steps past a page the normal next button will not leave. */
function clickableSkip(): { el: HTMLElement; selector: string } | null {
  const adapter = adapterForUrl(location.href)
  for (const sel of adapter.skipSelectors ?? []) {
    try {
      const el = document.querySelector<HTMLElement>(sel)
      if (el && !(el as HTMLButtonElement).disabled) return { el, selector: sel }
    } catch {
      // Keep looking.
    }
  }
  const byText = Array.from(document.querySelectorAll<HTMLElement>('button, a[role="button"]')).find(
    (el) => /^skip( for now| this step)?$/i.test((el.innerText ?? '').trim())
  )
  return byText ? { el: byText, selector: '(skip matched by text)' } : null
}

function clickableNext(): { el: HTMLElement; selector: string } | null {
  const adapter = adapterForUrl(location.href)
  for (const sel of adapter.nextStepSelectors ?? []) {
    try {
      const el = document.querySelector<HTMLElement>(sel)
      if (el && !(el as HTMLButtonElement).disabled) return { el, selector: sel }
    } catch {
      // Keep looking.
    }
  }
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, a[role="button"], div[role="button"]'))
  for (const el of candidates) {
    const label = (el.innerText ?? el.getAttribute('aria-label') ?? '').trim()
    if (GENERIC_NEXT_TEXT.test(label) && !(el as HTMLButtonElement).disabled) {
      return { el, selector: `(text: ${label})` }
    }
  }
  return null
}

/**
 * Did the submission land?
 *
 * Checked in order of decreasing reliability: an adapter's confirmation
 * element, confirmation text on the page, a URL that changed to a thank-you
 * route, and finally the disappearance of the form itself. Visible validation
 * errors override all of it -- a form that is complaining has not submitted.
 */
/** How a form says it will not take this application, in words. */
const REFUSAL_PATTERNS = [
  /there was an error processing your application[^.]*\.?/i,
  /(your )?application could not be (submitted|processed)[^.]*\.?/i,
  /we could not (submit|process) your application[^.]*\.?/i,
  /something went wrong[^.]{0,60}(application|submit)[^.]*\.?/i,
  /please (try again|complete the reCAPTCHA|verify)[^.]{0,60}\.?/i,
]

function verifySubmission(): { submitted: boolean; signal: string; detail: string } {
  const adapter = adapterForUrl(location.href)

  const errors = (adapter.errorSelectors ?? [])
    .flatMap((sel) => {
      try {
        return Array.from(document.querySelectorAll<HTMLElement>(sel))
      } catch {
        return []
      }
    })
    .filter((el) => (el.innerText ?? '').trim().length > 0 && el.offsetParent !== null)

  if (errors.length > 0) {
    const messages = errors
      .slice(0, 4)
      .map((e) => e.innerText.trim().replace(/\s+/g, ' '))
      .join(' | ')
    return { submitted: false, signal: 'validation_error', detail: messages.slice(0, 400) }
  }

  for (const sel of adapter.successSelectors ?? []) {
    try {
      if (document.querySelector(sel)) {
        return { submitted: true, signal: 'success_selector', detail: sel }
      }
    } catch {
      // Next candidate.
    }
  }

  const text = pageText(document, 6000)

  // A refusal the page states in prose rather than in an error element.
  // Greenhouse answers a submission its bot check does not like with "There
  // was an error processing your application", in a plain node that matches no
  // error selector -- so the run reported "no signal" and the user was told
  // nothing more useful than that the page had not changed.
  for (const re of REFUSAL_PATTERNS) {
    const hit = text.match(re)
    if (hit) return { submitted: false, signal: 'refused', detail: hit[0].slice(0, 200) }
  }

  for (const re of adapter.successPatterns) {
    const hit = text.match(re)
    if (hit) return { submitted: true, signal: 'success_text', detail: hit[0].slice(0, 160) }
  }

  if (/\/(thanks|thank-you|confirmation|success|submitted)\b/i.test(location.pathname)) {
    return { submitted: true, signal: 'success_url', detail: location.pathname }
  }

  return { submitted: false, signal: 'no_signal', detail: `still on ${location.pathname}` }
}

/* ------------------------------------------------------------- highlight */

function ensureHighlightStyle(): void {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = HIGHLIGHT_STYLE_ID
  style.textContent = `
    .autoapply-needs-review {
      outline: 2px solid #b45309 !important;
      outline-offset: 2px !important;
      background-color: rgba(180, 83, 9, 0.06) !important;
    }
  `
  document.head.appendChild(style)
}

function highlight(selectors: string[]): void {
  ensureHighlightStyle()
  document.querySelectorAll('.autoapply-needs-review').forEach((el) => el.classList.remove('autoapply-needs-review'))
  for (const sel of selectors) {
    try {
      document.querySelector(sel)?.classList.add('autoapply-needs-review')
    } catch {
      // Ignore selectors that no longer resolve.
    }
  }
}

/* --------------------------------------------------------------- routing */

async function handle(msg: FormRequest): Promise<FormResponse> {
  const adapter = adapterForUrl(location.href)

  switch (msg.type) {
    case 'form:ping':
      return { ok: true, type: 'form:pong', href: location.href }

    case 'form:detect': {
      const result = adapter.detect(document, location.href)
      // The same guard `clickableSubmit` consults, surfaced so the runner can
      // stop advancing the moment the final screen is reached.
      //
      // Without an adapter opinion the answer used to be an unconditional yes,
      // which is wrong on every company-hosted wizard: the runner was told the
      // first page was the last one, broke out of the step loop, went looking
      // for a submit button that only exists three pages later, and parked a
      // half-filled application as "no submit control found". Asking whether
      // this page actually has a submit control is both the honest answer and
      // exactly what the submit step will do next.
      const readyToSubmit = adapter.canSubmit
        ? adapter.canSubmit(document, location.href)
        : Boolean(clickableSubmit())
      const needsAccount = adapter.id === 'workday' && workdayNeedsAccount(document)
      return {
        ok: true,
        type: 'form:detect',
        result: {
          vendor: adapter.id,
          isApplicationForm: result.isApplicationForm && !needsAccount,
          jobTitle: result.jobTitle,
          company: result.company,
          confidence: needsAccount ? 0 : result.confidence,
          multiStep: result.multiStep,
          entrySubmitsImmediately: result.entrySubmitsImmediately ?? false,
          detail: needsAccount ? 'Workday requires an account for this employer' : result.detail,
          readyToSubmit,
        },
      }
    }

    case 'form:harvest': {
      const fields = harvestFields(document)
      const detected = adapter.detect(document, location.href)
      return { ok: true, type: 'form:harvest', fields, vendor: adapter.id, multiStep: detected.multiStep }
    }

    case 'form:fill': {
      const result = await applyFillPlan(msg.plan, msg.pacing, document)
      return { ok: true, type: 'form:fill', result }
    }

    case 'form:uploadFile': {
      const { success, detail } = await attachFile(
        msg.selector,
        msg.fileName,
        msg.mimeType,
        msg.dataUrl,
        document
      )
      return { ok: true, type: 'form:uploadFile', success, detail }
    }

    case 'form:submit': {
      const explicit = msg.selector
        ? { el: document.querySelector<HTMLElement>(msg.selector), selector: msg.selector }
        : null
      const target = explicit?.el ? { el: explicit.el, selector: explicit.selector } : clickableSubmit()
      if (!target) {
        return { ok: true, type: 'form:submit', result: { clicked: false, selector: '', detail: 'no submit control found' } }
      }
      await pressControl(target.el)
      return {
        ok: true,
        type: 'form:submit',
        result: { clicked: true, selector: target.selector, detail: (target.el.innerText ?? '').trim().slice(0, 80) },
      }
    }

    case 'form:advanceStep': {
      const before = stepSignature()
      const next = clickableNext()

      if (next) {
        await pressControl(next.el)
        await sleep(1200) // let the wizard render the following step
        if (stepSignature() !== before) {
          return { ok: true, type: 'form:advanceStep', advanced: true, detail: next.selector }
        }
      }

      // The page did not move. On Indeed that means its own stored profile
      // failed validation on a step we did not fill and cannot fix from here,
      // and the page offers a way past it. Taking that beats parking the job.
      const skip = clickableSkip()
      if (!skip) {
        return {
          ok: true,
          type: 'form:advanceStep',
          advanced: false,
          detail: next ? `${next.selector} did not move the form` : 'no next control',
        }
      }

      await pressControl(skip.el)
      await sleep(1200)
      const moved = stepSignature() !== before
      return {
        ok: true,
        type: 'form:advanceStep',
        advanced: moved,
        detail: moved ? `skipped past a blocked step (${skip.selector})` : 'neither continue nor skip moved the form',
      }
    }

    case 'form:verifySubmission':
      return { ok: true, type: 'form:verifySubmission', result: verifySubmission() }

    case 'form:snapshot':
      return {
        ok: true,
        type: 'form:snapshot',
        html: document.documentElement.outerHTML.slice(0, 500_000),
        text: pageText(document),
      }

    case 'form:outline':
      return { ok: true, type: 'form:outline', outline: outlinePage(document, location.href) }

    case 'form:click': {
      let el: HTMLElement | null = null
      try {
        el = document.querySelector<HTMLElement>(msg.selector)
      } catch {
        return { ok: true, type: 'form:click', clicked: false, detail: `unusable selector: ${msg.selector}` }
      }
      if (!el) return { ok: true, type: 'form:click', clicked: false, detail: 'selector matched nothing' }
      if ((el as HTMLButtonElement).disabled) {
        return { ok: true, type: 'form:click', clicked: false, detail: 'control is disabled' }
      }
      await pressControl(el)
      return {
        ok: true,
        type: 'form:click',
        clicked: true,
        detail: (el.innerText ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 80),
      }
    }

    case 'form:highlight':
      highlight(msg.selectors)
      return { ok: true, type: 'form:highlight' }

    default:
      return { ok: false, error: `Unknown form request: ${(msg as { type: string }).type}` }
  }
}

chrome.runtime.onMessage.addListener((msg: FormRequest, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !String(msg.type ?? '').startsWith('form:')) return false
  void handle(msg).then(sendResponse, (e: Error) => sendResponse({ ok: false, error: e.message }))
  return true
})

/** Convenience: click the adapter's "apply" entry point when asked to. */
export function openApplyForm(): boolean {
  const adapter = adapterForUrl(location.href)
  const el = firstMatch(document, adapter.applyEntrySelectors ?? [])
  if (!el) return false
  void pressControl(el)
  return true
}
