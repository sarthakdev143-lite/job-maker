/**
 * Service worker: message router and scheduler.
 *
 * Everything the UI can do arrives here as one typed request, is dispatched to
 * the module that owns it, and comes back as `{ok, data}` or `{ok, error}`. The
 * worker itself holds no business logic -- it is a switchboard plus the alarm
 * that wakes the agent up.
 *
 * MV3 service workers are killed aggressively, so nothing important lives in
 * memory: run state is rebuilt from storage on wake, and the periodic alarm is
 * what guarantees the agent keeps going after a shutdown.
 */

import { orchestrator } from './orchestrator'
import { runDiscovery } from '@/discovery'
import { accessNeeded, bankCoverage, recurringParks, rejectionSummary, scoreQueue, sourceYield } from './insights'
import { setUpSearchesFromProfile } from '@/discovery/setup'
import { startAutopilot } from './autopilot'
import { applyToJob, dryRunUrl, submitApprovedApplication } from '@/runner/apply-machine'
import { llm } from '@/llm/broker'
import { extractJsonCandidate, repairJson } from '@/llm/structured'
import { answersRepo, applicationsRepo, dbStats, docsRepo, jobsRepo, logsRepo } from '@/storage/db'
import { list as listAnswers, remember, remove as removeAnswer, seedFromProfile } from '@/storage/answer-bank'
import {
  deleteRecipe,
  exportAll,
  getProfile,
  getRecipes,
  getSettings,
  importAll,
  saveProfile,
  saveRecipe,
  saveSettings,
} from '@/storage/settings'
import { blobToDataUrl, renderResumePdf } from '@/documents/pdf'
import { mergeIntoProfile, parseResumeText, remainingGaps } from '@/documents/parse-resume'
import { suggestRules } from '@/matching/suggest'
import { createLogger, setLogBroadcaster } from '@/shared/logger'
import { getLastSummary, getRecentSummaries, getRecipeHealth } from './run-history'
import { err, ok, type BroadcastEvent, type UiRequest } from '@/shared/messages'
import { errorMessage } from '@/shared/util'
import { formAgentFiles, hasHostAccess, originPattern } from '@/shared/injection'
import { allEvidence, clearEvidence } from '@/storage/evidence'
import { allSiteMemory, clearSiteMemory } from '@/storage/site-memory'
import { runSelfTest } from './self-test'
import { activity } from '@/shared/activity'
import { BUILD_ID } from '@/shared/build'
import { startHeartbeat } from '@/shared/keepalive'
import type { ChatProgress } from '@/shared/messages'

const log = createLogger('worker')

const CYCLE_ALARM = 'autoapply:cycle'
const MAINTENANCE_ALARM = 'autoapply:maintenance'

/* ------------------------------------------------------------- broadcast */

function broadcast(event: BroadcastEvent): void {
  // No receiver is a normal condition (the panel may be closed), so the
  // rejection is swallowed rather than logged.
  chrome.runtime.sendMessage(event).catch(() => {})
}

setLogBroadcaster((level, scope, message, at) => {
  broadcast({ type: 'evt:log', level, scope, message, at })
})

orchestrator.onStateChange((state) => broadcast({ type: 'evt:state', state }))

// The activity tracker knows what is blocking right now -- "asking the model",
// "model is replying (412 characters)" -- and nothing was listening to it, so
// every multi-minute operation presented to the user as a motionless screen.
// A connection test on the shipped defaults could run for nine minutes with no
// sign of life, which is indistinguishable from a hang.
activity.onChange((step) =>
  broadcast({ type: 'evt:activity', label: step.label, detail: step.detail, at: step.updatedAt })
)

/* --------------------------------------------------------------- router */

