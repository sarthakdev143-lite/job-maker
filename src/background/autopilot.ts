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

/** Sources the agent can genuinely submit through, unattended. */
const APPLYABLE_SOURCES = new Set(['greenhouse', 'lever', 'ashby'])

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
  const setup = await setUpSearchesFromProfile()
  if (setup.boardsLive === 0) {
    throw new Error(
      'None of the company boards responded, so there is nowhere to apply. Add one by hand in Settings > Searches.'
    )
  }

  // --- drop sources it cannot submit through --------------------------------
  //
  // Job-board adverts on Naukri and Indeed are login-gated, so leaving them on
  // fills the queue with postings that get scored, cost model time, and are then
  // skipped at apply time.
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
      mode: 'gated',
      // Lower than the cautious default: a threshold nothing clears is the same
      // as an agent that never applies.
      minMatchScore: Math.min(settings.autonomy.minMatchScore, 50),
      // Guessed answers are honest about being guesses and carry middling
      // confidence, so the threshold has to sit below them or every form with
      // one unusual question parks instead of going out.
      minFillConfidence: Math.min(settings.autonomy.minFillConfidence, 0.5),
      requireAllRequiredFields: true,
      answerEverything: true,
      maxApplicationsPerDay: Math.max(settings.autonomy.maxApplicationsPerDay, 25),
      // Round the clock: the window exists to avoid odd-hours submissions, and
      // someone asking for this explicitly has decided that is not a concern.
      activeDays: [0, 1, 2, 3, 4, 5, 6],
      activeHours: { start: 0, end: 0 },
    },
    enabledSites: {
      ...settings.enabledSites,
      greenhouse: true,
      lever: true,
      ashby: true,
      workable: true,
      smartrecruiters: true,
    },
  })

  if (!profile.compensation.expectedCtc.trim()) {
    problems.push('No expected compensation set, so any form asking for it will stop for review.')
  }
  if (profile.workAuthorization.authorizedInCountries.length === 0) {
    problems.push('No work authorization set, so eligibility questions will stop for review.')
  }

  log.info(
    `Autopilot: ${setup.boardsLive} live board(s), ${setup.created.length} search(es), gated at ${configured.autonomy.minMatchScore}`
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
