/**
 * One button that goes from "installed" to "applying unattended".
 *
 * Everything this does could be done by hand across four settings screens, and
 * that was the problem: each screen was a place to stall. This arranges the
 * whole configuration in one call and starts the agent, so the distance between
 * wanting it to run and it running is a single click.
 *
 * It is deliberately opinionated. It switches on real submission, picks
 * thresholds, and clears out sources it cannot actually apply through -- because
 * a configuration that is merely safe but never submits anything is not what
 * this is for.
 */

import { orchestrator } from './orchestrator'
import { setUpSearchesFromProfile } from '@/discovery/setup'
import { deleteRecipe, getProfile, getRecipes, getSettings, profileIsUsable, saveRecipe, saveSettings } from '@/storage/settings'
import { llm } from '@/llm/broker'
import { createLogger } from '@/shared/logger'
import { activity } from '@/shared/activity'
import type { AgentState } from '@/shared/messages'

const log = createLogger('autopilot')

/**
 * Sources the agent can genuinely submit through, unattended.
 *
 * Indeed is in this set now. It was excluded on the grounds that its listings
 * are login-gated adverts, which was true of the old discovery-only stub but is
 * no longer: the adapter drives Indeed's own Easy Apply wizard, and for
 * listings that redirect to a company ATS the discovery pass resolves the real
 * form URL up front so the runner opens that directly.
 */
const APPLYABLE_SOURCES = new Set(['indeed', 'greenhouse', 'lever', 'ashby'])

export type AutopilotResult = {
  started: boolean
  boardsChecked: number
  boardsLive: number
  searches: string[]
  removed: string[]
  settings: { mode: string; minMatchScore: number; dailyCap: number }
  state: AgentState | null
  problems: string[]
}

