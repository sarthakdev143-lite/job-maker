/**
 * The agent loop.
 *
 * One cycle is: discover, score what was discovered, then apply to what scored
 * well -- with a pause between applications and a circuit breaker that halts
 * the run after repeated failures rather than hammering a site that is clearly
 * not cooperating.
 *
 * The loop is cooperative, not preemptive: every stage checks `shouldStop`
 * between items, so pressing stop takes effect at the next natural boundary
 * instead of leaving a half-filled form open.
 */

import { runDiscovery, unscoredJobs } from '@/discovery'
import { getRecipes } from '@/storage/settings'
import { scoreBatch } from '@/matching/scorer'
import { applyToJob } from '@/runner/apply-machine'
import { dailyCounterKey, withinActiveWindow } from '@/runner/autonomy-gate'
import { applicationsRepo, jobsRepo, logsRepo } from '@/storage/db'
import { getCounter, getProfile, getSettings, profileIsUsable, pruneCounters } from '@/storage/settings'
import { llm } from '@/llm/broker'
import { createLogger } from '@/shared/logger'
import { dayKey, errorMessage, pause } from '@/shared/util'
import type { AgentState } from '@/shared/messages'
import type { Autonomy } from '@/storage/schemas'

const log = createLogger('agent')

type StateListener = (state: AgentState) => void

/**
 * One thing that has to be true before the agent can do useful work.
 *
 * These exist because "press Start and nothing happens" is the worst failure
 * mode an unattended agent can have: with no searches enabled a cycle
 * legitimately discovers nothing, scores nothing and applies to nothing, which
 * from the outside is indistinguishable from a crash. Every reason the agent
 * would do nothing is now something it can name.
 */
export type PreflightCheck = {
  id: string
  label: string
  ok: boolean
  detail: string
  /** Which settings section fixes it, for a jump link in the UI. */
  fix?: 'profile' | 'searches' | 'matching' | 'model' | 'autonomy'
  /** A failing blocker refuses to start; a failing warning only explains. */
  blocking: boolean
}

class Orchestrator {
  private state: AgentState = {
    running: false,
    phase: 'idle',
    currentJobId: '',
    currentStep: '',
    llmHealth: 'unknown',
    appliedToday: 0,
    dailyCap: 0,
    queueDepth: 0,
    reviewDepth: 0,
    lastError: '',
    startedAt: null,
    updatedAt: Date.now(),
  }

  private stopRequested = false
  /**
   * Whether this run was started by a person pressing Start.
   *
   * A manual run ignores the active-hours window entirely. Someone pressing the
   * button on a Sunday afternoon means now, and an agent that answers that by
   * sitting still and saying "running" is indistinguishable from a broken one.
   */
  private manualRun = false
  private cycleInFlight: Promise<void> | null = null
  private listeners = new Set<StateListener>()
  private consecutiveFailures = 0

  /* ----------------------------------------------------------------- state */

  getState(): AgentState {
    return { ...this.state }
  }

