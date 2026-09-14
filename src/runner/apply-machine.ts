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
import { ensureContentScript, formAgentFiles } from '@/shared/injection'
import { closeWorkerWindow, openWorkerWindow } from '@/shared/windows'
import { activity } from '@/shared/activity'

const log = createLogger('runner')

const MAX_WIZARD_STEPS = 8
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
type WorkerTab = { tabId: number; windowId: number; frameId?: number }

async function openTab(url: string): Promise<WorkerTab> {
  return openWorkerWindow(url, { minimized: true })
}

async function closeTab(tab: WorkerTab | null): Promise<void> {
  await closeWorkerWindow(tab?.windowId)
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

/** Click the adapter's "apply" entry point, when the form is behind one. */
async function clickApplyEntry(tabId: number, selectors: string[]): Promise<boolean> {
  if (selectors.length === 0) return false
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [selectors],
    func: (sels: string[]) => {
      for (const sel of sels) {
        try {
          const el = document.querySelector(sel) as HTMLElement | null
          if (el) {
            el.scrollIntoView({ block: 'center' })
            el.click()
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

/* ------------------------------------------------------------- the machine */

export async function applyToJob(jobId: string, options: ApplyOptions = {}): Promise<ApplyOutcome> {
  const step = (name: string, detail = '') => {
    options.onStep?.(name, detail)
    activity.note(detail ? `${name} - ${detail}` : name)
    log.debug(`step: ${name}${detail ? ` (${detail})` : ''}`, undefined, jobId)
  }

  const [job, settings, profile] = await Promise.all([jobsRepo.get(jobId), getSettings(), getProfile()])
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

    if (!detect.isApplicationForm) {
      step('enter form')
      const clicked = await clickApplyEntry(tab.tabId, adapter.applyEntrySelectors ?? [])
      if (clicked) {
        await sleep(2500)
        await ensureAgent(tab.tabId)
        // The form may have appeared in a frame that did not exist before.
        tab.frameId = await pickFormFrame(tab.tabId)
        detect = (await callAgent<Extract<FormResponse, { type: 'form:detect' }>>(tab, { type: 'form:detect' }))
          .result
      }
    }

    if (!detect.isApplicationForm) {
      const reason = detect.detail || 'no application form found on this page'
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
    if (needsResume || needsCover) {
      step('documents')
      const generated = await generateDocuments(profile, job, settings, {
        needResume: needsResume,
        needCoverLetter: needsCover,
      })
      docs = {
        resumeDocId: generated.resumeDocId,
        coverDocId: generated.coverDocId,
        coverLetterText: generated.coverLetterText,
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

      // --- never move on from an unanswered mandatory question -------------
      //
      // On a chatbot-style flow the "next" control is often the submit control
      // too, so advancing past a blank required question does not leave it for
      // later -- it sends the application without it, and the site rejects the
      // whole thing as incomplete.
      const requiredStillBlank = resolved.unresolved.filter((f) => f.required)
      if (requiredStillBlank.length > 0 && settings.autonomy.requireAllRequiredFields) {
        await applicationsRepo.addTimeline(
          application.id,
          'wizard',
          `stopped before advancing: ${requiredStillBlank.length} mandatory question(s) unanswered (${requiredStillBlank
            .slice(0, 3)
            .map((f) => f.label || f.selector)
            .join(', ')})`,
          'warn'
        )
        break
      }

      // --- advance a wizard, or stop ---------------------------------------
      if (!detect.multiStep) break
      const advance = await callAgent<Extract<FormResponse, { type: 'form:advanceStep' }>>(tab, {
        type: 'form:advanceStep',
      })
      if (!advance.advanced) break

      await applicationsRepo.addTimeline(application.id, 'wizard', `advanced: ${advance.detail}`)
      await pause({ min: 1200, max: 2600 })
      await ensureAgent(tab.tabId)
      tab.frameId = await pickFormFrame(tab.tabId)
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
    // the page's own complaint attached rather than retrying blindly.
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
  // Confirmation can be a navigation or an in-place re-render, so poll rather
  // than checking once; a slow redirect otherwise reads as a failed submit.
  const deadline = Date.now() + 20000
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
    await callAgent(tab, {
      type: 'form:fill',
      plan: resolved.plan,
      pacing: settings.autonomy.delayBetweenFieldsMs,
    })
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