export async function startAutopilot(): Promise<AutopilotResult> {
  const problems: string[] = []
  activity.begin('discovering', 'Setting everything up', 120_000)

  // --- the two things nothing works without ---------------------------------
  const profile = await getProfile()
  const usable = profileIsUsable(profile)
  if (!usable.ok) {
    throw new Error(
      `Your profile is missing ${usable.missing.join(', ')}. Open Settings, drop your resume on the Profile page, then press this again.`
    )
  }

  const health = await llm.health(true)
  if (health.status !== 'ok') {
    throw new Error(
      health.status === 'needs_login'
        ? 'Sign in to chat.deepseek.com first - the tab is already open. Then press this again.'
        : `The language model is not reachable: ${health.detail}`
    )
  }

  // --- somewhere real to apply ----------------------------------------------
  //
  // Indeed needs no board slugs, so a failed board check is no longer fatal: it
  // costs the secondary ATS stream, not the run. Refusing to start over it was
  // the difference between an agent that works and an error message.
  const setup = await setUpSearchesFromProfile()
  if (setup.boardsLive === 0) {
    problems.push(
      'No company board responded, so this run is Indeed-only. Add a board by hand in Settings > Searches for more volume.'
    )
  }

  // --- drop sources it cannot submit through --------------------------------
  //
  // Naukri's adverts are login-gated, so leaving them on fills the queue with
  // postings that get scored, cost model time, and are then skipped at apply
  // time. (Indeed stays: its Easy Apply wizard is driven directly, and
  // redirect listings resolve to the company ATS at apply time.)
  const removed: string[] = []
  const recipes = await getRecipes()
  const hasApplyable = recipes.some((r) => r.enabled && APPLYABLE_SOURCES.has(r.source))

  for (const recipe of recipes) {
    if (APPLYABLE_SOURCES.has(recipe.source)) continue
    if (!hasApplyable) continue
    if (recipe.enabled) {
      await saveRecipe({ ...recipe, enabled: false })
      removed.push(recipe.name)
    } else if (recipe.boards.length === 0 && recipe.customUrls.length === 0 && recipe.keywords.length === 0) {
      // An empty leftover recipe is pure noise.
      await deleteRecipe(recipe.id)
      removed.push(recipe.name)
    }
  }

  // --- configure for unattended running -------------------------------------
  const settings = await getSettings()
  const configured = await saveSettings({
    ...settings,
    autonomy: {
      ...settings.autonomy,
      enabled: true,
      // 'full' rather than 'gated': the match threshold is meaningless with the
      // scorer switched off, and a gate configured against a score nothing
      // produces parks every application instead of sending it.
      mode: 'full',
      volumeMode: true,
      minMatchScore: 0,
      // Guessed answers are honest about being guesses and carry middling
      // confidence, so the threshold has to sit below them or every form with
      // one unusual question parks instead of going out.
      minFillConfidence: Math.min(settings.autonomy.minFillConfidence, 0.4),
      requireAllRequiredFields: true,
      answerEverything: true,
      // High enough not to be the thing that ends an overnight run. The real
      // limits are how fast pages load and how tolerant the sites are.
      maxApplicationsPerDay: Math.max(settings.autonomy.maxApplicationsPerDay, 400),
      perSiteDailyCap: { ...settings.autonomy.perSiteDailyCap, indeed: 300, generic: 100 },
      // Round the clock: the window exists to avoid odd-hours submissions, and
      // someone asking for this explicitly has decided that is not a concern.
      activeDays: [0, 1, 2, 3, 4, 5, 6],
      activeHours: { start: 0, end: 0 },
      // Tight enough for volume, still jittered so the pacing is not metronomic.
      delayBetweenApplicationsMs: { min: 10_000, max: 25_000 },
      // A run that hits a patch of awkward forms at 2am should push past it
      // rather than stopping for the night after three.
      circuitBreakerFailures: Math.max(settings.autonomy.circuitBreakerFailures, 10),
      // Hundreds of desktop notifications overnight is not a feature.
      notifyOnSubmit: false,
      notifyOnReviewNeeded: false,
    },
    documents: {
      ...settings.documents,
      // Both of these are model calls on the critical path of every single
      // application. Off, the resume PDF is still rendered locally from the
      // profile -- it is just not rewritten per posting.
      tailorResume: false,
      generateCoverLetter: false,
    },
    llm: {
      ...settings.llm,
      // Chrome throttles timers in minimized windows hard enough to starve both
      // Cloudflare's challenge script and DeepSeek's own reply stream -- the
      // two failures that look like "blocked" and "model timeout" at 3am. An
      // unfocused visible window costs nothing overnight and removes both.
      keepWindowMinimized: false,
      // API calls answer in seconds, so a hung one should fail over to the web
      // fallback quickly rather than burning the full web-scale timeout on
      // every retry. Web driver keeps whatever the user configured.
      requestTimeoutMs:
        settings.llm.driver === 'deepseek-web'
          ? settings.llm.requestTimeoutMs
          : Math.min(settings.llm.requestTimeoutMs, 90_000),
    },
    enabledSites: {
      ...settings.enabledSites,
      indeed: true,
      greenhouse: true,
      lever: true,
      ashby: true,
      workable: true,
      smartrecruiters: true,
      workday: true,
      // Indeed redirects to plenty of ATSes with no dedicated adapter. The
      // generic one handles ordinary forms, and refusing them outright would
      // discard a large share of the listings.
      generic: true,
    },
  })

  if (!profile.compensation.expectedCtc.trim()) {
    problems.push('No expected compensation set, so any form asking for it will stop for review.')
  }
  if (profile.workAuthorization.authorizedInCountries.length === 0) {
    problems.push('No work authorization set, so eligibility questions will stop for review.')
  }

  log.info(
    `Autopilot: Indeed-first, ${setup.created.length} search(es), ${setup.boardsLive} live board(s), ` +
      `volume mode, cap ${configured.autonomy.maxApplicationsPerDay}/day`
  )

  const state = await orchestrator.start()

  return {
    started: true,
    boardsChecked: setup.boardsChecked,
    boardsLive: setup.boardsLive,
    searches: setup.created,
    removed,
    settings: {
      mode: configured.autonomy.mode,
      minMatchScore: configured.autonomy.minMatchScore,
      dailyCap: configured.autonomy.maxApplicationsPerDay,
    },
    state,
    problems,
  }
}
