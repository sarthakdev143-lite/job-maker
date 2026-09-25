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
import { getProfile, getRecipes, getSettings, saveRecipe, saveSettings } from '@/storage/settings'
import { BOARD_CATALOGUE, matchCatalogue, validateBoards, type BoardSource, type CatalogueEntry } from './board-catalogue'
import { createLogger } from '@/shared/logger'
import { activity } from '@/shared/activity'
import { errorMessage, uid } from '@/shared/util'
import { DEFAULT_ROLE_PHRASES } from './sources/indeed'
import type { Profile, SearchRecipe, SuggestedRules } from '@/storage/schemas'

const log = createLogger('setup')

/**
 * Enough boards to produce a steady stream without hammering anyone.
 *
 * One board is one HTTP request to a public JSON endpoint, and a sweep of fifty
 * takes under two minutes, so the ceiling is politeness rather than cost. It
 * was raised once the catalogue grew past a hundred entries: leaving it at
 * twenty-five meant everything added beyond that was catalogued and never
 * actually searched.
 */
const MAX_BOARDS_PER_SOURCE = 40
// The catalogue is bigger than this was, and checking a board is one HTTP
// request that the ranking then uses to sort the useless ones to the bottom.
// Capping below the catalogue size threw away boards before anything had
// looked at them.
const MAX_CANDIDATES = 160

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

  // The model is an improvement here, not a requirement.
  //
  // Setting up searches asks it for search phrases and for board slugs it
  // happens to know. Neither is load-bearing: the catalogue supplies boards,
  // and a profile that names a current title and some skills already says what
  // to search for. It used to abort the whole thing, so an expired chat session
  // -- which is a thing that happens overnight, to nobody's fault -- left the
  // user unable to build searches at all, with an error about a chat provider
  // in answer to a question about job boards.
  const setupNotes: string[] = []
  let suggestion: SuggestedRules
  try {
    suggestion = await suggestRules(profile, settings)
  } catch (e) {
    suggestion = suggestionFromProfile(profile)
    log.warn(`Building searches without the model: ${errorMessage(e)}`)
    setupNotes.push(
      'The model was unavailable, so these were built from your profile and the board catalogue alone. Run this again once it is reachable and the searches will be sharper.'
    )
  }
  const keywords = suggestion.searchKeywords.length > 0 ? suggestion.searchKeywords : suggestion.titleIncludes

  // The model's guesses go in first -- when it does name a board it is usually
  // one it has seen -- and the catalogue fills the rest.
  const fromModel: CatalogueEntry[] = [
    ...suggestion.greenhouseBoards.map((slug) => ({ slug, source: 'greenhouse' as const, tags: [] })),
    ...suggestion.leverBoards.map((slug) => ({ slug, source: 'lever' as const, tags: [] })),
  ]

  // Everything the model worked out about what this person should and should
  // not be shown, written down where the filters can see it.
  //
  // Two of these were being computed and thrown away. The suggested title
  // excludes never reached the rules, so a search for a principal architect
  // came back full of account executives and pre-sales engineers -- every one
  // of them a real posting, none of them this person's job. And a remote job is
  // only useful if the user may work from where it is open, which nobody thinks
  // to configure until a queue full of "Remote - US" shows them why it matters.
  //
  // Only ever filled in when the user has left them empty: a rule someone set
  // by hand outranks anything suggested here.
  const rules = { ...settings.matchRules }
  const applied: string[] = []

  if (rules.remoteEligibility.length === 0 && profile.country.trim()) {
    rules.remoteEligibility = [profile.country.trim()]
    applied.push(`remote roles open in ${profile.country.trim()}`)
  }
  if (rules.titleExcludes.length === 0 && suggestion.titleExcludes.length > 0) {
    rules.titleExcludes = suggestion.titleExcludes
    applied.push(`${suggestion.titleExcludes.length} title exclusion(s)`)
  }
  // Title *includes* are deliberately not auto-applied. They are a whitelist,
  // matched as substrings, and the model writes phrases: "principal solution
  // architect distributed systems" matches no title that has ever existed, and
  // filling this in unasked would silently reject every posting. The same
  // mistake in the search keywords cost a whole sweep of sixty-eight boards.
  if (applied.length > 0) {
    await saveSettings({ ...settings, matchRules: rules })
    settings.matchRules = rules
    log.info(`Matching rules filled in from your profile: ${applied.join(', ')}`)
  }

  const india = /india/i.test(profile.country)
  // What the user will actually accept decides which boards are worth checking.
  const remoteOnly =
    settings.matchRules.workModes.length > 0 && settings.matchRules.workModes.every((m) => m === 'remote')
  const candidates = dedupe([
    ...fromModel,
    ...matchCatalogue([...keywords, ...profile.skills].map(String), { india, remoteOnly, limit: MAX_CANDIDATES }),
  ]).slice(0, MAX_CANDIDATES)

  activity.relabel(`Checking ${candidates.length} company boards`)
  // Judged on how many postings the user could take, not on board size: a
  // board with four hundred Bay Area jobs is worth less here than one with
  // three that are remote and open to India.
  const checks = await validateBoards(candidates, { country: profile.country, remoteOnly })
  const live = checks.filter((c) => c.live)

  const created: string[] = []
  const notes: string[] = [...setupNotes]

  // --- Indeed, as the fallback ----------------------------------------------
  //
  // Built first because it needs no verified board slug, so a run is viable
  // even when every board lookup fails. It is switched off further down if the
  // board checks succeed, and that is the important part: Indeed is scraped
  // through a real browser window per search URL, it rate-limits and challenges
  // that traffic, and applying there needs a login the agent does not have. The
  // ATS APIs below are a JSON fetch with no window at all, are never blocked,
  // and lead to forms the agent can actually submit. Searching Indeed when
  // those exist buys nothing and costs minutes per cycle.
  //
  // Four phrases, not eight. Every phrase is two domains times two pages of
  // windows opened, scrolled and closed, so the URL count is what decides
  // whether a sweep takes ninety seconds or ten minutes.
  const rolePhrases = dedupePhrases([...keywords, ...DEFAULT_ROLE_PHRASES]).slice(0, 4)
  const previousIndeed = existing.find((r) => r.source === 'indeed' && r.name.startsWith('Indeed remote'))
  const indeedRecipe: SearchRecipe = {
    id: previousIndeed?.id ?? uid('recipe'),
    name: 'Indeed remote roles',
    enabled: true,
    source: 'indeed',
    keywords: rolePhrases,
    // Left blank deliberately: the URL builder pins every search to Remote, and
    // a city here would narrow that back down to a single metro.
    location: '',
    remoteOnly: true,
    boards: [],
    customUrls: [],
    maxResultsPerRun: 120,
    lastRunAt: null,
  }
  await saveRecipe(indeedRecipe)

  const bySource = (source: BoardSource): string[] =>
    live
      .filter((c) => c.source === source)
      .sort((a, b) => b.matchCount - a.matchCount || b.jobCount - a.jobCount)
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

  // SmartRecruiters is searched, not listed: it runs one public index across
  // every employer on it, so there are no board slugs to verify -- the search
  // phrases are the whole recipe. Worth having precisely because it reaches
  // employers no curated board list would ever name.
  {
    const previous = existing.find((r) => r.source === 'smartrecruiters')
    const recipe: SearchRecipe = {
      ...base,
      id: previous?.id ?? uid('recipe'),
      name: 'SmartRecruiters index',
      enabled: true,
      source: 'smartrecruiters',
      // This index has no location filter at all, so these are folded into the
      // search words instead -- the only lever it offers, and a strong one.
      location: profile.country || '',
      remoteOnly,
      boards: [],
      maxResultsPerRun: 120,
    }
    await saveRecipe(recipe)
    created.push(`SmartRecruiters index across ${keywords.length} search phrase(s)`)
  }

  // Workable, likewise: one public index rather than a list of boards. Its
  // records carry the full advert and state their own work mode, so a posting
  // arrives ready to judge without a second trip to the page.
  {
    const previous = existing.find((r) => r.source === 'workable')
    const recipe: SearchRecipe = {
      ...base,
      id: previous?.id ?? uid('recipe'),
      name: 'Workable index',
      enabled: true,
      source: 'workable',
      // Unlike every other source here, Workable's index filters on these for
      // real. Verified against the live API: the same phrase without them
      // returned a page of onsite roles in the US and the UK, and with them
      // every row was remote and in the right country. Leaving them blank was
      // the reason the source found a hundred and fifty postings and
      // contributed none of them.
      location: profile.country || '',
      remoteOnly,
      boards: [],
      maxResultsPerRun: 120,
    }
    await saveRecipe(recipe)
    created.push(`Workable index across ${keywords.length} search phrase(s)`)
  }

  const hasApplyableBoards = created.length > 0

  // Now decide what Indeed is for. With verified boards in hand it is turned
  // off rather than deleted, so a user who wants it can switch it back on in
  // one click and keep the role phrases that were built for them.
  if (hasApplyableBoards) {
    await saveRecipe({ ...indeedRecipe, enabled: false })
    notes.push(
      'Indeed was switched off because the verified boards above are better in every way that matters: ' +
        'they are read through a public API rather than a browser window, they are never rate-limited, ' +
        'and they lead to forms the agent can actually submit. Switch it back on under Searches if you want it.'
    )
  } else {
    created.push(`Indeed remote search across ${rolePhrases.length} role(s): ${rolePhrases.join(', ')}`)
    notes.push(
      'No company boards could be verified, so Indeed is the only source switched on. It is scraped through ' +
        'a browser window and can be rate-limited, so expect it to be slower and less reliable than boards.'
    )
  }

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
      `None of the ${checks.length} candidate boards responded, so this is an Indeed-only setup. That is enough ` +
        'to run; adding a company by hand in Searches just widens it - the slug is the last part of their ' +
        'careers URL, for example boards.greenhouse.io/<slug>.'
    )
  }

  log.info(
    `Setup: ${live.length} live board(s) of ${checks.length} checked, ${created.length} search(es) created`
  )
  activity.end(`Set up ${created.length} search(es) from ${live.length} verified board(s)`)

  return {
    created,
    // Indeed is always created, so manual setup is never strictly required.
    needsManual: false,
    boardsChecked: checks.length,
    boardsLive: live.length,
    notes,
  }
}