  onStateChange(fn: StateListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private patch(patch: Partial<AgentState>): void {
    this.state = { ...this.state, ...patch, updatedAt: Date.now() }
    for (const fn of this.listeners) {
      try {
        fn(this.state)
      } catch {
        // A dead listener must not break the run.
      }
    }
  }

  /** Refresh the counts the UI shows, without touching run state. */
  async refreshCounts(): Promise<AgentState> {
    const settings = await getSettings()
    const [appliedToday, queued, review] = await Promise.all([
      getCounter(dailyCounterKey()),
      jobsRepo.byStatus('queued', 500),
      applicationsRepo.byStatus('needs_review', 500),
    ])
    this.patch({
      appliedToday,
      dailyCap: settings.autonomy.maxApplicationsPerDay,
      queueDepth: queued.length,
      reviewDepth: review.length,
    })
    return this.getState()
  }

  private shouldStop = (): boolean => this.stopRequested

  /* ------------------------------------------------------------- preflight */

  /**
   * Everything that decides whether a run can accomplish anything, checked in
   * one place and reportable to the UI without starting anything.
   */
  async preflight(): Promise<PreflightCheck[]> {
    const [settings, profile, recipes] = await Promise.all([getSettings(), getProfile(), getRecipes()])
    const checks: PreflightCheck[] = []

    const usable = profileIsUsable(profile)
    checks.push({
      id: 'profile',
      label: 'Your profile is complete enough to apply',
      ok: usable.ok,
      detail: usable.ok ? `${profile.firstName} ${profile.lastName}`.trim() : `Missing ${usable.missing.join(', ')}`,
      fix: 'profile',
      blocking: true,
    })

    const health = await llm.health(true)
    this.patch({ llmHealth: health.status })
    checks.push({
      id: 'model',
      label: 'The language model is reachable',
      ok: health.status === 'ok',
      detail:
        health.status === 'ok'
          ? health.detail || 'ready'
          : health.status === 'needs_login'
            ? 'Sign in to chat.deepseek.com, or set an API key'
            : health.detail,
      fix: 'model',
      blocking: true,
    })

    const enabledRecipes = recipes.filter((r) => r.enabled)
    const queued = await jobsRepo.byStatus('queued', 50)
    const hasWork = enabledRecipes.length > 0 || queued.length > 0
    checks.push({
      id: 'searches',
      label: 'There is somewhere to look, or something already queued',
      ok: hasWork,
      detail: hasWork
        ? `${enabledRecipes.length} search(es) on, ${queued.length} job(s) queued`
        : recipes.length > 0
          ? `${recipes.length} search(es) exist but none are switched on. Press "Set up searches" below.`
          : 'No searches yet. Press "Set up searches" below and it will build them from your profile.',
      fix: 'searches',
      blocking: true,
    })

    const enabledSites = Object.entries(settings.enabledSites).filter(([, on]) => on)
    checks.push({
      id: 'sites',
      label: 'At least one site is allowed',
      ok: enabledSites.length > 0,
      detail: enabledSites.length > 0 ? enabledSites.map(([id]) => id).join(', ') : 'Every site is switched off',
      fix: 'autonomy',
      blocking: true,
    })

    const inWindow = withinActiveWindow(settings.autonomy)
    checks.push({
      id: 'hours',
      label: 'Scheduled runs are allowed right now',
      ok: inWindow,
      detail: inWindow
        ? `Inside ${settings.autonomy.activeHours.start}:00-${settings.autonomy.activeHours.end}:00 on an active day`
        : `Outside ${settings.autonomy.activeHours.start}:00-${settings.autonomy.activeHours.end}:00, or not an active day. Pressing Start still runs immediately.`,
      fix: 'autonomy',
      blocking: false,
    })

    const appliedToday = await getCounter(dailyCounterKey())
    const capLeft = settings.autonomy.maxApplicationsPerDay - appliedToday
    checks.push({
      id: 'cap',
      label: "Today's cap has room left",
      ok: capLeft > 0,
      detail: `${appliedToday} of ${settings.autonomy.maxApplicationsPerDay} sent today`,
      fix: 'autonomy',
      blocking: false,
    })

    checks.push({
      id: 'mode',
      label: 'Autonomy mode',
      ok: true,
      detail:
        settings.autonomy.mode === 'dry_run'
          ? 'Dry run: it will fill forms but never submit'
          : settings.autonomy.mode === 'review'
            ? 'Review: every application waits for your approval'
            : settings.autonomy.mode === 'gated'
              ? `Gated: submits above ${settings.autonomy.minMatchScore} match and ${settings.autonomy.minFillConfidence} confidence`
              : 'Full: submits anything that fills cleanly',
      fix: 'autonomy',
      blocking: false,
    })

    return checks
  }

  /* ----------------------------------------------------------------- start */

  async start(): Promise<AgentState> {
    if (this.state.running) return this.getState()

    const settings = await getSettings()
    const checks = await this.preflight()
    const blockers = checks.filter((c) => c.blocking && !c.ok)

    if (blockers.length > 0) {
      const message = blockers.map((c) => c.detail).join('. ')
      this.patch({ phase: 'error', lastError: message })
      log.error(`Cannot start: ${message}`)
      throw new Error(message)
    }

    // The detail already reads as a sentence; pairing it with the check's name
    // produced lines like "Now is inside your active hours: Outside 9:00-21:00".
    for (const warning of checks.filter((c) => !c.blocking && !c.ok)) {
      log.warn(warning.detail)
    }

    this.stopRequested = false
    this.manualRun = true
    this.consecutiveFailures = 0
    this.patch({ running: true, phase: 'idle', lastError: '', startedAt: Date.now() })
    log.info(`Agent started in ${settings.autonomy.mode} mode`)

    void this.runCycle()
    return this.getState()
  }

  async stop(): Promise<AgentState> {
    this.stopRequested = true
    this.patch({ phase: 'stopped', currentStep: 'stopping after the current step' })
    log.info('Stop requested')
    await this.cycleInFlight?.catch(() => {})
    this.patch({ running: false, phase: 'idle', currentStep: '', currentJobId: '' })
    return this.getState()
  }

  /** Immediate halt: stop the loop and close any worker windows we opened. */
  async killSwitch(): Promise<AgentState> {
    this.stopRequested = true
    this.patch({ running: false, phase: 'stopped', currentStep: 'halted', currentJobId: '' })
    log.warn('Kill switch engaged')
    const windows = await chrome.windows.getAll({ populate: true }).catch(() => [])
    for (const win of windows) {
      const onlyTab = win.tabs?.length === 1 ? win.tabs[0] : null
      // Only close the single-tab minimized windows the agent creates itself.
      if (win.state === 'minimized' && onlyTab && win.id !== undefined) {
        await chrome.windows.remove(win.id).catch(() => {})
      }
    }
    return this.getState()
  }

  /* ----------------------------------------------------------------- cycle */

  /**
   * Run one full cycle. Safe to call when a cycle is already in flight.
   *
   * The scheduler calls this without arguments, so a cycle it triggers respects
   * the active-hours window even if the run was originally started by hand.
   */
  async runCycleNow(options: { manual?: boolean } = {}): Promise<void> {
    this.manualRun = options.manual ?? false
    if (this.cycleInFlight) return this.cycleInFlight
    return this.runCycle()
  }

  private async runCycle(): Promise<void> {
    const promise = this.cycle()
    this.cycleInFlight = promise
    try {
      await promise
    } finally {
      this.cycleInFlight = null
    }
  }

  private async cycle(): Promise<void> {
    // A run that finds nothing is a normal outcome, and it has to leave a trace
    // in the UI. Clearing the status line at the end of every cycle is what made
    // a working agent look like a frozen one.
    const tally = { found: 0, scored: 0, queued: 0, applied: 0 }

    try {
      await pruneCounters(dayKey())
      const settings = await getSettings()

      if (!this.manualRun && !withinActiveWindow(settings.autonomy)) {
        const when = describeNextWindow(settings.autonomy)
        this.patch({ phase: 'paused', currentStep: `waiting for active hours (${when})` })
        log.info(`Outside active hours; the next scheduled run is ${when}. Press Start to run now anyway.`)
        return
      }

      // --- discover ------------------------------------------------------
      this.patch({ phase: 'discovering', currentStep: 'running search recipes' })
      const discovery = await runDiscovery({ shouldStop: this.shouldStop })
      tally.found = discovery.stored
      log.info(
        `Discovery: ${discovery.stored} new, ${discovery.duplicates} duplicate, ${discovery.rejected} filtered out`
      )
      if (this.shouldStop()) return

      // --- score ---------------------------------------------------------
      const toScore = await unscoredJobs(30)
      if (toScore.length > 0) {
        this.patch({ phase: 'scoring', currentStep: `scoring ${toScore.length} job(s)` })
        const profile = await getProfile()
        const scores = await scoreBatch(
          toScore,
          profile,
          settings,
          (done, total, job) => {
            this.patch({ currentStep: `scored ${done}/${total}: ${job.title}`, currentJobId: job.id })
          },
          this.shouldStop
        )

        for (const job of toScore) {
          const score = scores.get(job.id)
          if (!score) {
            await jobsRepo.update(job.id, { status: 'new' }) // leave for the next cycle
            continue
          }
          tally.scored++
          const queue = score.shouldApply && score.score >= settings.autonomy.minMatchScore
          if (queue) tally.queued++
          await jobsRepo.update(job.id, {
            status: queue ? 'queued' : 'rejected',
            matchScore: score.score,
            matchReasons: score.reasons,
            matchConcerns: score.concerns,
            rejectReason: queue ? '' : `scored ${score.score}: ${score.concerns.join('; ') || 'below threshold'}`,
            scoredAt: Date.now(),
          })
        }
      }
      if (this.shouldStop()) return

      // --- apply ---------------------------------------------------------
      await this.applyQueue()
    } catch (e) {
      const message = errorMessage(e)
      this.patch({ phase: 'error', lastError: message })
      log.error(`Cycle failed: ${message}`)
    } finally {
      await logsRepo.trim()
      await this.refreshCounts()
      // 'paused' and 'error' both carry the explanation for why a cycle stopped
      // early. Resetting them here is what made a stalled agent look idle with
      // no reason given.
      const explained = this.state.phase === 'error' || this.state.phase === 'paused'
      if (this.state.running && !explained) {
        this.patch({ phase: 'idle', currentStep: summarize(tally), currentJobId: '' })
      }
    }
  }

  private async applyQueue(): Promise<void> {
    const settings = await getSettings()
    const queued = await jobsRepo.byStatus('queued', 100)
    if (queued.length === 0) {
      // Saying so explicitly matters: an empty queue after a full cycle looks
      // exactly like a broken agent unless it tells you that is what happened.
      log.info('Nothing queued to apply to. Run a search, or lower the match threshold.')
      this.patch({ currentStep: 'nothing queued to apply to' })
      return
    }

    this.patch({ phase: 'applying', currentStep: `${queued.length} job(s) queued` })

    for (const job of queued) {
      if (this.shouldStop()) return

      // A job parked for review stays queued so the user can still see it, but
      // re-running it every cycle would redo the model work and re-park it for
      // ever. Only untouched jobs and genuinely queued ones are applied to.
      const existing = await applicationsRepo.byJob(job.id)
      if (existing && existing.status !== 'queued') {
        log.debug(`Skipping ${job.title}: application already ${existing.status}`, undefined, job.id)
        continue
      }

      const appliedToday = await getCounter(dailyCounterKey())
      if (appliedToday >= settings.autonomy.maxApplicationsPerDay) {
        log.info(`Daily cap reached (${appliedToday}/${settings.autonomy.maxApplicationsPerDay}); pausing`)
        this.patch({ phase: 'paused', currentStep: 'daily cap reached' })
        return
      }

      if (!this.manualRun && !withinActiveWindow(settings.autonomy)) {
        log.info('Active hours ended mid-run; pausing')
        this.patch({ phase: 'paused', currentStep: 'outside active hours' })
        return
      }

      this.patch({ currentJobId: job.id, currentStep: `applying: ${job.title} at ${job.company}` })

      try {
        const outcome = await applyToJob(job.id, {
          shouldStop: this.shouldStop,
          ignoreActiveHours: this.manualRun,
          onStep: (step, detail) =>
            this.patch({ currentStep: `${job.company}: ${step}${detail ? ` (${detail})` : ''}` }),
        })

        if (outcome.application.status === 'failed') {
          this.consecutiveFailures++
        } else {
          this.consecutiveFailures = 0
        }

        if (this.consecutiveFailures >= settings.autonomy.circuitBreakerFailures) {
          const message = `Stopping: ${this.consecutiveFailures} applications failed in a row`
          log.error(message)
          this.patch({ phase: 'error', lastError: message, running: false })
          this.stopRequested = true
          return
        }
      } catch (e) {
        this.consecutiveFailures++
        log.error(`Unexpected failure on ${job.title}`, { error: errorMessage(e) }, job.id)
      }

      await this.refreshCounts()
      if (this.shouldStop()) return
      await pause(settings.autonomy.delayBetweenApplicationsMs)
    }
  }
}

export const orchestrator = new Orchestrator()

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * When the active-hours window next opens, in words.
 *
 * "Outside active hours" on its own tells the user nothing actionable; on a
 * Sunday with a weekdays-only schedule the honest answer is "Monday at 9:00",
 * and that is what makes the pause legible rather than alarming.
 */
export function describeNextWindow(autonomy: Autonomy, from: Date = new Date()): string {
  const days = autonomy.activeDays.length > 0 ? autonomy.activeDays : [0, 1, 2, 3, 4, 5, 6]
  const start = autonomy.activeHours.start

  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(from)
    candidate.setDate(from.getDate() + offset)
    if (!days.includes(candidate.getDay())) continue
    // Today only counts if the window has not already opened and closed.
    if (offset === 0 && from.getHours() >= start) continue
    const label = offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : DAY_NAMES[candidate.getDay()]
    return `${label} at ${String(start).padStart(2, '0')}:00`
  }
  return 'never - no active days are selected'
}

/**
 * What a finished cycle actually accomplished, in one line.
 *
 * Written to say something useful even when the answer is "nothing", because
 * "nothing, and here is the first thing to change" is a status and a blank line
 * is not.
 */
function summarize(tally: { found: number; scored: number; queued: number; applied: number }): string {
  const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (tally.found === 0 && tally.scored === 0) {
    return `last run ${at}: no new postings found - widen your searches or filters`
  }
  if (tally.queued === 0 && tally.scored > 0) {
    return `last run ${at}: scored ${tally.scored}, none cleared your match threshold`
  }
  return `last run ${at}: ${tally.found} found, ${tally.scored} scored, ${tally.queued} queued`
}
