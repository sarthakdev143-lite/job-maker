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

import { byCheapestFirst, runDiscovery, unscoredJobs } from '@/discovery'
import { getRecipes } from '@/storage/settings'
import { scoreJob } from '@/matching/scorer'
import { applyToJob } from '@/runner/apply-machine'
import { PermissionError } from '@/shared/injection'
import { dailyCounterKey, withinActiveWindow } from '@/runner/autonomy-gate'
import { applicationsRepo, jobsRepo, logsRepo } from '@/storage/db'
import { getCounter, getProfile, getSettings, profileIsUsable, pruneCounters } from '@/storage/settings'
import { llm } from '@/llm/broker'
import { createLogger } from '@/shared/logger'
import { dayKey, errorMessage } from '@/shared/util'
import { nextGap } from '@/human/pacing'
import { durableSleep, startHeartbeat, type Heartbeat } from '@/shared/keepalive'
import { closeAllWorkerWindows } from '@/shared/windows'
import { beat, clearRunState, isHalted, loadBreakerCount, loadRunState, looksInterrupted, saveBreakerCount, saveRunState, setHalted } from './run-state'
import {
  emptySummary,
  saveCycleSummary,
  summarizeCycle,
  type CycleOutcome,
  type CycleSummary,
} from './run-history'
import type { AgentState } from '@/shared/messages'
import { activity, idleStep } from '@/shared/activity'
import type { Autonomy, Job, Settings } from '@/storage/schemas'

const log = createLogger('agent')

/**
 * How long to wait between sweeps when the agent is running continuously.
 *
 * Short, because most sweeps that find nothing are cheap, and a paused run
 * (capped out, or outside active hours) needs to notice promptly when the
 * reason it paused has passed.
 */
const IDLE_CYCLE_GAP_MS = 60_000

/** An application left in `running` longer than this died with its worker. */
const STALE_RUNNING_MS = 10 * 60_000

/**
 * How one application attempt ended, for the cycle funnel.
 *
 * `parked` means the gate held it for review (or the submit went unconfirmed);
 * `skipped` means the runner never had a form to fill (no form, vendor off);
 * `stopped` means the run itself halted (cap, hours, breaker, stop button) and
 * carries no funnel count.
 */
type ApplyAttempt = 'submitted' | 'parked' | 'skipped' | 'failed' | 'stopped'

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
  fix?: 'profile' | 'searches' | 'matching' | 'model' | 'autonomy' | 'advanced'
  /** A failing blocker refuses to start; a failing warning only explains. */
  blocking: boolean
}

