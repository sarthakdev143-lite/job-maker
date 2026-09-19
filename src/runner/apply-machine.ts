/**
 * The apply state machine.
 *
 * One job in, one Application record out. The steps are always the same:
 *
 *   open -> detect -> (enter the form) -> harvest -> generate docs -> resolve
 *        -> fill -> attach -> [advance & repeat for wizards] -> gate
 *        -> submit | park -> verify -> record -> close
 *
 * Two invariants hold throughout. First, the tab is always closed, on every
 * path, including thrown errors -- a leaked minimized window is invisible to
 * the user and accumulates. Second, the gate is consulted exactly once, after
 * filling and immediately before the only `form:submit` call in the codebase.
 */

import { applicationsRepo, jobsRepo } from '@/storage/db'
import { bumpCounter, getCounter, getProfile, getSettings } from '@/storage/settings'
import { remember } from '@/storage/answer-bank'
import { resolveFields } from '@/form/resolver'
import { isOffLimitsQuestion } from '@/form/guess'
import { generateDocuments } from '@/documents/tailor'
import { blobToDataUrl } from '@/documents/pdf'
import { docsRepo } from '@/storage/db'
import { adapterById, vendorForUrl } from '@/sites/registry'
import { dailyCounterKey, evaluateGate, explainDecision, type GateDecision } from './autonomy-gate'
import type {
  FormDetectResult,
  FormFillResult,
  FormResponse,
  FormSubmitResult,
  FormVerifyResult,
} from '@/shared/messages'
import type { Application, FieldDescriptor, FilledField, Job, Settings } from '@/storage/schemas'
import { createLogger } from '@/shared/logger'
import { errorMessage, pause, sleep, uid, withTimeout } from '@/shared/util'
import { ensureContentScript, formAgentFiles, PermissionError } from '@/shared/injection'
import {
  APPLY_CONTROL_THRESHOLD,
  findApplyControl,
  findNextControl,
  NEXT_CONTROL_THRESHOLD,
  readSubmissionState,
} from '@/form/page-reasoner'
import type { PageOutline } from '@/form/outline'
import { learnApplyEntry, missApplyEntry, rememberedApplyEntry } from '@/storage/site-memory'
import { recordEvidence } from '@/storage/evidence'
import { closeWorkerWindow, isOwnedWindow, openWorkerWindow, rememberOwnedWindow } from '@/shared/windows'
import { activity } from '@/shared/activity'

const log = createLogger('runner')

/**
 * Indeed's Easy Apply splits itself finely -- contact, resume, several pages of
 * screening questions, then review -- and eight steps was not enough to reach
 * the submit button on a posting with a long questionnaire. The loop still
 * stops early whenever a step fails to change, so a higher ceiling costs
 * nothing on shorter forms.
 */
const MAX_WIZARD_STEPS = 14
const TAB_LOAD_TIMEOUT_MS = 45000
const AGENT_READY_TIMEOUT_MS = 25000

export type ApplyOptions = {
  /** Fill and stop, whatever the settings say. Used by "test on this URL". */
  forceDryRun?: boolean
  /** The user started this run by hand, so the working-hours window is moot. */
  ignoreActiveHours?: boolean
  shouldStop?: () => boolean
  onStep?: (step: string, detail?: string) => void
}

export type ApplyOutcome = {
  application: Application
  decision: GateDecision
  submitted: boolean
}

/* ------------------------------------------------------------ tab control */

/**
 * A tab plus the frame the application form actually lives in.
 *
 * Embedded boards are the norm rather than the exception -- a company drops
 * Greenhouse or Ashby into an iframe on its own careers page -- and a message
 * broadcast to every frame is answered by whichever one replies first, which is
 * usually the empty top frame. Pinning the frame once and addressing it
 * explicitly is the difference between "no application form found" and a
 * working submission on a large share of real postings.
 */
type WorkerTab = {
  tabId: number
  windowId: number
  frameId?: number
  /**
   * Windows opened by the page itself that we have taken over.
   *
   * Indeed's apply button frequently opens its form in a new tab rather than
   * navigating, and the same is true of several ATSes embedded behind a job
   * advert. Those windows are ours to close even though we did not create them:
   * left behind, an overnight run accumulates one per application.
   */
  extraWindowIds?: number[]
}

async function openTab(url: string): Promise<WorkerTab> {
  return openWorkerWindow(url, { minimized: true })
}

async function closeTab(tab: WorkerTab | null): Promise<void> {
  for (const windowId of tab?.extraWindowIds ?? []) {
    await closeWorkerWindow(windowId)
  }
  await closeWorkerWindow(tab?.windowId)
}

/**
 * Tab ids currently open in windows this agent owns.
 *
 * Scoped to our own windows on purpose. The first version queried every tab in
 * every window, so a tab the user happened to open while a run was in flight
 * looked exactly like the one Indeed had just opened for us -- and the runner
 * would adopt it, drive it, and then close it along with its window.
 */
async function openTabIds(): Promise<Set<number>> {
  const tabs = await chrome.tabs.query({}).catch(() => [])
  return new Set(
    tabs
      .filter((t) => isOwnedWindow(t.windowId))
      .map((t) => t.id)
      .filter((id): id is number => typeof id === 'number')
  )
}

/**
 * Take over a tab the page opened for us.
 *
 * Clicking "Apply" is as likely to open a new tab as to navigate, and the
 * runner used to re-detect in the original one -- still showing the advert --
 * conclude there was no form, and skip a perfectly good application. Polling
 * briefly for a tab that did not exist before the click, and continuing in it,
 * is what makes Indeed's Easy Apply reachable at all.
 */
async function adoptNewTab(before: Set<number>, tab: WorkerTab, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tabs = await chrome.tabs.query({}).catch(() => [])
    // Only a tab that appeared inside one of our own windows counts. Indeed
    // opens its form from the window we are driving, so the real one always
    // satisfies this; a tab the user opened elsewhere never does.
    const fresh = tabs.find(
      (t) => typeof t.id === 'number' && !before.has(t.id) && isOwnedWindow(t.windowId)
    )
    if (fresh?.id !== undefined) {
      // Keep the original around rather than closing it: the finally block
      // closes both, and closing it here would race the navigation.
      tab.extraWindowIds = [...(tab.extraWindowIds ?? []), tab.windowId]
      tab.tabId = fresh.id
      if (fresh.windowId !== undefined) tab.windowId = fresh.windowId
      tab.frameId = undefined
      // The adopted tab can live in a window we did not create (Indeed opens a
      // new one). Without recording it, the finally-block close refuses the id
      // as unowned and the window leaks -- one per application, all night.
      if (tab.windowId !== undefined) await rememberOwnedWindow(tab.windowId)
      // A tab the browser just opened is usually focused and visible; push it
      // out of the way so an overnight run does not steal the screen.
      await chrome.windows.update(tab.windowId, { state: 'minimized' }).catch(() => {})
      return true
    }
    await sleep(400)
  }
  return false
}

async function waitForLoad(tabId: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < TAB_LOAD_TIMEOUT_MS) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab) throw new Error('Application tab closed unexpectedly')
    if (tab.status === 'complete') {
      await sleep(1400) // client-rendered forms mount after load completes
      return
    }
    await sleep(400)
  }
  throw new Error('Application page never finished loading')
}