async function route(msg: UiRequest): Promise<unknown> {
  switch (msg.type) {
    case 'ui:getState':
      return orchestrator.refreshCounts()

    case 'ui:getSettings':
      return getSettings()

    case 'ui:saveSettings': {
      const saved = await saveSettings(msg.settings)
      await llm.invalidate() // pick up a driver or key change immediately
      await registerCustomDomains(saved.customApplyDomains)
      return saved
    }

    case 'ui:getProfile':
      return getProfile()

    case 'ui:saveProfile': {
      const saved = await saveProfile(msg.profile)
      const seeded = await seedFromProfile(saved)
      log.info(`Profile saved; ${seeded} answer(s) seeded into the bank`)
      return saved
    }

    case 'ui:parseResume': {
      const [settings, existing] = await Promise.all([getSettings(), getProfile()])
      const parsed = await parseResumeText(msg.text, settings)
      const merged = mergeIntoProfile(existing, parsed, msg.mode, msg.text)

      const saved = await saveProfile(merged.profile)
      const seeded = await seedFromProfile(saved)
      log.info(
        `Imported resume: ${merged.changes.length} field group(s) filled, ${seeded} answer(s) seeded`
      )

      return {
        profile: saved,
        changes: merged.changes,
        skipped: merged.skipped,
        gaps: remainingGaps(saved),
        roles: parsed.experience.length,
        seeded,
      }
    }

    case 'ui:setupSearches': {
      const result = await setUpSearchesFromProfile()
      broadcast({ type: 'evt:jobs' })
      return result
    }

    case 'ui:suggestRules': {
      const [settings, profile] = await Promise.all([getSettings(), getProfile()])
      return suggestRules(profile, settings)
    }

    case 'ui:getRecipes':
      return getRecipes()

    case 'ui:saveRecipe':
      return saveRecipe(msg.recipe)

    case 'ui:deleteRecipe':
      return deleteRecipe(msg.id)

    case 'ui:runDiscovery': {
      const result = await runDiscovery({ recipeId: msg.recipeId })
      broadcast({ type: 'evt:jobs' })
      return result
    }

    case 'ui:listJobs':
      return msg.status ? jobsRepo.byStatus(msg.status, msg.limit ?? 200) : jobsRepo.all(msg.limit ?? 200)

    case 'ui:listApplications':
      return msg.status
        ? applicationsRepo.byStatus(msg.status, msg.limit ?? 200)
        : applicationsRepo.all(msg.limit ?? 200)

    case 'ui:getApplication':
      return applicationsRepo.get(msg.id)

    case 'ui:queueJob': {
      const updated = await jobsRepo.update(msg.jobId, { status: 'queued' })
      broadcast({ type: 'evt:jobs' })
      return updated
    }

    case 'ui:skipJob': {
      const updated = await jobsRepo.update(msg.jobId, {
        status: 'skipped',
        rejectReason: msg.reason ?? 'skipped by user',
      })
      broadcast({ type: 'evt:jobs' })
      return updated
    }

    case 'ui:approveApplication': {
      const outcome = await submitApprovedApplication(msg.id, msg.edits)
      broadcast({ type: 'evt:applications' })
      await orchestrator.refreshCounts()
      return outcome
    }

    case 'ui:rejectApplication': {
      const updated = await applicationsRepo.update(msg.id, { status: 'skipped', error: 'rejected by user' })
      const app = await applicationsRepo.get(msg.id)
      if (app) await jobsRepo.update(app.jobId, { status: 'skipped', rejectReason: 'rejected by user' })
      broadcast({ type: 'evt:applications' })
      return updated
    }

    case 'ui:retryApplication': {
      const app = await applicationsRepo.get(msg.id)
      if (!app) throw new Error('Application not found')
      const outcome = await applyToJob(app.jobId)
      broadcast({ type: 'evt:applications' })
      return outcome
    }

    case 'ui:preflight':
      return orchestrator.preflight()

    case 'ui:autopilot': {
      const result = await startAutopilot()
      broadcast({ type: 'evt:jobs' })
      return result
    }

    case 'ui:startAgent':
      return orchestrator.start()

    case 'ui:stopAgent':
      return orchestrator.stop()

    case 'ui:killSwitch':
      return orchestrator.killSwitch()

    case 'ui:testLlm': {
      const prompt =
        msg.prompt ??
        'Reply with a single fenced json block containing exactly {"ok": true, "engine": "<the model name you are>"} and nothing else.'
      // A diagnostic has to fail fast or it is not a diagnostic. On the shipped
      // defaults -- a 180s request timeout and two transport retries -- this
      // took up to nine minutes to report a bad model, which is
      // indistinguishable from the extension being frozen. One attempt, 45
      // seconds, no failover: the question being asked is whether THIS driver
      // works, not whether some fallback could rescue it.
      const queuedBehind = llm.queueDepth
      const startedAt = Date.now()
      const text = await llm.completeText(
        { prompt, freshContext: true, timeoutMs: 45000 },
        'connection test',
        { retries: 0, useFallback: false }
      )
      const elapsedMs = Date.now() - startedAt

      // Reaching the model is not the thing worth testing. Every real call in
      // this extension is completeStructured, which needs a parseable JSON
      // object back — so a model that answers in prose passes a bytes-returned
      // check and then silently produces empty profiles. Verify the contract
      // the app actually depends on, and report it separately from the reply.
      const candidate = extractJsonCandidate(text)
      let jsonOk = false
      let jsonDetail: string

      if (!candidate) {
        jsonDetail = 'The reply contained no JSON at all — this model cannot be used by the agent.'
      } else {
        try {
          const value: unknown = JSON.parse(repairJson(candidate))
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            jsonOk = true
            jsonDetail = 'Returned a valid JSON object — this model can drive the agent.'
          } else {
            jsonDetail = `Parsed, but as ${Array.isArray(value) ? 'an array' : typeof value} rather than an object.`
          }
        } catch (e) {
          jsonDetail = `The JSON in the reply did not parse: ${(e as Error).message}`
        }
      }

      return { reply: text.slice(0, 2000), jsonOk, jsonDetail, elapsedMs, queuedBehind }
    }

    case 'ui:cancelModelQueue':
      return { dropped: await llm.abortQueue() }

    case 'ui:listModels':
      return { models: await llm.listModels() }

    case 'ui:listEvidence':
      return { evidence: await allEvidence() }

    case 'ui:clearEvidence':
      await clearEvidence()
      return { cleared: true }

    case 'ui:listSiteMemory':
      return { sites: await allSiteMemory() }

    case 'ui:clearSiteMemory':
      await clearSiteMemory()
      return { cleared: true }

    case 'ui:selfTest':
      return runSelfTest({
        probePages: msg.probePages,
        probeCount: msg.probeCount,
        probeUrl: msg.probeUrl,
      })

    case 'ui:llmHealth':
      return llm.health(true)

    case 'ui:openLlmLogin':
      await llm.openLogin()
      return { opened: true }

    case 'ui:listAnswers':
      return listAnswers(msg.query ?? '')

    case 'ui:saveAnswer':
      return remember({ label: msg.label, value: msg.value, source: 'user', pinned: msg.pinned })

    case 'ui:deleteAnswer': {
      await removeAnswer(msg.id)
      return { deleted: true }
    }

    case 'ui:listLogs':
      return logsRepo.recent(msg.limit ?? 300)

    case 'ui:getLastRun':
      return getLastSummary()

    case 'ui:getRunHistory':
      return getRecentSummaries(msg.limit ?? 5)

    case 'ui:getRecipeHealth':
      return getRecipeHealth()

    case 'ui:clearLogs': {
      await logsRepo.clear()
      return { cleared: true }
    }

    case 'ui:stats': {
      const [counts, storage, answers] = await Promise.all([
        applicationsRepo.countByStatus(),
        dbStats(),
        answersRepo.count(),
      ])
      const all = await applicationsRepo.all(2000)
      const submitted = all.filter((a) => a.status === 'submitted')
      const scores = submitted.map((a) => a.matchScore ?? 0).filter((s) => s > 0)
      return {
        counts,
        storage,
        answers,
        submittedTotal: submitted.length,
        averageScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
        llmQueueDepth: llm.queueDepth,
      }
    }

    case 'ui:exportData':
      return { payload: await exportAll() }

    case 'ui:importData':
      return importAll(msg.payload)

    case 'ui:previewResume': {
      const profile = await getProfile()
      const blob = await renderResumePdf(profile, null)
      return { dataUrl: await blobToDataUrl(blob), sizeBytes: blob.size }
    }

    case 'ui:downloadDoc': {
      const stored = await docsRepo.get(msg.docId)
      if (!stored) throw new Error('Document not found')
      return { dataUrl: await blobToDataUrl(stored.blob), fileName: stored.meta.fileName }
    }

    case 'ui:scoreQueue':
      return scoreQueue(msg.limit)

    case 'ui:rejectionSummary':
      return rejectionSummary()

    case 'ui:accessNeeded':
      return accessNeeded()

    case 'ui:bankCoverage':
      return bankCoverage()

    case 'ui:sourceYield':
      return sourceYield()

    case 'ui:recurringParks':
      return recurringParks()

    case 'ui:dryRunUrl':
      return dryRunUrl(msg.url)

    case 'ui:version':
      return { build: BUILD_ID }

    default: {
      const exhaustive: never = msg
      // Naming the build matters: nine times in ten this is not a missing
      // handler but a worker Chrome never restarted after a rebuild.
      throw new Error(
        `Unhandled request: ${JSON.stringify(exhaustive)} (background worker build ${BUILD_ID})`
      )
    }
  }
}