/** Case-insensitive phrase dedupe, preserving the order they were offered in. */
function dedupePhrases(phrases: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const phrase of phrases) {
    const trimmed = phrase.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
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

/**
 * What to search for, worked out from the profile alone.
 *
 * Plainly worse than asking the model, and much better than refusing. The
 * phrases are the person's own job titles, which is what a person typing into a
 * job board would use, and a couple of skill-qualified variants so the two
 * index sources have more than one thing to match on. No board slugs: guessing
 * company names without a model is how you get a list of 404s, and the
 * catalogue already covers that.
 */
function suggestionFromProfile(profile: Profile): SuggestedRules {
  const titles = [profile.currentTitle, ...profile.experience.map((e) => e.title)]
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
  const skills = profile.skills.map((s) => String(s).trim()).filter(Boolean)

  const phrases = new Set<string>()
  for (const title of titles.slice(0, 3)) {
    const lower = title.toLowerCase()
    phrases.add(lower)
    // The same role without its rank. "Principal Solution Architect" is a real
    // title and a narrow search; "solution architect" is the job, and matches
    // the postings that spell the rank differently or not at all. Leaving this
    // out cost an order of magnitude: a sweep on the ranked titles alone
    // matched 126 postings across the company boards where a broader set had
    // matched 1,794.
    const bare = lower.replace(
      /^(principal|senior|staff|lead|chief|head of|associate|junior|sr\.?|jr\.?)\s+/,
      ''
    )
    if (bare !== lower) phrases.add(bare)
    // One skill-qualified variant per title: "software architect kubernetes"
    // finds different postings from "software architect" on a keyword index.
    if (skills[0]) phrases.add(`${lower} ${skills[0].toLowerCase()}`)
  }
  if (phrases.size === 0) for (const phrase of DEFAULT_ROLE_PHRASES) phrases.add(phrase)

  return {
    titleIncludes: [],
    titleExcludes: [],
    descriptionIncludes: [],
    seniority: [],
    searchKeywords: [...phrases].slice(0, 8),
    greenhouseBoards: [],
    leverBoards: [],
    rationale: 'Built from your profile, without the model.',
  }
}