/**
 * Talk to the form agent in the pinned frame.
 *
 * A submission usually navigates, which destroys the frame we pinned. Rather
 * than treat that as a failure, fall back to addressing the whole tab so the
 * confirmation page can still answer.
 */
async function callAgent<T extends FormResponse>(tab: WorkerTab, message: object): Promise<T> {
  let res: T | undefined
  if (tab.frameId === undefined) {
    res = (await chrome.tabs.sendMessage(tab.tabId, message)) as T | undefined
  } else {
    try {
      res = (await chrome.tabs.sendMessage(tab.tabId, message, { frameId: tab.frameId })) as T | undefined
    } catch {
      tab.frameId = undefined
      res = (await chrome.tabs.sendMessage(tab.tabId, message)) as T | undefined
    }
  }
  if (!res) throw new Error('Form agent did not respond')
  if (res.ok === false) throw new Error(res.error)
  return res
}

/**
 * Find the frame holding the application form.
 *
 * Scores every frame by how much it looks like an application: a file input, an
 * email field, a form, and apply-ish wording. The top frame wins ties, so an
 * ordinary single-frame page costs one cheap probe and nothing else.
 */
async function pickFormFrame(tabId: number): Promise<number | undefined> {
  let results: chrome.scripting.InjectionResult<number>[]
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea')
        if (inputs.length === 0) return 0
        let score = Math.min(inputs.length, 12)
        if (document.querySelector('input[type="file"]')) score += 8
        if (document.querySelector('input[type="email"], input[name*="email" i]')) score += 6
        if (document.querySelector('form')) score += 4
        if (/apply|application/i.test(document.body?.innerText?.slice(0, 3000) ?? '')) score += 4
        return score
      },
    })
  } catch {
    return undefined
  }

  let best: { frameId: number; score: number } | null = null
  for (const result of results) {
    const score = typeof result.result === 'number' ? result.result : 0
    if (score <= 0) continue
    const isTop = result.frameId === 0
    if (!best || score > best.score || (score === best.score && isTop)) {
      best = { frameId: result.frameId, score }
    }
  }
  return best?.frameId
}

async function ensureAgent(tabId: number): Promise<void> {
  await ensureContentScript(
    tabId,
    formAgentFiles(),
    { type: 'form:ping' },
    { timeoutMs: AGENT_READY_TIMEOUT_MS, allFrames: true }
  )
}

/**
 * Advert-page details read from the already-open tab.
 *
 * Volume mode skips discovery hydration, so the job record often carries only
 * a card snippet. Opening forty advert windows up front to fix that is what
 * kept the agent "getting ready" instead of applying -- but the apply machine
 * opens the advert anyway on its way to the form, so it reads the real
 * description, the authoritative Easy Apply signal, and the off-Indeed apply
 * link here, at zero extra window cost.
 */
async function readAdvertDetails(tabId: number): Promise<{
  description: string
  easyApply: boolean
  applyHref: string
}> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const text = (el: Element | null): string => ((el as HTMLElement | null)?.innerText ?? '').trim()
      const descSelectors = [
        '#jobDescriptionText',
        '.jobsearch-JobComponent-description',
        '[data-testid="jobDescriptionText"]',
        '.jobDescriptionContent',
        '[class*="job-desc"]',
        'main',
      ]
      let description = ''
      for (const sel of descSelectors) {
        try {
          const found = text(document.querySelector(sel))
          if (found.length > description.length) description = found
        } catch {
          // Try the next selector.
        }
      }
      if (description.length < 200) description = (document.body?.innerText ?? '').slice(0, 20000)

      const applyEl = document.querySelector(
        '#indeedApplyButton, [data-testid^="indeedApplyButton"], .jobsearch-IndeedApplyButton, #applyButtonLinkContainer a, a[href*="/applystart"]'
      ) as HTMLAnchorElement | null
      const applyHref = applyEl instanceof HTMLAnchorElement ? applyEl.href : ''
      const pageText = (document.body?.innerText ?? '').slice(0, 4000)
      const easyApply =
        Boolean(
          document.querySelector(
            '#indeedApplyButton, [data-testid^="indeedApplyButton"], .jobsearch-IndeedApplyButton'
          )
        ) || /easily apply|apply with indeed/i.test(pageText)

      return { description: description.slice(0, 20000), easyApply, applyHref }
    },
  })
  const value = result?.result as { description: string; easyApply: boolean; applyHref: string } | undefined
  return value ?? { description: '', easyApply: false, applyHref: '' }
}

/** Click the adapter's "apply" entry point, when the form is behind one. */
async function clickApplyEntry(tabId: number, selectors: string[]): Promise<boolean> {
  if (selectors.length === 0) return false

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [selectors],
    // Serialized into the page, so it cannot import the shared pointer helper
    // and carries its own small copy: hover, press, release, then the native
    // activation. A bare `click()` at an element's exact centre is both an
    // obvious automation signature and, on widgets that listen for `mousedown`,
    // simply ignored.
    func: (sels: string[]) => {
      const press = (el: HTMLElement): void => {
        const r = el.getBoundingClientRect()
        const x = Math.round(r.left + r.width * (0.35 + Math.random() * 0.3))
        const y = Math.round(r.top + r.height * (0.35 + Math.random() * 0.3))
        const at = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }
        for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
          try {
            const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
            el.dispatchEvent(new Ctor(Ctor === MouseEvent ? type.replace('pointer', 'mouse') : type, at))
          } catch {
            // An event this DOM cannot build is not a reason to skip the click.
          }
        }
        el.click()
      }
      for (const sel of sels) {
        try {
          const el = document.querySelector(sel) as HTMLElement | null
          if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' })
            press(el)
            return true
          }
        } catch {
          // Try the next selector.
        }
      }
      return false
    },
  })
  return Boolean(result?.result)
}

/* --------------------------------------------------- model-read navigation */

/**
 * Ask the page to describe itself, in a form a model can read.
 *
 * Failing softly on purpose. Every caller of this is already on a fallback
 * path, and an outline that could not be taken should leave the original
 * failure standing rather than replace it with a messaging error.
 */
async function outlineOf(tab: WorkerTab): Promise<PageOutline | null> {
  try {
    const res = await callAgent<Extract<FormResponse, { type: 'form:outline' }>>(tab, { type: 'form:outline' })
    return res.outline
  } catch {
    return null
  }
}

/**
 * Find the apply control by asking the model to read the page.
 *
 * Runs only after the adapter's selectors have already missed. Records what it
 * saw on the application's timeline either way: a fallback that fails is the
 * single most useful thing to be able to read afterwards, and the old code
 * recorded nothing at all.
 */
async function applyControlFromModel(
  tab: WorkerTab,
  job: Job,
  applicationId: string
): Promise<{ selector: string; text: string }> {
  const outline = await outlineOf(tab)
  if (!outline) {
    await applicationsRepo.addTimeline(applicationId, 'fallback', 'could not read the page to ask the model', 'warn')
    return { selector: '', text: '' }
  }

  try {
    const found = await findApplyControl(outline, { title: job.title, company: job.company })
    if (!found.selector || found.confidence < APPLY_CONTROL_THRESHOLD) {
      await applicationsRepo.addTimeline(
        applicationId,
        'fallback',
        found.selector
          ? `model found "${found.text}" but was only ${Math.round(found.confidence * 100)}% sure; not clicking it`
          : `model found no apply control among ${outline.elements.length} control(s): ${found.reasoning}`,
        'warn'
      )
      return { selector: '', text: '' }
    }

    await applicationsRepo.addTimeline(
      applicationId,
      'fallback',
      `selectors missed; model chose "${found.text}" (${Math.round(found.confidence * 100)}%): ${found.reasoning}`
    )
    return { selector: found.selector, text: found.text }
  } catch (e) {
    await applicationsRepo.addTimeline(applicationId, 'fallback', `model could not read the page: ${errorMessage(e)}`, 'warn')
    return { selector: '', text: '' }
  }
}