/**
 * Streaming progress from the chat-site bridge.
 *
 * A reply that takes thirty seconds is indistinguishable from a hang unless
 * something is visibly moving, so the bridge reports how much text has arrived
 * and that becomes the liveness signal the panel watches.
 */

chrome.runtime.onMessage.addListener((msg: ChatProgress) => {
  if (!msg || msg.type !== 'chat:progress') return false
  activity.note(
    msg.generating
      ? `The model is replying (${msg.chars} characters so far)`
      : `The model finished replying (${msg.chars} characters)`
  )
  return false
})

chrome.runtime.onMessage.addListener((msg: UiRequest, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !String(msg.type ?? '').startsWith('ui:')) return false

  // A request that outlives the ~30s MV3 idle window gets its worker evicted
  // mid-flight, which destroys the message port along with it -- the
  // sendResponse below then fires into a channel that already closed, and the
  // panel sees "A listener indicated an asynchronous response ... but the
  // message channel closed before a response was received" with no further
  // detail. Slow requests are not rare: an LLM call with transport retries,
  // a login-fallback health check, and a schema retry can run for minutes.
  // Poking an extension API for the lifetime of every request, not just
  // during an agent run, keeps the worker (and therefore the port) alive for
  // exactly as long as the caller is actually waiting.
  const heartbeat = startHeartbeat()
  void route(msg).then(
    (data) => {
      heartbeat.stop()
      sendResponse(ok(data))
    },
    (e) => {
      heartbeat.stop()
      log.error(`Request ${msg.type} failed: ${errorMessage(e)}`)
      sendResponse(err(errorMessage(e)))
    }
  )
  return true // keep the channel open for the async reply
})

