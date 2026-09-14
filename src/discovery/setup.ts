/**
 * Building searches from the profile.
 *
 * Two things have to be true for the agent to actually land applications, and
 * this is where both are arranged:
 *
 *   1. It needs real company boards on Greenhouse, Lever or Ashby. Those are
 *      genuine forms it can fill. Job-board adverts on Naukri or Indeed are
 *      not: applying there is a button behind a login, so the agent can find
 *      those jobs but cannot submit to them.
 *   2. Every board slug must be verified before it is used. Asking a model to
 *      recall them produced nothing usable, and a wrong slug is a silent 404
 *      that looks exactly like "no jobs today".
 *
 * So this combines whatever the model suggests with a shipped catalogue, checks
 * every candidate against the real API, and keeps only the boards that answer.
 */

import { suggestRules } from '@/matching/suggest'
import { getProfile, getRecipes, getSettings, saveRecipe } from '@/storage/settings'
import { BOARD_CATALOGUE, matchCatalogue, validateBoards, type BoardSource, type CatalogueEntry } from './board-catalogue'
import { createLogger } from '@/shared/logger'
import { activity } from '@/shared/activity'
import { uid } from '@/shared/util'
import type { SearchRecipe } from '@/storage/schemas'

const log = createLogger('setup')

/** Enough boards to produce a steady stream without hammering anyone. */
const MAX_BOARDS_PER_SOURCE = 25
const MAX_CANDIDATES = 70

export type SetupResult = {
  created: string[]
  /** True when nothing could be built and the user has to add one by hand. */
  needsManual: boolean
  /** Boards checked and kept, so the user can see the list is real. */
  boardsChecked: number
  boardsLive: number
  notes: string[]
}

export async function setUpSearchesFromProfile(): Promise<SetupResult> {
  const [settings, profile, existing] = await Promise.all([getSettings(), getProfile(), getRecipes()])

  activity.begin('discovering', 'Working out where to look', 90_000)
  const suggestion = await suggestRules(profile, settings)
  const keywords = suggestion.searchKeywords.length > 0 ? suggestion.searchKeywords : suggestion.titleIncludes

  // The model's guesses go in first -- when it does name a board it is usually
  // one it has seen -- and the catalogue fills the rest.
  const fromModel: CatalogueEntry[] = [
    ...suggestion.greenhouseBoards.map((slug) => ({ slug, source: 'greenhouse' as const, tags: [] })),
    ...suggestion.leverBoards.map((slug) => ({ slug, source: 'lever' as const, tags: [] })),
  ]

  const india = /india/i.test(profile.country)
  const candidates = dedupe([
    ...fromModel,
    ...matchCatalogue([...keywords, ...profile.skills].map(String), { india, limit: MAX_CANDIDATES }),
  ]).slice(0, MAX_CANDIDATES)

  activity.relabel(`Checking ${candidates.length} company boards`)
  const checks = await validateBoards(candidates)
  const live = checks.filter((c) => c.live)

  const created: string[] = []
  const notes: string[] = []

  const bySource = (source: BoardSource): string[] =>
    live
      .filter((c) => c.source === source)
      .sort((a, b) => b.jobCount - a.jobCount)
      .slice(0, MAX_BOARDS_PER_SOURCE)
      .map((c) => c.slug)

  const base = {
    keywords,
    location: '',
    remoteOnly: false,
    customUrls: [],
    maxResultsPerRun: 40,
    lastRunAt: null,
  }

  for (const source of ['greenhouse', 'lever', 'ashby'] as const) {
    const boards = bySource(source)
    if (boards.length === 0) continue

    // Replace a previous auto-built recipe for this source rather than stacking
    // a new one beside it every time the user presses the button.
    const previous = existing.find((r) => r.source === source && r.name.startsWith('Verified '))
    const recipe: SearchRecipe = {
      ...base,
      id: previous?.id ?? uid('recipe'),
      name: `Verified ${source} boards`,
      enabled: true,
      source,
      boards,
    }
    await saveRecipe(recipe)
    created.push(`${boards.length} ${source} board(s): ${boards.slice(0, 6).join(', ')}${boards.length > 6 ? '…' : ''}`)
  }

  const hasApplyableBoards = created.length > 0

  // Naukri is worth searching for visibility, but the agent cannot submit
  // there, so it is only added when there is nothing better -- otherwise it
  // fills the queue with jobs that will be skipped at apply time.
  if (!hasApplyableBoards && india && keywords.length > 0) {
    const recipe: SearchRecipe = {
      ...base,
      id: uid('recipe'),
      name: `Naukri - ${keywords[0]}`,
      enabled: true,
      source: 'naukri',
      boards: [],
      location: profile.city,
      maxResultsPerRun: 30,
    }
    await saveRecipe(recipe)
    created.push(`Naukri search for ${keywords.join(', ')}${profile.city ? ` in ${profile.city}` : ''}`)
    notes.push(
      'Naukri is search-only: applying there needs a signed-in session and happens through their chatbot, ' +
        'so the agent will find those jobs but cannot submit them for you.'
    )
  } else if (india) {
    notes.push(
      'Naukri was left out on purpose: the agent can find jobs there but cannot submit applications, ' +
        'and the verified boards above are ones it can actually apply on.'
    )
  }

  if (!hasApplyableBoards) {
    notes.push(
      `None of the ${checks.length} candidate boards responded. Add a company by hand in Searches - the slug is ` +
        'the last part of their careers URL, for example boards.greenhouse.io/<slug>.'
    )
  }

  log.info(
    `Setup: ${live.length} live board(s) of ${checks.length} checked, ${created.length} search(es) created`
  )
  activity.end(`Set up ${created.length} search(es) from ${live.length} verified board(s)`)

  return {
    created,
    needsManual: created.length === 0,
    boardsChecked: checks.length,
    boardsLive: live.length,
    notes,
  }
}

function dedupe(entries: CatalogueEntry[]): CatalogueEntry[] {
  const seen = new Set<string>()
  const out: CatalogueEntry[] = []
  for (const entry of entries) {
    const slug = entry.slug.trim().toLowerCase()
    if (!slug) continue
    const key = `${entry.source}:${slug}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...entry, slug })
  }
  return out
}

/** The whole catalogue, checked. Powers the "which boards work?" view. */
export async function checkAllBoards(): Promise<Awaited<ReturnType<typeof validateBoards>>> {
  activity.begin('discovering', `Checking all ${BOARD_CATALOGUE.length} known boards`, 60_000)
  const checks = await validateBoards(BOARD_CATALOGUE)
  activity.end(`${checks.filter((c) => c.live).length} of ${checks.length} boards are live`)
  return checks
}

/**
 * Last resort when the model will not name any boards: switch on whatever the
 * user already has, so the agent at least has somewhere to look.
 */
export async function enableExistingSearches(): Promise<number> {
  const recipes = await getRecipes()
  let enabled = 0
  for (const recipe of recipes) {
    if (recipe.enabled) continue
    await saveRecipe({ ...recipe, enabled: true })
    enabled++
  }
  return enabled
}