/**
 * Move a multi-step form on when its own continue control could not be found.
 *
 * Refuses anything the model says would submit. The autonomy gate runs after
 * the form is filled and before submission for a reason, and a wizard step that
 * quietly turns out to be the send button would walk straight past it -- which
 * on a dry run means sending an application the user explicitly asked not to
 * send.
 */
async function advanceViaModel(
  tab: WorkerTab,
  applicationId: string,
  answered: number
): Promise<{ advanced: boolean; detail: string }> {
  const outline = await outlineOf(tab)
  if (!outline) return { advanced: false, detail: '' }

  try {
    const next = await findNextControl(outline, answered)
    if (!next.selector || next.confidence < NEXT_CONTROL_THRESHOLD) {
      return {
        advanced: false,
        detail: next.selector
          ? `model suggested "${next.text}" to continue but was only ${Math.round(next.confidence * 100)}% sure`
          : `model found nothing that continues this form: ${next.reasoning}`,
      }
    }

    if (next.submits) {
      return {
        advanced: false,
        detail: `model says "${next.text}" would submit rather than continue; leaving that to the gate`,
      }
    }

    const res = await callAgent<Extract<FormResponse, { type: 'form:click' }>>(tab, {
      type: 'form:click',
      selector: next.selector,
    })
    if (!res.clicked) return { advanced: false, detail: `could not click "${next.text}": ${res.detail}` }

    // Clicking is not advancing. The page has to actually change, and a wizard
    // that refuses validation looks identical to one that moved unless asked.
    await sleep(1500)
    const after = await outlineOf(tab)
    const moved = !after || after.url !== outline.url || after.headings.join('|') !== outline.headings.join('|')

    await applicationsRepo.addTimeline(
      applicationId,
      'wizard',
      moved
        ? `model advanced the form with "${next.text}": ${next.reasoning}`
        : `model clicked "${next.text}" but the form did not move`,
      moved ? 'info' : 'warn'
    )
    return { advanced: moved, detail: moved ? `model chose "${next.text}"` : 'the form did not move' }
  } catch (e) {
    return { advanced: false, detail: `model could not read the form: ${errorMessage(e)}` }
  }
}

/** Persist a selector the model found and that then worked. */
async function rememberApplySelector(url: string, selector: string, text: string): Promise<void> {
  await learnApplyEntry(url, selector, text).catch(() => {})
}

/* ------------------------------------------------------------- the machine */