/* -------------------------------------------------------- custom domains */

/**
 * Register the form agent on domains the user added by hand. These cannot go in
 * the manifest, so they are registered dynamically and re-registered on every
 * settings save and worker start.
 */
async function registerCustomDomains(domains: string[]): Promise<void> {
  const id = 'autoapply-custom-domains'
  await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {})
  const matches = domains
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (d.includes('://') ? d : `https://${d.replace(/^\*?\.?/, '')}/*`))
  if (matches.length === 0) return

  const js = formAgentFiles()
  if (js.length === 0) return

  try {
    await chrome.scripting.registerContentScripts([
      { id, matches, js, runAt: 'document_idle', allFrames: true },
    ])
    log.info(`Form agent registered on ${matches.length} custom domain(s)`)
  } catch (e) {
    // Usually a missing host permission; the user grants it from the options page.
    log.warn(`Could not register custom domains: ${errorMessage(e)}`)
  }
}

/* -------------------------------------------------------------- lifecycle */

chrome.runtime.onInstalled.addListener(async (details) => {
  log.info(`Extension ${details.reason}`)
  // Five minutes. One minute was too eager: the loop already runs continuously
  // on its own, so the alarm is purely the safety net under an evicted worker,
  // and firing it constantly only added chances to race that loop into
  // existence twice.
  await chrome.alarms.create(CYCLE_ALARM, { periodInMinutes: 5 })
  await chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 720 })

  const settings = await getSettings()
  await registerCustomDomains(settings.customApplyDomains)

  if (details.reason === 'install') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/options/index.html') })
  }

  // Check ourselves on every reload, without being asked. The cheap checks
  // only -- no model call, no tabs -- because this runs whether or not the user
  // is looking, and the expensive ones belong behind a button. The point is
  // that a broken permission or a missing alarm announces itself in the log at
  // the moment it breaks, rather than being discovered an hour into a run that
  // was never going to work.
  void announceSelfTest()
})

