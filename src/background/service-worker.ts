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
import { setUpSearchesFromProfile } from '@/discovery/setup'
import { applyToJob, dryRunUrl, submitApprovedApplication } from '@/runner/apply-machine'
import { llm } from '@/llm/broker'
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
import { err, ok, type BroadcastEvent, type UiRequest } from '@/shared/messages'
import { errorMessage } from '@/shared/util'
import { formAgentFiles } from '@/shared/injection'
import { activity } from '@/shared/activity'
import type { DeepSeekProgress } from '@/shared/messages'

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
      const text = await llm.completeText({ prompt, freshContext: true }, 'connection test')
      return { reply: text.slice(0, 2000) }
    }

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

    case 'ui:dryRunUrl':
      return dryRunUrl(msg.url)

    default: {
      const exhaustive: never = msg
      throw new Error(`Unhandled request: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * Streaming progress from the DeepSeek bridge.
 *
 * A reply that takes thirty seconds is indistinguishable from a hang unless
 * something is visibly moving, so the bridge reports how much text has arrived
 * and that becomes the liveness signal the panel watches.
 */
chrome.runtime.onMessage.addListener((msg: DeepSeekProgress) => {
  if (!msg || msg.type !== 'ds:progress') return false
  activity.note(
    msg.generating
      ? `DeepSeek is replying (${msg.chars} characters so far)`
      : `DeepSeek finished replying (${msg.chars} characters)`
  )
  return false
})

chrome.runtime.onMessage.addListener((msg: UiRequest, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !String(msg.type ?? '').startsWith('ui:')) return false
  void route(msg).then(
    (data) => sendResponse(ok(data)),
    (e) => {
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
  await chrome.alarms.create(CYCLE_ALARM, { periodInMinutes: 30 })
  await chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 720 })

  const settings = await getSettings()
  await registerCustomDomains(settings.customApplyDomains)

  if (details.reason === 'install') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/options/index.html') })
  }
})

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings()
  await registerCustomDomains(settings.customApplyDomains)
  await orchestrator.refreshCounts()
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === CYCLE_ALARM) {
    const settings = await getSettings()
    if (!settings.autonomy.enabled) return
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

log.info('Service worker ready')