export async function applyToJob(jobId: string, options: ApplyOptions = {}): Promise<ApplyOutcome> {
  const step = (name: string, detail = '') => {
    options.onStep?.(name, detail)
    activity.note(detail ? `${name} - ${detail}` : name)
    log.debug(`step: ${name}${detail ? ` (${detail})` : ''}`, undefined, jobId)
  }

  const [settings, profile] = await Promise.all([getSettings(), getProfile()])
  let job = await jobsRepo.get(jobId)
  if (!job) throw new Error(`Job ${jobId} not found`)

  const application = await ensureApplication(job)
  await applicationsRepo.update(application.id, { status: 'running', attempts: application.attempts + 1 })
  await applicationsRepo.addTimeline(application.id, 'start', job.applyUrl || job.url)

  let tab: WorkerTab | null = null

  try {
    const targetUrl = job.applyUrl || job.url
    if (!targetUrl) throw new Error('Job has no application URL')

    step('open', targetUrl)
    tab = await openTab(targetUrl)
    await waitForLoad(tab.tabId)
    await ensureAgent(tab.tabId)
    tab.frameId = await pickFormFrame(tab.tabId)

    // --- detect, and enter the form if it is behind an apply button ---------
    step('detect')
    let detect = (await callAgent<Extract<FormResponse, { type: 'form:detect' }>>(tab, { type: 'form:detect' }))
      .result
    const vendor = detect.vendor || vendorForUrl(targetUrl)
    const adapter = adapterById(vendor)

    // Both only matter on a site where the entry button submits outright, but
    // they are read after the block that sets them.
    let entryClicked = false
    let oneClickDecision: GateDecision | null = null

    if (!detect.isApplicationForm) {
      step('enter form')
      // The record may carry only a card snippet (volume mode skips hydration).
      // Backfill from the live advert before answering anything: the prompts
      // downstream all read this job object, and a one-line description makes
      // every screening answer generic.
      try {
        const advert = await readAdvertDetails(tab.tabId)
        if (advert.description.length > job.descriptionText.length) {
          job = { ...job, descriptionText: advert.description, descriptionSource: 'apply_page' }
          await jobsRepo.update(job.id, {
            descriptionText: advert.description,
            descriptionSource: 'apply_page',
          })
        }
        if (advert.easyApply && !job.easyApply) {
          job = { ...job, easyApply: true }
          await jobsRepo.update(job.id, { easyApply: true })
        }
        if (advert.applyHref) {
          try {
            if (!/indeed\.com/.test(new URL(advert.applyHref, job.url).hostname)) {
              job = { ...job, applyUrl: advert.applyHref }
              await jobsRepo.update(job.id, { applyUrl: advert.applyHref })
            }
          } catch {
            // An href we cannot parse is not worth failing the application over.
          }
        }
      } catch {
        // Best effort: the advert is still drivable without the backfill.
      }
      // On a one-click site the entry button IS the application. The gate
      // normally runs after filling, which would be far too late: dry run would
      // have already sent it. Ask first, and do not touch the button unless the
      // answer is yes.
      if (detect.entrySubmitsImmediately) {
        const autonomyNow = options.forceDryRun
          ? { ...settings.autonomy, mode: 'dry_run' as const }
          : settings.autonomy
        oneClickDecision = evaluateGate({
          autonomy: autonomyNow,
          ignoreActiveHours: options.ignoreActiveHours,
          matchScore: job.matchScore,
          // There is no form to fill, so there is nothing to be unsure about;
          // the risk here is the decision to apply at all, not the answers.
          fillConfidence: 1,
          plan: [],
          unresolved: [],
          vendor,
          vendorEnabled: settings.enabledSites[vendor] ?? false,
          reachedFinalStep: true,
          appliedToday: await getCounter(dailyCounterKey()),
          appliedTodayOnVendor: await getCounter(dailyCounterKey(vendor)),
          now: new Date(),
        })

        if (oneClickDecision.action !== 'submit') {
          const why = oneClickDecision.reasons.join('; ') || 'autonomy settings'
          await applicationsRepo.addTimeline(
            application.id,
            'gate',
            `not clicking apply: on ${adapter.label} that button submits immediately, and ${why}`,
            'warn'
          )
          const parked = await applicationsRepo.update(application.id, {
            status: oneClickDecision.action === 'skip' ? 'skipped' : 'needs_review',
            vendor,
            error: `one-click apply held back: ${why}`,
          })
          await jobsRepo.update(job.id, {
            status: oneClickDecision.action === 'skip' ? 'skipped' : 'queued',
            rejectReason: oneClickDecision.action === 'skip' ? why : '',
          })
          return { application: parked!, decision: oneClickDecision, submitted: false }
        }
      }

      const tabsBefore = await openTabIds()

      // What was learned here last time, first. A selector the model found and
      // that then worked is both cheaper and more specific than the adapter's
      // generic list, and trying it first is what stops the fallback from
      // becoming a permanent per-application cost on the same site.
      const remembered = await rememberedApplyEntry(targetUrl).catch(() => '')
      let clicked = false
      if (remembered) {
        const res = await callAgent<Extract<FormResponse, { type: 'form:click' }>>(tab, {
          type: 'form:click',
          selector: remembered,
        }).catch(() => ({ clicked: false, detail: 'agent did not answer' }))
        clicked = res.clicked
        if (clicked) {
          step('enter form', `used the apply control learned here earlier`)
          await learnApplyEntry(targetUrl, remembered, '').catch(() => {})
        } else {
          // Sites change. A remembered selector that stops working has to be
          // able to age out, or one bad memory becomes a permanent outage.
          await missApplyEntry(targetUrl).catch(() => {})
        }
      }

      if (!clicked) clicked = await clickApplyEntry(tab.tabId, adapter.applyEntrySelectors ?? [])

      // The adapter's selectors missed. That is the normal state of affairs on
      // a site nobody has written an adapter for, and an increasingly common
      // one on sites that have one, because markup rotates. Rather than skip a
      // job that a person looking at the page could apply to in one click, ask
      // the model to read the page and point at the control.
      if (!clicked) {
        const fallback = await applyControlFromModel(tab, job, application.id)
        if (fallback.selector) {
          const res = await callAgent<Extract<FormResponse, { type: 'form:click' }>>(tab, {
            type: 'form:click',
            selector: fallback.selector,
          })
          clicked = res.clicked
          if (clicked) {
            step('enter form', `model found the apply control: "${fallback.text}"`)
            // Worth remembering. The next job at this company costs no model
            // call at all, which is the difference between a fallback and a
            // second permanent cost.
            await rememberApplySelector(targetUrl, fallback.selector, fallback.text)
          }
        }
      }

      entryClicked = clicked
      if (clicked) {
        await sleep(2500)
        const movedTab = await adoptNewTab(tabsBefore, tab, 8000)
        if (movedTab) step('follow', 'the application opened in a new tab')
        // Whether it navigated or opened elsewhere, the form is still arriving.
        await waitForLoad(tab.tabId).catch(() => {})
        await ensureAgent(tab.tabId)
        // The form may have appeared in a frame that did not exist before.
        tab.frameId = await pickFormFrame(tab.tabId)
        detect = (await callAgent<Extract<FormResponse, { type: 'form:detect' }>>(tab, { type: 'form:detect' }))
          .result
      }
    }

    // A one-click site that shows no form after the click has not failed -- it
    // has finished. Checking the page for its own confirmation is the only way
    // to tell that from a misfire, and skipping without looking is how a real
    // submission got recorded as "no application form found".
    if (!detect.isApplicationForm && oneClickDecision && entryClicked) {
      step('verify')
      const oneClick = await verifySubmission(tab)
      await applicationsRepo.addTimeline(
        application.id,
        'verify',
        `one-click apply: ${oneClick.signal}: ${oneClick.detail}`,
        oneClick.submitted ? 'info' : 'warn'
      )

      if (oneClick.submitted) {
        await bumpCounter(dailyCounterKey())
        await bumpCounter(dailyCounterKey(vendor))
        await jobsRepo.update(job.id, { status: 'applied' })
        const updated = await applicationsRepo.update(application.id, {
          status: 'submitted',
          vendor,
          submittedAt: Date.now(),
          error: '',
        })
        log.info(`Submitted (one click): ${job.title} at ${job.company}`, {}, job.id)
        if (settings.autonomy.notifyOnSubmit) {
          notify('Application submitted', `${job.title} at ${job.company}`)
        }
        return {
          application: updated!,
          decision: oneClickDecision ?? { action: 'submit', reasons: ['one-click apply'] },
          submitted: true,
        }
      }

      // Clicked, no form, no confirmation. It may have landed and said so in
      // wording we do not recognise, so this is a human's call, not a skip.
      const unsure = await applicationsRepo.update(application.id, {
        status: 'needs_review',
        vendor,
        error: `clicked apply on ${adapter.label} but saw no confirmation - ${oneClick.detail}`,
      })
      return {
        application: unsure!,
        decision: { action: 'review', reasons: ['one-click apply was not confirmed'] },
        submitted: false,
      }
    }

    if (!detect.isApplicationForm) {
      const reason = detect.detail || 'no application form found on this page'
      // Keep what the page looked like. "No application form found" is true and
      // useless on its own: without the controls that WERE on screen there is
      // no way to tell a stale selector from an expired listing from a login
      // wall, and a job that only appears once cannot be re-examined by hand.
      await recordEvidence({
        jobId: job.id,
        applicationId: application.id,
        stage: 'detect',
        reason,
        outline: await outlineOf(tab),
      })
      await finishAsSkipped(application.id, reason)
      await jobsRepo.update(job.id, { status: 'skipped', rejectReason: reason })
      return {
        application: (await applicationsRepo.get(application.id))!,
        decision: { action: 'skip', reasons: [reason] },
        submitted: false,
      }
    }

    await applicationsRepo.update(application.id, { vendor })

    // --- documents ---------------------------------------------------------
    // Generated once, before the step loop, so a wizard that asks for the
    // resume on page three does not pay for a second tailoring pass.
    step('harvest')
    let harvest = await harvestStep(tab)
    const needsResume = harvest.fields.some((f) => f.kind === 'file')
    const needsCover =
      settings.documents.generateCoverLetter &&
      harvest.fields.some((f) => /cover letter/i.test(f.label) || f.kind === 'file')

    let docs = { resumeDocId: '', coverDocId: '', coverLetterText: '' }

    /**
     * Generate the resume and cover letter, once, the first time a page asks.
     *
     * This used to run only if the *first* page carried a file input, which on
     * a wizard is usually the one page that does not: Indeed asks for the
     * resume on step two, and plenty of company forms on step three. No
     * document was ever generated, nothing was attached, and the form then
     * refused to advance past its own required upload -- a fully answered
     * application abandoned one click from the end.
     */
    const ensureDocs = async (wantResume: boolean, wantCover: boolean): Promise<void> => {
      if (!wantResume && !wantCover) return
      if ((!wantResume || docs.resumeDocId) && (!wantCover || docs.coverDocId)) return
      step('documents')
      // `job` is reassigned when the advert is backfilled, so re-read it here
      // rather than relying on the narrowing from the top of the function.
      const forJob = job
      if (!forJob) throw new Error('Job record vanished mid-application')
      const generated = await generateDocuments(profile, forJob, settings, {
        needResume: wantResume,
        needCoverLetter: wantCover,
      })
      docs = {
        resumeDocId: generated.resumeDocId || docs.resumeDocId,
        coverDocId: generated.coverDocId || docs.coverDocId,
        coverLetterText: generated.coverLetterText || docs.coverLetterText,
      }
      await applicationsRepo.update(application.id, { docs })
      if (generated.fabricationReport && !generated.fabricationReport.clean) {
        await applicationsRepo.addTimeline(
          application.id,
          'tailoring',
          `${generated.fabricationReport.rejectedBullets.length} bullet(s) rejected as fabricated`,
          'warn'
        )
      }
    }

    await ensureDocs(needsResume, needsCover)

    // --- fill, one page at a time -----------------------------------------
    const allPlan: FilledField[] = []
    const allUnresolved: FieldDescriptor[] = []
    let confidence = 1
    let stepIndex = 0
    const seenSignatures = new Set<string>()

    while (stepIndex < MAX_WIZARD_STEPS) {
      if (options.shouldStop?.()) throw new Error('Run stopped by request')

      const signature = harvest.fields.map((f) => f.selector).join('|')
      if (signature && seenSignatures.has(signature)) {
        // The wizard did not actually move; stop rather than loop.
        await applicationsRepo.addTimeline(application.id, 'wizard', 'step did not change; stopping', 'warn')
        break
      }
      seenSignatures.add(signature)

      step('resolve', `${harvest.fields.length} field(s)`)
      const resolved = await resolveFields({
        fields: harvest.fields,
        profile,
        job,
        vendor,
        settings,
        url: targetUrl,
        coverLetterText: docs.coverLetterText,
      })

      allPlan.push(...resolved.plan)
      allUnresolved.push(...resolved.unresolved)
      confidence = Math.min(confidence, resolved.confidence)

      if (resolved.plan.length > 0) {
        step('filling the form', `${resolved.plan.length} field(s), typed one at a time`)
        const fill = (
          await callAgent<Extract<FormResponse, { type: 'form:fill' }>>(tab, {
            type: 'form:fill',
            plan: resolved.plan,
            pacing: settings.autonomy.delayBetweenFieldsMs,
          })
        ).result
        recordFillOutcome(allPlan, fill)
        if (fill.failed.length > 0) {
          await applicationsRepo.addTimeline(
            application.id,
            'fill',
            `${fill.failed.length} field(s) did not accept a value`,
            'warn'
          )
        }
      }

      // --- attach documents on whichever page asks for them -----------------
      // Whatever this page asks for, produce it now if it does not exist yet.
      if (resolved.documentTargets.length > 0) {
        await ensureDocs(
          resolved.documentTargets.some((t) => t.key !== 'coverLetter'),
          resolved.documentTargets.some((t) => t.key === 'coverLetter') && settings.documents.generateCoverLetter
        )
      }

      for (const target of resolved.documentTargets) {
        const docId = target.key === 'coverLetter' ? docs.coverDocId : docs.resumeDocId
        if (!docId) continue
        const stored = await docsRepo.get(docId)
        if (!stored) continue
        step('attach', stored.meta.fileName)
        const dataUrl = await blobToDataUrl(stored.blob)
        const res = await callAgent<Extract<FormResponse, { type: 'form:uploadFile' }>>(tab, {
          type: 'form:uploadFile',
          selector: target.selector,
          fileName: stored.meta.fileName,
          mimeType: stored.meta.mimeType,
          dataUrl,
        })
        await applicationsRepo.addTimeline(
          application.id,
          'attach',
          `${stored.meta.fileName}: ${res.detail}`,
          res.success ? 'info' : 'warn'
        )
        await sleep(900)
      }

      // --- stop here if this page is the one that submits -------------------
      //
      // Reaching the final screen is the goal, not something to advance past.
      // Without this the loop kept pressing on, and on a wizard whose last
      // control is the submit button that is how an application gets sent by
      // accident -- or, more often, how the loop exits somewhere in the middle
      // and calls submit on a page that rightly refuses.
      if (detect.readyToSubmit) {
        await applicationsRepo.addTimeline(application.id, 'wizard', `reached the final step: ${detect.detail}`)
        break
      }

      // --- an unanswered mandatory question ---------------------------------
      //
      // This used to break outright, which on Indeed's five-step wizard meant
      // bailing out in the middle and then trying to submit from there -- the
      // adapter refused, correctly, and nothing was ever sent. The site itself
      // is the better authority: try to advance, and let its own validation
      // decide. `advanceStep` reports honestly whether the page actually moved,
      // and `canSubmit` guarantees that pressing continue cannot submit, so
      // attempting it risks nothing.
      const requiredStillBlank = resolved.unresolved.filter((f) => f.required)
      if (requiredStillBlank.length > 0 && settings.autonomy.requireAllRequiredFields) {
        await applicationsRepo.addTimeline(
          application.id,
          'wizard',
          `${requiredStillBlank.length} mandatory question(s) unanswered (${requiredStillBlank
            .slice(0, 3)
            .map((f) => f.label || f.selector)
            .join(', ')}); letting the site decide`,
          'warn'
        )
      }

      // --- stop early on questions nobody may answer -------------------------
      //
      // A mandatory work-authorization, sponsorship or credential question that
      // survived every tier will still be unanswered on the last page -- the
      // gate parks it there whatever happens in between. Advancing through the
      // remaining pages first only burns model calls and minutes to arrive at
      // the same verdict, so name it now and go straight to the gate.
      const offLimitsRequired = resolved.unresolved.filter((f) => f.required && isOffLimitsQuestion(f))
      if (offLimitsRequired.length > 0) {
        await applicationsRepo.addTimeline(
          application.id,
          'wizard',
          `stopping early: ${offLimitsRequired.length} mandatory question(s) cannot be answered honestly (${offLimitsRequired
            .slice(0, 3)
            .map((f) => f.label || f.selector)
            .join(', ')}); parking for review`,
          'warn'
        )
        break
      }

      // --- advance a wizard, or stop ---------------------------------------
      if (!detect.multiStep) break
      let advance = await callAgent<Extract<FormResponse, { type: 'form:advanceStep' }>>(tab, {
        type: 'form:advanceStep',
      })

      // The wizard is where selector lists fail worst: Naukri drives its whole
      // application through a chat drawer, Indeed relabels one button at every
      // step. When the page did not move, ask the model which control does --
      // stopping here means an application that is fully filled in and never
      // sent, which is the worst outcome available.
      if (!advance.advanced) {
        const moved = await advanceViaModel(tab, application.id, resolved.plan.length)
        if (moved.advanced) advance = { ...advance, advanced: true, detail: moved.detail }
        else if (moved.detail) {
          await applicationsRepo.addTimeline(application.id, 'wizard', moved.detail, 'warn')
        }
      }

      if (!advance.advanced) {
        await applicationsRepo.addTimeline(
          application.id,
          'wizard',
          `stopped: ${advance.detail}`,
          'warn'
        )
        break
      }

      await applicationsRepo.addTimeline(application.id, 'wizard', `advanced: ${advance.detail}`)
      await pause({ min: 1200, max: 2600 })
      await ensureAgent(tab.tabId)
      tab.frameId = await pickFormFrame(tab.tabId)

      // Re-read the page rather than reusing the first step's verdict. The
      // stale copy is what left the loop blind to arriving at the review
      // screen, and to the form ending early.
      detect = (await callAgent<Extract<FormResponse, { type: 'form:detect' }>>(tab, { type: 'form:detect' })).result
      harvest = await harvestStep(tab)
      stepIndex++
    }

    // --- refuse to submit a form we never filled ---------------------------
    //
    // A page with no fillable fields is not an application, whatever the
    // adapter thought. Clicking its apply button would send an empty
    // application or, worse, something the site fills in on its own.
    if (allPlan.length === 0 && allUnresolved.length === 0) {
      const reason =
        'No form fields found on this page. It is probably a job advert rather than an application form, ' +
        'or the real form is behind a login.'
      await finishAsSkipped(application.id, reason)
      await jobsRepo.update(job.id, { status: 'skipped', rejectReason: reason })
      log.warn(`${job.company}: ${reason}`, undefined, job.id)
      return {
        application: (await applicationsRepo.get(application.id))!,
        decision: { action: 'skip', reasons: [reason] },
        submitted: false,
      }
    }

    // --- gate --------------------------------------------------------------
    const autonomy = options.forceDryRun
      ? { ...settings.autonomy, mode: 'dry_run' as const }
      : settings.autonomy

    const decision = evaluateGate({
      autonomy,
      ignoreActiveHours: options.ignoreActiveHours,
      matchScore: job.matchScore,
      fillConfidence: confidence,
      plan: allPlan,
      unresolved: allUnresolved,
      vendor,
      vendorEnabled: settings.enabledSites[vendor] ?? false,
      reachedFinalStep: detect.readyToSubmit,
      appliedToday: await getCounter(dailyCounterKey()),
      appliedTodayOnVendor: await getCounter(dailyCounterKey(vendor)),
      now: new Date(),
    })

    await applicationsRepo.update(application.id, {
      fillPlan: allPlan,
      unresolved: allUnresolved,
      confidence,
      matchScore: job.matchScore,
      vendor,
    })

    if (decision.action !== 'submit') {
      step('park', decision.reasons.join('; '))
      if (allUnresolved.length > 0) {
        await callAgent(tab, { type: 'form:highlight', selectors: allUnresolved.map((f) => f.selector) }).catch(
          () => {}
        )
      }
      const status = autonomy.mode === 'dry_run' ? 'dry_run' : 'needs_review'
      const updated = await applicationsRepo.update(application.id, { status })
      await applicationsRepo.addTimeline(application.id, 'gate', decision.reasons.join('; '), 'warn')
      log.info(explainDecision(updated ?? application, decision), undefined, job.id)
      await jobsRepo.update(job.id, { status: 'queued' })
      return { application: updated!, decision, submitted: false }
    }

    // --- submit ------------------------------------------------------------
    step('submit')
    const submit = (
      await callAgent<Extract<FormResponse, { type: 'form:submit' }>>(tab, { type: 'form:submit' })
    ).result
    await applicationsRepo.addTimeline(application.id, 'submit', `${submit.selector} ${submit.detail}`)

    if (!submit.clicked) {
      const updated = await applicationsRepo.update(application.id, {
        status: 'needs_review',
        error: 'no submit control found',
      })
      return { application: updated!, decision: { action: 'review', reasons: ['no submit control found'] }, submitted: false }
    }

    // --- verify -------------------------------------------------------------
    step('verify')
    const verdict = await verifySubmission(tab)
    await applicationsRepo.addTimeline(
      application.id,
      'verify',
      `${verdict.signal}: ${verdict.detail}`,
      verdict.submitted ? 'info' : 'warn'
    )

    if (verdict.submitted) {
      await bumpCounter(dailyCounterKey())
      await bumpCounter(dailyCounterKey(vendor))
      await jobsRepo.update(job.id, { status: 'applied' })
      await learnFromPlan(allPlan, vendor)
      const updated = await applicationsRepo.update(application.id, {
        status: 'submitted',
        submittedAt: Date.now(),
        error: '',
      })
      log.info(`Submitted: ${job.title} at ${job.company}`, { confidence }, job.id)
      if (settings.autonomy.notifyOnSubmit) notify('Application submitted', `${job.title} at ${job.company}`)
      return { application: updated!, decision, submitted: true }
    }

    // Clicked but not confirmed: almost always a validation error. Park it with
    // the page's own complaint attached rather than retrying blindly, and keep
    // the page itself -- this is the failure a user most often has to judge by
    // hand, and the reason string alone never says enough to judge it.
    await recordEvidence({
      jobId: job.id,
      applicationId: application.id,
      stage: 'verify',
      reason: `submitted but not confirmed - ${verdict.detail}`,
      outline: await outlineOf(tab),
    })
    const updated = await applicationsRepo.update(application.id, {
      status: 'needs_review',
      error: `submitted but not confirmed - ${verdict.detail}`,
    })
    if (settings.autonomy.notifyOnReviewNeeded) {
      notify('Application needs review', `${job.title} at ${job.company}: ${verdict.signal}`)
    }
    return {
      application: updated!,
      decision: { action: 'review', reasons: [`submission unconfirmed: ${verdict.signal}`] },
      submitted: false,
    }
  } catch (e) {
    const message = errorMessage(e)
    log.error(`Application failed: ${message}`, undefined, jobId)
    await applicationsRepo.addTimeline(application.id, 'error', message, 'error')

    // A missing host permission is not this job's fault and will not be any
    // different on the next one -- it would fail the whole queue identically.
    // Leave the job queued so it runs for real once access is granted, and let
    // it reach the orchestrator, which stops the run instead of grinding
    // through a hundred jobs producing the same error.
    // Whatever went wrong, keep the page. This is the catch that produced the
    // unreadable one-line failures the user spent a night guessing at.
    if (tab) {
      await recordEvidence({
        jobId,
        applicationId: application.id,
        stage: 'apply',
        reason: message,
        outline: await outlineOf(tab),
      })
    }

    if (e instanceof PermissionError) {
      await applicationsRepo.update(application.id, { status: 'queued', error: message })
      await jobsRepo.update(jobId, { status: 'queued' })
      throw e
    }

    const updated = await applicationsRepo.update(application.id, { status: 'failed', error: message })
    await jobsRepo.update(jobId, { status: 'failed' })
    return {
      application: updated ?? application,
      decision: { action: 'skip', reasons: [message] },
      submitted: false,
    }
  } finally {
    await closeTab(tab)
  }
}