/**
 * Run the fast checks and say so in the log.
 *
 * Deliberately silent when everything is fine: a green line on every reload
 * becomes noise, and noise is how a red line gets missed.
 */
async function announceSelfTest(): Promise<void> {
  try {
    const report = await runSelfTest({ probePages: false })
    const problems = report.checks.filter((c) => c.status === 'fail' || c.status === 'warn')
    if (problems.length === 0) return

    for (const problem of problems) {
      const line = `${problem.name}: ${problem.detail}${problem.fix ? ` -> ${problem.fix}` : ''}`
      if (problem.status === 'fail') log.error(`Self-check: ${line}`)
      else log.warn(`Self-check: ${line}`)
    }
    log.info('Self-check found something. Settings -> Diagnostics -> Run the self-test for the full report.')
  } catch (e) {
    log.debug(`Self-check could not run: ${errorMessage(e)}`)
  }
}

chrome.runtime.onStartup.addListener(async () => {
  // The cycle alarm is the safety net under an evicted worker. It was created
  // only on install, so anything that cleared the alarm table (policy, corrupt
  // storage, dev reload without reinstall) silently removed the net. Re-assert
  // both alarms on every browser start; creating an existing alarm is a no-op.
  await chrome.alarms.create(CYCLE_ALARM, { periodInMinutes: 5 })
  await chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 720 })
  const settings = await getSettings()
  await registerCustomDomains(settings.customApplyDomains)
  await orchestrator.refreshCounts()
  await orchestrator.resumeIfInterrupted()
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === CYCLE_ALARM) {
    const settings = await getSettings()
    if (!settings.autonomy.enabled) return

    // A kill switch has to outlive the next tick. Without this the alarm woke
    // five minutes after Stop, saw nothing running, and started a fresh run --
    // so the button appeared to do nothing but pause.
    if (await orchestrator.halted()) {
      log.debug('Scheduled cycle skipped: halted by the kill switch')
      return
    }

    // A run the worker was evicted out of takes priority: it already has a
    // queue and a heartbeat to restore, and starting a fresh one on top of it
    // would run two loops against the same jobs.
    if (await orchestrator.resumeIfInterrupted()) return

    if (!orchestrator.getState().running) {
      log.info('Scheduled cycle starting')
      await orchestrator.start().catch((e) => log.warn(`Scheduled start refused: ${errorMessage(e)}`))
    } else {
      await orchestrator.runCycleNow({ manual: false })
    }
  }

  if (alarm.name === MAINTENANCE_ALARM) {
    const [jobs, docs] = await Promise.all([jobsRepo.prune(60), docsRepo.prune(90)])
    await logsRepo.trim()
    log.info(`Maintenance: pruned ${jobs} job(s) and ${docs} document(s)`)
  }
})

// Clicking the toolbar icon opens the console rather than a popup-only view.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})

/**
 * Resume on wake, not just on browser start.
 *
 * Chrome replaces an evicted worker by running this file again, with no event
 * to say why. Checking the persisted run state at module scope is what turns
 * eviction into a pause of seconds rather than a silent stop.
 */
void orchestrator.resumeIfInterrupted().catch((e) => log.warn(`Could not resume: ${errorMessage(e)}`))

log.info('Service worker ready')