class Orchestrator {
  private state: AgentState = {
    running: false,
    phase: 'idle',
    currentJobId: '',
    currentStep: '',
    step: idleStep(),
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
  /**
   * Keeps the service worker resident for as long as the agent is working.
   *
   * Without it Chrome evicts the worker after ~30 idle seconds and the run
   * simply stops mid-flight, leaving a minimized window open and nothing in the
   * log to say why.
   */
  private heartbeat: Heartbeat | null = null
  /**
   * Whether a sweep loop is already running in this worker.
   *
   * Set synchronously, before any `await`, because that is the whole point.
   * `start` and `resumeIfInterrupted` both guarded on `state.running`, which
   * they only set after awaiting storage and settings -- so the one-minute
   * alarm and the wake-time resume could both pass the guard in that gap and
   * each begin their own loop. Two loops meant two applications in flight at
   * once, each opening windows, and neither finishing cleanly.
   */
  private loopActive = false
  /**
   * Applications attempted since this run started.
   *
   * Feeds the fatigue curve: a person applying for jobs all afternoon slows
   * down, and a gap distribution that is as brisk at application two hundred as
   * at application one is a pattern of its own.
   */
  private appliedThisSession = 0

  constructor() {
    // Every change to what the agent is doing -- including the fine-grained
    // notes from the model driver and the form filler -- becomes a state update
    // the panel can see. This is what turns silent waiting into visible work.
    activity.onChange((step) => this.patch({ step, currentStep: step.label }))
  }

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

    // Not blocking: the built-in boards work without it, and refusing to start
    // over a permission most runs never need would be worse than the warning.
    // It is here because a run that hits an ungranted site fails every single
    // application with the same unreadable connection error, and nothing in the
    // UI previously connected that to a grant the user can make in one click.
    const allSites = await chrome.permissions
      .contains({ origins: ['https://*/*'] })
      .catch(() => true)
    checks.push({
      id: 'siteAccess',
      label: 'The agent can reach company-hosted forms',
      ok: allSites,
      detail: allSites
        ? 'Granted for all sites'
        : 'Only the built-in job boards. Applications on a company-hosted careers page will fail until you grant access in Settings -> Advanced -> Site access.',
      fix: 'advanced',
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
    if (this.state.running || this.loopActive) return this.getState()
    this.loopActive = true

    // Pressing Start is the only thing that lifts a kill switch. Clearing it
    // anywhere else -- on a resume, on a worker restart, on the cycle alarm --
    // is what made Stop last five minutes.
    await setHalted(false)

    const settings = await getSettings()
    const checks = await this.preflight()
    const blockers = checks.filter((c) => c.blocking && !c.ok)

    if (blockers.length > 0) {
      const message = blockers.map((c) => c.detail).join('. ')
      this.loopActive = false
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
    await saveBreakerCount(0)
    const startedAt = Date.now()
    this.patch({ running: true, phase: 'idle', lastError: '', startedAt })
    await saveRunState({ running: true, startedAt, manual: true })
    this.beginHeartbeat()
    activity.begin('discovering', 'Starting up', 30_000)
    log.info(`Agent started in ${settings.autonomy.mode} mode`)

    void this.runForever()
    return this.getState()
  }

  async stop(): Promise<AgentState> {
    this.stopRequested = true
    this.loopActive = false
    // Sticky, exactly as for the kill switch: this is the button the user
    // actually presses, and without the flag the cycle alarm restarted the run
    // five minutes later as if Stop had never happened.
    await setHalted(true)
    await saveBreakerCount(0)
    this.patch({ phase: 'stopped' })
    activity.begin('stopped', 'Stopping after the current step')
    log.info('Stop requested')
    await this.cycleInFlight?.catch(() => {})
    this.endHeartbeat()
    const closed = await closeAllWorkerWindows()
    if (closed > 0) log.info(`Closed ${closed} working window(s)`)
    await clearRunState()
    this.patch({ running: false, phase: 'idle', currentJobId: '' })
    activity.end('Stopped')
    return this.getState()
  }

  /** Immediate halt: stop the loop and close any worker windows we opened. */
  async killSwitch(): Promise<AgentState> {
    this.stopRequested = true
    this.loopActive = false
    this.endHeartbeat()
    await setHalted(true)
    await clearRunState()
    this.patch({ running: false, phase: 'stopped', currentJobId: '' })
    activity.end('Halted by the kill switch')
    log.warn('Kill switch engaged')
    await this.reapOrphanWindows()
    return this.getState()
  }

  /** Has a person pressed Stop and not pressed Start since? */
  async halted(): Promise<boolean> {
    return isHalted()
  }

  /**
   * Close the background windows the agent works in.
   *
   * Every worker window is opened minimized with a single tab, and the apply
   * machine closes its own in a `finally`. That `finally` does not run when the
   * service worker is evicted mid-application, so an interrupted run leaves a
   * minimized window behind -- invisible to the user, and one more every time.
   * Sweeping on wake keeps an overnight run from accumulating dozens of them.
   */
  private async reapOrphanWindows(): Promise<number> {
    // Closes only windows this agent recorded opening. The previous version
    // closed any minimized single-tab window, which is a fair description of
    // an agent worker window and also of something the user had minimized and
    // was still using.
    return closeAllWorkerWindows()
  }

  /* ------------------------------------------------------------- keepalive */

  private beginHeartbeat(): void {
    this.heartbeat?.stop()
    // `beat` writes to chrome.storage, which doubles as the extension API call
    // that resets Chrome's idle timer -- so one interval both keeps the worker
    // resident and records that the run is still alive.
    this.heartbeat = startHeartbeat({ ticker: beat })
  }

  private endHeartbeat(): void {
    this.heartbeat?.stop()
    this.heartbeat = null
  }

  /**
   * Pick a run back up after the worker was replaced.
   *
   * Called on every service worker wake. A run that was in progress resumes
   * immediately rather than waiting for the next periodic alarm, which is the
   * difference between losing a minute of an overnight run and losing half an
   * hour of it.
   */
  async resumeIfInterrupted(): Promise<boolean> {
    if (this.state.running || this.loopActive) return false
    // Claimed before the first await, so a concurrent caller cannot slip past.
    this.loopActive = true

    const persisted = await loadRunState()
    if (!persisted.running) {
      this.loopActive = false
      return false
    }

    const settings = await getSettings()
    if (!settings.autonomy.enabled || (await isHalted())) {
      // The user switched autonomy off, or pressed Stop, while the worker was
      // away. Honour that rather than resurrecting a run they have already
      // called off.
      this.loopActive = false
      await clearRunState()
      return false
    }

    const gap = Date.now() - persisted.lastBeatAt
    log.warn(
      looksInterrupted(persisted)
        ? `Resuming a run interrupted ${Math.round(gap / 60_000)} minute(s) ago`
        : 'Resuming after the service worker restarted'
    )

    const reaped = await this.reapOrphanWindows()
    if (reaped > 0) log.info(`Closed ${reaped} window(s) left behind by the interrupted run`)

    this.stopRequested = false
    this.manualRun = persisted.manual
    // Restored, not reset: the count survived in storage precisely so a site
    // failing across evictions still trips the breaker instead of getting a
    // fresh three strikes every thirty seconds.
    this.consecutiveFailures = await loadBreakerCount()
    this.patch({ running: true, phase: 'idle', lastError: '', startedAt: persisted.startedAt ?? Date.now() })
    await saveRunState({ running: true, startedAt: persisted.startedAt, manual: persisted.manual })
    this.beginHeartbeat()

    void this.runForever()
    return true
  }

  /**
   * Sweep after sweep, until stopped.
   *
   * `start` used to kick off exactly one cycle and then go quiet, leaning on a
   * 30-minute alarm for everything after it. For a run meant to work through
   * the night that is mostly downtime, so the loop now continues on its own and
   * the alarm is only a safety net. A short gap between sweeps also means a
   * cycle that paused -- outside active hours, or at the daily cap -- starts
   * working again on its own the moment that reason expires.
   */
  private async runForever(): Promise<void> {
    try {
      while (!this.stopRequested && this.state.running) {
        try {
          await this.runCycle()
        } catch (e) {
          // One bad cycle must never end the night. The cycle itself catches
          // nearly everything, so reaching here means something unexpected
          // escaped -- log it loudly and keep sweeping.
          const message = errorMessage(e)
          this.patch({ phase: 'error', lastError: message })
          log.error(`Run loop survived a cycle failure: ${message}`)
        }
        if (this.stopRequested || !this.state.running) break
        await durableSleep(IDLE_CYCLE_GAP_MS, { shouldStop: this.shouldStop })
      }
    } finally {
      this.loopActive = false
    }
  }

  /* ----------------------------------------------------------------- cycle */

  /**
   * Run one full cycle. Safe to call when a cycle is already in flight.
   *
   * The scheduler calls this without arguments, so a cycle it triggers respects
   * the active-hours window even if the run was originally started by hand.
   */
  async runCycleNow(options: { manual?: boolean } = {}): Promise<void> {
    if (this.cycleInFlight) return this.cycleInFlight
    // Assigned only when no loop owns this run: the alarm fires every five
    // minutes while a hand-started run is in flight, and flipping manualRun to
    // false on each tick silently converted an 11pm manual run into a scheduled
    // one that then paused itself at the window edge.
    if (!this.loopActive) this.manualRun = options.manual ?? false
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
    const startedAt = Date.now()
    const tally = {
      ...emptySummary(),
      perRecipe: {} as CycleSummary['perRecipe'],
      gateReasons: {} as CycleSummary['gateReasons'],
    }
    let stoppedEarly = false

    try {
      await pruneCounters(dayKey())
      const settings = await getSettings()

      if (!this.manualRun && !withinActiveWindow(settings.autonomy)) {
        const when = describeNextWindow(settings.autonomy)
        this.patch({ phase: 'paused' })
        activity.begin('paused', `Waiting for active hours - next run ${when}`)
        log.info(`Outside active hours; the next scheduled run is ${when}. Press Start to run now anyway.`)
        await this.persistCycle(tally, startedAt, 'paused-hours')
        return
      }

      // --- apply what is already queued ------------------------------------
      //
      // First, not last. Discovery used to open the cycle unconditionally: it
      // opens a window per search URL, scrolls it and closes it again, which is
      // minutes of visible noise, and a queue of jobs sat untouched behind it
      // every single cycle. The agent's job is to apply; searching is only how
      // the queue gets refilled once it runs dry.
      const standingQueue = await this.applyQueue()
      for (const r of standingQueue) this.countApplyResult(tally, r.result, r.gateReasons)

      if (this.shouldStop()) {
        stoppedEarly = true
        return
      }

      // --- score, and apply the moment something qualifies ----------------
      //
      // Scoring the whole batch before applying to any of it meant the first
      // application was minutes away and the log sat silent in between, which
      // reads as a hung agent. Applying as soon as a job clears the bar gets
      // the first one out in about the time it takes to score one posting.
      const toScore = await unscoredJobs(30)
      if (toScore.length > 0) {
        this.patch({ phase: 'scoring' })
        activity.begin('scoring', `Scoring ${toScore.length} posting(s)`, 15_000)
        const profile = await getProfile()
        const volumeMode = settings.autonomy.volumeMode
        const threshold = volumeMode ? 0 : settings.autonomy.minMatchScore
        let index = 0

        for (const job of toScore) {
          if (this.shouldStop()) return
          index++
          this.patch({ phase: 'scoring', currentJobId: job.id })
          activity.begin(
            'scoring',
            volumeMode
              ? `Queueing ${index} of ${toScore.length}: ${job.title}`
              : `Scoring ${index} of ${toScore.length}: ${job.title}`,
            15_000
          )

          let score
          if (volumeMode) {
            // The prefilter has already enforced the user's title, location,
            // work-mode and blocklist rules, and this job passed them. Asking
            // the model to second-guess that costs a serialised round-trip and
            // can only ever subtract from a list the user asked to apply to in
            // full, so it is skipped outright rather than run and ignored.
            score = {
              score: 100,
              shouldApply: true,
              reasons: ['volume mode: matched the search rules'],
              concerns: [],
              seniority: 'unknown' as const,
            }
          } else {
            try {
              score = await scoreJob(job, profile, settings)
            } catch (e) {
              tally.scoreFailed++
              log.warn(`Could not score ${job.title} at ${job.company}: ${errorMessage(e)}`, undefined, job.id)
              continue // left as 'new', so the next cycle retries it
            }
          }

          tally.scored++
          tally.bestScore = Math.max(tally.bestScore, score.score)
          const queue = score.shouldApply && score.score >= threshold

          await jobsRepo.update(job.id, {
            status: queue ? 'queued' : 'rejected',
            matchScore: score.score,
            matchReasons: score.reasons,
            matchConcerns: score.concerns,
            rejectReason: queue ? '' : `scored ${score.score}: ${score.concerns.join('; ') || 'below threshold'}`,
            scoredAt: Date.now(),
          })

          log.info(
            `${score.score}/100 ${queue ? 'QUEUED' : 'passed over'} - ${job.title} at ${job.company}` +
              (queue ? '' : ` (needs ${threshold}${score.concerns.length ? `; ${score.concerns[0]}` : ''})`),
            undefined,
            job.id
          )

          if (!queue) continue
          tally.queued++

          const updated = await jobsRepo.get(job.id)
          if (updated) {
            const result = await this.applyOne(updated, settings)
            this.countApplyResult(tally, result.result, result.gateReasons)
            if (!result.carryOn) {
              stoppedEarly = true
              return
            }
          }
        }
      }
      if (this.shouldStop()) {
        stoppedEarly = true
        return
      }

      // --- refill the queue, only once there is nothing left to apply -------
      //
      // Deliberately the last thing a cycle does. If jobs are still queued the
      // agent has work in hand and another sweep would only add to a backlog it
      // is not getting through -- which is exactly what "it just opens Indeed,
      // scrolls and closes it" looked like from the outside.
      const stillQueued = (await jobsRepo.byStatus('queued', 5)).length
      const stillUnscored = (await unscoredJobs(1)).length

      if (stillQueued > 0 || stillUnscored > 0) {
        log.info(`Skipping search: ${stillQueued} job(s) still queued and ${stillUnscored} unscored`)
      } else {
        this.patch({ phase: 'discovering' })
        activity.begin('discovering', 'Queue is empty - searching job boards', 120_000)
        const discovery = await runDiscovery({ shouldStop: this.shouldStop })
        tally.found = discovery.stored
        tally.duplicates = discovery.duplicates
        tally.rejected = discovery.rejected
        tally.blocked = discovery.blocked
        tally.perRecipe = discovery.byRecipe
        log.info(
          `Discovery: ${discovery.stored} new, ${discovery.duplicates} duplicate, ${discovery.rejected} filtered out` +
            (discovery.blocked > 0 ? `, ${discovery.blocked} recipe(s) blocked` : '')
        )
      }
    } catch (e) {
      const message = errorMessage(e)
      this.patch({ phase: 'error', lastError: message })
      log.error(`Cycle failed: ${message}`)
    } finally {
      await logsRepo.trim()
      await this.refreshCounts()
      await this.persistCycle(tally, startedAt, stoppedEarly ? 'stopped' : this.outcomeFromPhase())
      // 'paused' and 'error' both carry the explanation for why a cycle stopped
      // early. Resetting them here is what made a stalled agent look idle with
      // no reason given. The status line itself is ended by persistCycle, which
      // writes the same note it persists.
      const explained = this.state.phase === 'error' || this.state.phase === 'paused'
      if (this.state.running && !explained) {
        this.patch({ phase: 'idle', currentJobId: '' })
      }
    }
  }

  /** Fold one application attempt into the cycle funnel. */
  private countApplyResult(
    tally: Omit<CycleSummary, 'id' | 'startedAt' | 'endedAt' | 'outcome' | 'note'>,
    result: ApplyAttempt,
    gateReasons: string[]
  ): void {
    if (result === 'submitted') tally.submitted++
    else if (result === 'parked') tally.parked++
    else if (result === 'skipped') tally.skipped++
    else if (result === 'failed') tally.failed++
    if (result === 'submitted' || result === 'parked' || result === 'skipped' || result === 'failed') {
      tally.attempted++
    }
    for (const reason of gateReasons) {
      tally.gateReasons[reason] = (tally.gateReasons[reason] ?? 0) + 1
    }
  }

  /** Name how this cycle ended, for the persisted run record. */
  private outcomeFromPhase(): CycleOutcome {
    if (this.state.phase === 'paused') return 'paused-cap'
    if (this.state.phase === 'error') {
      return /in a row|circuit/i.test(this.state.lastError) ? 'error-circuit' : 'error'
    }
    return 'completed'
  }

  /** Write the funnel to storage so the morning after has one screen to read. */
  private async persistCycle(
    tally: Omit<CycleSummary, 'id' | 'startedAt' | 'endedAt' | 'outcome' | 'note'>,
    startedAt: number,
    outcome: CycleOutcome
  ): Promise<void> {
    const note = summarizeCycle({ ...tally, outcome, note: '' })
    await saveCycleSummary({ ...tally, startedAt, endedAt: Date.now(), outcome, note })
    // The live status line still uses the legacy one-line shape.
    if (this.state.running && this.state.phase !== 'error' && this.state.phase !== 'paused') {
      activity.end(note)
    }
  }

  /** Apply to one job, with every reason to stop the whole run checked first.
   *
   * Returns false when the run should end -- a cap reached, the window closed,
   * the circuit breaker tripped -- so both callers can stop cleanly rather than
   * each reimplementing the same guards.
   */
  private async applyOne(
    job: Job,
    settings: Settings
  ): Promise<{ carryOn: boolean; result: ApplyAttempt; gateReasons: string[] }> {
    if (this.shouldStop()) return { carryOn: false, result: 'stopped', gateReasons: [] }

    // A job parked for review stays queued so the user can still see it, but
    // re-running it every cycle would redo the model work and re-park it for
    // ever. Only untouched jobs and genuinely queued ones are applied to.
    const existing = await applicationsRepo.byJob(job.id)
    if (existing && existing.status !== 'queued') {
      // ...unless the worker died mid-application. Eviction runs before the
      // machine's `finally`, so the record is stuck at `running` while its job
      // sits `queued`: retried every cycle, skipped every time, for ever.
      // Reclaim it once the beat is old enough that no live attempt can own it.
      if (existing.status === 'running' && Date.now() - existing.updatedAt > STALE_RUNNING_MS) {
        log.warn(`Reclaiming ${job.title}: application stuck in 'running'; requeueing`, undefined, job.id)
        await applicationsRepo.update(existing.id, { status: 'queued' })
        await applicationsRepo.addTimeline(existing.id, 'reclaim', 'worker died mid-application; retrying', 'warn')
      } else {
        log.debug(`Skipping ${job.title}: application already ${existing.status}`, undefined, job.id)
        return { carryOn: true, result: 'skipped', gateReasons: [`already ${existing.status}`] }
      }
    }

    const appliedToday = await getCounter(dailyCounterKey())
    if (appliedToday >= settings.autonomy.maxApplicationsPerDay) {
      log.info(`Daily cap reached (${appliedToday}/${settings.autonomy.maxApplicationsPerDay}); pausing`)
      this.patch({ phase: 'paused' })
      activity.begin('paused', `Daily cap reached (${appliedToday} sent today)`)
      return { carryOn: false, result: 'stopped', gateReasons: [] }
    }

    if (!this.manualRun && !withinActiveWindow(settings.autonomy)) {
      log.info('Active hours ended mid-run; pausing')
      this.patch({ phase: 'paused' })
      activity.begin('paused', 'Active hours ended')
      return { carryOn: false, result: 'stopped', gateReasons: [] }
    }

    this.patch({ phase: 'applying', currentJobId: job.id })
    activity.begin('applying', `Applying: ${job.title} at ${job.company}`, 180_000)

    let result: ApplyAttempt = 'failed'
    let gateReasons: string[] = []
    try {
      // A hard ceiling, not a polled one. `shouldStop` is only read between
      // steps, so a job blocked inside a three-minute model call that is
      // retried twice and then failed over never reaches a checkpoint -- which
      // is what "stuck for fifteen minutes with no log line" was.
      const budgetMs = Math.max(60_000, settings.autonomy.maxApplicationMs)
      let budgetTimer: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        applyToJob(job.id, {
          shouldStop: this.shouldStop,
          ignoreActiveHours: this.manualRun,
          // The step notes reach the panel through `activity`; this only keeps the
          // job id current so the UI can link to what is being worked on.
          onStep: () => this.patch({ currentJobId: job.id }),
        }),
        new Promise<never>((_, reject) => {
          budgetTimer = setTimeout(
            () =>
              reject(
                new Error(
                  `Gave up after ${Math.round(budgetMs / 1000)}s on this application. ` +
                    `Usually a model call that is timing out and retrying; lower the request ` +
                    `timeout or retries in Settings -> Model, or raise this budget in Autonomy.`
                )
              ),
            budgetMs
          )
        }),
      ]).finally(() => {
        if (budgetTimer !== undefined) clearTimeout(budgetTimer)
      })

      if (outcome.submitted) {
        result = 'submitted'
      } else if (outcome.decision.action === 'review') {
        result = 'parked'
        gateReasons = outcome.decision.reasons
      } else {
        result = 'skipped'
        gateReasons = outcome.decision.reasons
      }
      if (outcome.application.status === 'failed') result = 'failed'

      this.consecutiveFailures = outcome.application.status === 'failed' ? this.consecutiveFailures + 1 : 0
      await saveBreakerCount(this.consecutiveFailures)

      if (this.consecutiveFailures >= settings.autonomy.circuitBreakerFailures) {
        const message = `Stopping: ${this.consecutiveFailures} applications failed in a row`
        log.error(message)
        this.patch({ phase: 'error', lastError: message, running: false })
        this.stopRequested = true
        // The trip is deliberate: clear the persisted flag so the next wake
        // does not resurrect the run it just killed. The cycle summary already
        // recorded the outcome for the morning after.
        await clearRunState()
        return { carryOn: false, result, gateReasons }
      }
    } catch (e) {
      // Chrome refusing the site is a standing condition, not a bad job. Every
      // remaining application would fail identically, so stop and say what to
      // click -- a queue of a hundred identical connection errors is how this
      // looked like a broken extension rather than a missing permission.
      if (e instanceof PermissionError) {
        const message = errorMessage(e)
        log.error(message)
        this.patch({ phase: 'error', lastError: message, running: false })
        this.stopRequested = true
        activity.end('Stopped: no access to the job site')
        await clearRunState()
        return { carryOn: false, result: 'skipped', gateReasons: [message] }
      }
      this.consecutiveFailures++
      await saveBreakerCount(this.consecutiveFailures)
      log.error(`Unexpected failure on ${job.title}`, { error: errorMessage(e) }, job.id)
    }

    await this.refreshCounts()
    if (this.shouldStop()) return { carryOn: false, result, gateReasons }

    // Chunked rather than one long sleep: a plain setTimeout of up to three
    // minutes is exactly the idle stretch Chrome evicts the worker during, and
    // the run would never wake from it.
    this.appliedThisSession++
    const gap = nextGap(settings.autonomy.delayBetweenApplicationsMs, {
      sessionMs: Date.now() - (this.state.startedAt ?? Date.now()),
      completed: this.appliedThisSession,
    })
    // Said out loud. This wait is up to three minutes by default and used to
    // leave the last application's message on screen the whole time, which is
    // indistinguishable from a hang -- and it is the single most common reason
    // a working agent looked stuck.
    activity.begin('paused', gap.reason, gap.ms + 10_000)
    if (gap.isBreak) log.info(gap.reason)
    await durableSleep(gap.ms, { shouldStop: this.shouldStop })
    return { carryOn: true, result, gateReasons }
  }

  private async applyQueue(): Promise<Array<{ result: ApplyAttempt; gateReasons: string[] }>> {
    const settings = await getSettings()
    const queued = (await jobsRepo.byStatus('queued', 100)).sort(byCheapestFirst)
    if (queued.length === 0) return []

    this.patch({ phase: 'applying' })
    activity.begin('applying', `${queued.length} job(s) queued`, 180_000)

    const results: Array<{ result: ApplyAttempt; gateReasons: string[] }> = []
    for (const job of queued) {
      const one = await this.applyOne(job, settings)
      results.push({ result: one.result, gateReasons: one.gateReasons })
      if (!one.carryOn) return results
    }
    return results
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