/* -------------------------------------------------------------- approval */

/**
 * Replay an approved application.
 *
 * The plan was already computed; re-opening the page and replaying it is much
 * cheaper and more predictable than resolving from scratch, and it means the
 * user's inline edits in the review queue are exactly what gets submitted.
 */
export async function submitApprovedApplication(
  applicationId: string,
  edits?: FilledField[]
): Promise<ApplyOutcome> {
  const application = await applicationsRepo.get(applicationId)
  if (!application) throw new Error(`Application ${applicationId} not found`)
  const job = await jobsRepo.get(application.jobId)
  if (!job) throw new Error(`Job ${application.jobId} not found`)

  const settings = await getSettings()
  const plan = mergeEdits(application.fillPlan, edits)

  // Approving an empty plan would click submit on a form nothing was typed
  // into. Refuse rather than send a blank application in the user's name.
  if (plan.length === 0) {
    const reason = 'Nothing was filled in, so there is nothing to submit. This page had no application form.'
    await applicationsRepo.update(applicationId, { status: 'skipped', error: reason })
    return { application: (await applicationsRepo.get(applicationId))!, decision: { action: 'skip', reasons: [reason] }, submitted: false }
  }

  let tab: WorkerTab | null = null

  try {
    await applicationsRepo.update(applicationId, { status: 'running', fillPlan: plan })
    tab = await openTab(application.url || job.applyUrl || job.url)
    await waitForLoad(tab.tabId)
    await ensureAgent(tab.tabId)
    tab.frameId = await pickFormFrame(tab.tabId)

    const fill = (
      await callAgent<Extract<FormResponse, { type: 'form:fill' }>>(tab, {
        type: 'form:fill',
        plan,
        pacing: settings.autonomy.delayBetweenFieldsMs,
      })
    ).result
    recordFillOutcome(plan, fill)

    // Re-attach documents: a fresh page load has an empty file input.
    for (const [docId, kind] of [
      [application.docs.resumeDocId, 'resume'],
      [application.docs.coverDocId, 'coverLetter'],
    ] as const) {
      if (!docId) continue
      const stored = await docsRepo.get(docId)
      if (!stored) continue
      const harvest = await harvestStep(tab)
      const target = harvest.fields.find(
        (f) => f.kind === 'file' && (kind === 'resume' ? !/cover/i.test(f.label) : /cover/i.test(f.label))
      )
      if (!target) continue
      await callAgent(tab, {
        type: 'form:uploadFile',
        selector: target.selector,
        fileName: stored.meta.fileName,
        mimeType: stored.meta.mimeType,
        dataUrl: await blobToDataUrl(stored.blob),
      })
      await sleep(800)
    }

    const submit = (
      await callAgent<Extract<FormResponse, { type: 'form:submit' }>>(tab, { type: 'form:submit' })
    ).result
    if (!submit.clicked) throw new Error('No submit control found on the page')

    const verdict = await verifySubmission(tab)
    await applicationsRepo.addTimeline(applicationId, 'verify', `${verdict.signal}: ${verdict.detail}`)

    if (verdict.submitted) {
      await bumpCounter(dailyCounterKey())
      await bumpCounter(dailyCounterKey(application.vendor))
      await jobsRepo.update(job.id, { status: 'applied' })
      await learnFromPlan(plan, application.vendor)
      const updated = await applicationsRepo.update(applicationId, {
        status: 'submitted',
        submittedAt: Date.now(),
        error: '',
      })
      notify('Application submitted', `${job.title} at ${job.company}`)
      return { application: updated!, decision: { action: 'submit', reasons: ['approved by user'] }, submitted: true }
    }

    const updated = await applicationsRepo.update(applicationId, {
      status: 'needs_review',
      error: `submitted but not confirmed - ${verdict.detail}`,
    })
    return {
      application: updated!,
      decision: { action: 'review', reasons: [verdict.detail] },
      submitted: false,
    }
  } catch (e) {
    const message = errorMessage(e)
    const updated = await applicationsRepo.update(applicationId, { status: 'failed', error: message })
    return { application: updated ?? application, decision: { action: 'skip', reasons: [message] }, submitted: false }
  } finally {
    await closeTab(tab)
  }
}

/* ---------------------------------------------------------------- helpers */

async function harvestStep(tab: WorkerTab): Promise<{ fields: FieldDescriptor[]; multiStep: boolean }> {
  const res = await withTimeout(
    callAgent<Extract<FormResponse, { type: 'form:harvest' }>>(tab, { type: 'form:harvest' }),
    20000,
    'harvest'
  )
  return { fields: res.fields, multiStep: res.multiStep }
}

async function verifySubmission(tab: WorkerTab): Promise<FormVerifyResult> {
  const bySelectors = await verifyBySelectors(tab)

  // A confident answer either way is the end of it. Only `no_signal` -- the
  // adapter looked and could not tell -- is worth a model call, and that is the
  // common case: every ATS words its confirmation differently, and a list of
  // regexes only ever covers the ones somebody has already seen. Treating "I
  // could not tell" as "it failed" is what sent real submissions to the review
  // queue and left the user to re-check them by hand.
  if (bySelectors.submitted || bySelectors.signal === 'validation_error') return bySelectors

  const outline = await outlineOf(tab)
  if (!outline) return bySelectors

  try {
    const reading = await readSubmissionState(outline)
    if (reading.submitted) {
      return {
        submitted: true,
        signal: 'model_confirmed',
        detail: `model read the page as submitted (${Math.round(reading.confidence * 100)}%): ${reading.evidence}`,
      }
    }
    if (reading.state === 'rejected') {
      return {
        submitted: false,
        signal: 'validation_error',
        detail: `model read a rejection: ${reading.evidence || 'no wording given'}`,
      }
    }
    return {
      submitted: false,
      signal: bySelectors.signal,
      detail: `${bySelectors.detail}; model said ${reading.state} (${Math.round(reading.confidence * 100)}%)${reading.evidence ? `: ${reading.evidence}` : ''}`,
    }
  } catch (e) {
    // The model being unavailable must not turn an unknown into a failure.
    return { ...bySelectors, detail: `${bySelectors.detail}; model check failed: ${errorMessage(e)}` }
  }
}

/** The fast path: the adapter's own confirmation elements and phrases. */
async function verifyBySelectors(tab: WorkerTab): Promise<FormVerifyResult> {
  // Confirmation can be a navigation or an in-place re-render, so poll rather
  // than checking once; a slow redirect otherwise reads as a failed submit.
  // Generous, because this is the one wait that must not be cut short. Indeed
  // renders its confirmation after a round-trip that can take a while on a
  // throttled background window, and closing the tab first loses the proof that
  // the application landed -- which reads, wrongly, as a failed submission.
  const deadline = Date.now() + 45000
  let last: FormVerifyResult = { submitted: false, signal: 'no_signal', detail: 'not checked' }

  while (Date.now() < deadline) {
    await sleep(1500)
    try {
      await ensureAgent(tab.tabId)
      const res = await callAgent<Extract<FormResponse, { type: 'form:verifySubmission' }>>(tab, {
        type: 'form:verifySubmission',
      })
      last = res.result
      if (last.submitted) return last
      if (last.signal === 'validation_error') return last
    } catch {
      // A navigation in flight breaks messaging briefly; keep polling.
    }
  }
  return last
}

function recordFillOutcome(plan: FilledField[], outcome: FormFillResult): void {
  const bySelector = new Map<string, FilledField>()
  for (const f of [...outcome.filled, ...outcome.failed]) bySelector.set(f.selector, f)
  for (const field of plan) {
    const result = bySelector.get(field.selector)
    if (!result) continue
    field.verified = result.verified
    field.error = result.error
  }
}

function mergeEdits(plan: FilledField[], edits?: FilledField[]): FilledField[] {
  if (!edits || edits.length === 0) return plan
  const bySelector = new Map(edits.map((e) => [e.selector, e]))
  const merged = plan.map((f) => {
    const edit = bySelector.get(f.selector)
    if (!edit) return f
    bySelector.delete(f.selector)
    return { ...f, value: edit.value, source: 'user' as const, confidence: 1, reasoning: 'edited by user' }
  })
  // Edits for fields that were parked rather than planned get appended.
  return [...merged, ...bySelector.values()]
}

/**
 * Write successful answers back to the bank.
 *
 * Only fields that actually took their value are learned, and only from
 * submitted applications -- learning from a form that rejected us would teach
 * the agent its own mistakes.
 */
async function learnFromPlan(plan: FilledField[], vendor: string): Promise<void> {
  for (const field of plan) {
    if (!field.verified || !field.value.trim()) continue
    if (field.source === 'profile' || field.source === 'adapter') continue
    if (field.kind === 'textarea' && field.value.length > 400) continue // bespoke essays
    await remember({
      label: field.label,
      value: field.value,
      kind: field.kind,
      source: field.source === 'user' ? 'user' : 'llm',
      scope: field.source === 'user' ? '' : vendor,
    })
  }
}

async function ensureApplication(job: Job): Promise<Application> {
  const existing = await applicationsRepo.byJob(job.id)
  if (existing) return existing
  const application: Application = {
    id: uid('app'),
    jobId: job.id,
    company: job.company,
    title: job.title,
    url: job.applyUrl || job.url,
    vendor: job.vendor,
    status: 'queued',
    fillPlan: [],
    unresolved: [],
    confidence: 0,
    matchScore: job.matchScore,
    docs: { resumeDocId: '', coverDocId: '', coverLetterText: '' },
    timeline: [],
    attempts: 0,
    error: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    submittedAt: null,
  }
  await applicationsRepo.put(application)
  return application
}

async function finishAsSkipped(applicationId: string, reason: string): Promise<void> {
  await applicationsRepo.update(applicationId, { status: 'skipped', error: reason })
  await applicationsRepo.addTimeline(applicationId, 'skip', reason, 'warn')
}

function notify(title: string, message: string): void {
  try {
    chrome.notifications?.create({ type: 'basic', iconUrl: 'icons/128.png', title, message, silent: true })
  } catch {
    // Notifications are a courtesy, never a reason to fail a run.
  }
}

/** Fill a single URL without a Job record. Powers "try this page" in the UI. */
/**
 * Walk one job page without touching it.
 *
 * The self-test's eyes. It does everything a real application does up to the
 * first keystroke -- open the page, get the agent in, detect, find the form,
 * harvest the fields, work out the answers -- and then stops. Nothing is
 * typed, nothing is clicked, nothing is submitted.
 *
 * This is the only kind of test that could have caught any of the failures that
 * actually happened: a host permission Chrome never granted, a content script
 * that could not be injected, an adapter whose selectors had rotated. None of
 * those are visible to a unit test, because none of them are about logic.
 */
export type PageProbe = {
  url: string
  ok: boolean
  /** Where it got to: 'open' | 'agent' | 'detect' | 'harvest' | 'resolve'. */
  reached: string
  vendor: string
  isApplicationForm: boolean
  multiStep: boolean
  fields: number
  resolved: number
  unresolved: number
  /** How the adapter's own selectors fared, before any model fallback. */
  applyEntryFound: boolean
  confidence: number
  error: string
  elapsedMs: number
  /** Present when something failed: what was actually on the page. */
  outline: PageOutline | null
}

export async function probeJobPage(url: string, options: { timeoutMs?: number } = {}): Promise<PageProbe> {
  const startedAt = Date.now()
  const result: PageProbe = {
    url,
    ok: false,
    reached: 'open',
    vendor: '',
    isApplicationForm: false,
    multiStep: false,
    fields: 0,
    resolved: 0,
    unresolved: 0,
    applyEntryFound: false,
    confidence: 0,
    error: '',
    elapsedMs: 0,
    outline: null,
  }

  const [settings, profile] = await Promise.all([getSettings(), getProfile()])
  let tab: WorkerTab | null = null

  try {
    tab = await withTimeout(openTab(url), options.timeoutMs ?? 40000, `opening ${url}`)
    await waitForLoad(tab.tabId)

    result.reached = 'agent'
    await ensureAgent(tab.tabId)

    result.reached = 'detect'
    tab.frameId = await pickFormFrame(tab.tabId)
    const detect = (await callAgent<Extract<FormResponse, { type: 'form:detect' }>>(tab, { type: 'form:detect' }))
      .result
    result.vendor = detect.vendor || vendorForUrl(url)
    result.isApplicationForm = detect.isApplicationForm
    result.multiStep = detect.multiStep

    // Does the adapter still recognise its own apply button? Asked without
    // clicking: this is the single most common thing to rot, and knowing it has
    // rotted is worth more than any number of passing unit tests.
    const adapter = adapterById(result.vendor)
    result.applyEntryFound = await hasApplyEntry(tab.tabId, adapter.applyEntrySelectors ?? [])

    result.reached = 'harvest'
    const harvest = await harvestStep(tab)
    result.fields = harvest.fields.length

    if (harvest.fields.length > 0) {
      result.reached = 'resolve'
      const resolved = await resolveFields({
        fields: harvest.fields,
        profile,
        job: null,
        vendor: result.vendor,
        settings,
        url,
      })
      result.resolved = resolved.plan.length
      result.unresolved = resolved.unresolved.length
      result.confidence = resolved.confidence
    }

    result.ok = detect.isApplicationForm || result.applyEntryFound || harvest.fields.length > 0
    if (!result.ok) result.outline = await outlineOf(tab)
    return result
  } catch (e) {
    result.error = errorMessage(e)
    if (tab) result.outline = await outlineOf(tab)
    return result
  } finally {
    result.elapsedMs = Date.now() - startedAt
    await closeTab(tab)
  }
}

/** Would the adapter's apply selectors match, without clicking anything? */
async function hasApplyEntry(tabId: number, selectors: string[]): Promise<boolean> {
  if (selectors.length === 0) return false
  const [found] = await chrome.scripting
    .executeScript({
      target: { tabId },
      args: [selectors],
      func: (sels: string[]) => sels.some((sel) => {
        try {
          return Boolean(document.querySelector(sel))
        } catch {
          return false
        }
      }),
    })
    .catch(() => [{ result: false }])
  return Boolean(found?.result)
}

export async function dryRunUrl(url: string): Promise<{ fields: number; plan: FilledField[]; unresolved: FieldDescriptor[] }> {
  const [settings, profile] = await Promise.all([getSettings(), getProfile()])
  let tab: WorkerTab | null = null
  try {
    tab = await openTab(url)
    await waitForLoad(tab.tabId)
    await ensureAgent(tab.tabId)
    tab.frameId = await pickFormFrame(tab.tabId)
    const harvest = await harvestStep(tab)
    const vendor = vendorForUrl(url)
    const resolved = await resolveFields({
      fields: harvest.fields,
      profile,
      job: null,
      vendor,
      settings,
      url,
    })
    // Record what actually stuck. Reporting the plan alone made a dry run
    // unable to tell a filled form from one that refused every value, which is
    // precisely the question a dry run exists to answer.
    const fill = (
      await callAgent<Extract<FormResponse, { type: 'form:fill' }>>(tab, {
        type: 'form:fill',
        plan: resolved.plan,
        pacing: settings.autonomy.delayBetweenFieldsMs,
      })
    ).result
    recordFillOutcome(resolved.plan, fill)
    if (resolved.unresolved.length > 0) {
      await callAgent(tab, { type: 'form:highlight', selectors: resolved.unresolved.map((f) => f.selector) }).catch(
        () => {}
      )
    }
    // Left open on purpose: the point of a dry run is to look at the result.
    await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' }).catch(() => {})
    tab = null
    return { fields: harvest.fields.length, plan: resolved.plan, unresolved: resolved.unresolved }
  } finally {
    await closeTab(tab)
  }
}

/** Settings type re-export keeps the orchestrator's imports in one place. */
export type { Settings }
