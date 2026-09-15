/**
 * Discovery orchestration.
 *
 * Runs the user's enabled search recipes, normalises what comes back, drops
 * anything already seen, applies the deterministic prefilter, and stores the
 * survivors as `new` jobs for the scorer to pick up.
 *
 * Dedupe happens before anything expensive: the same role reposted on three
 * boards costs one record, and a role the user already applied to costs
 * nothing at all.
 */

import { fetchAshby, fetchGreenhouse, fetchLever, filterByKeywords } from './sources/ats-apis'
import { fetchNaukri, hydrateDescriptions } from './sources/scraped-boards'
import { fetchIndeed, hydrateIndeedJobs } from './sources/indeed'
import { enrichJob, prefilter } from '@/matching/prefilter'
import { jobsRepo } from '@/storage/db'
import { getRecipes, getSettings, saveRecipe } from '@/storage/settings'
import { parsePostedDate } from '@/shared/text'
import { createLogger } from '@/shared/logger'
import { activity } from '@/shared/activity'
import { errorMessage } from '@/shared/util'
import type { Job, SearchRecipe } from '@/storage/schemas'

const log = createLogger('discovery')

export type DiscoveryResult = {
  fetched: number
  duplicates: number
  rejected: number
  stored: number
  byRecipe: Record<string, { fetched: number; stored: number; error?: string }>
}

async function runRecipe(recipe: SearchRecipe): Promise<Job[]> {
  switch (recipe.source) {
    case 'greenhouse':
      return filterByKeywords(await fetchGreenhouse(recipe), recipe)
    case 'lever':
      return filterByKeywords(await fetchLever(recipe), recipe)
    case 'ashby':
      return filterByKeywords(await fetchAshby(recipe), recipe)
    case 'indeed':
      return fetchIndeed(recipe)
    case 'naukri':
      return fetchNaukri(recipe)
    case 'custom':
      // Custom URLs are scraped with the Indeed card reader, which handles most
      // listing layouts; anything exotic is better added as a real adapter.
      return fetchIndeed(recipe)
    default:
      return []
  }
}

export async function runDiscovery(
  options: { recipeId?: string; shouldStop?: () => boolean } = {}
): Promise<DiscoveryResult> {
  const settings = await getSettings()
  const recipes = (await getRecipes()).filter(
    (r) => (options.recipeId ? r.id === options.recipeId : r.enabled)
  )

  const result: DiscoveryResult = { fetched: 0, duplicates: 0, rejected: 0, stored: 0, byRecipe: {} }
  if (recipes.length === 0) {
    log.info('No enabled search recipes; nothing to discover')
    return result
  }

  for (const recipe of recipes) {
    if (options.shouldStop?.()) {
      log.info('Discovery stopped by request')
      break
    }

    const entry = { fetched: 0, stored: 0 } as DiscoveryResult['byRecipe'][string]
    result.byRecipe[recipe.id] = entry

    try {
      activity.relabel(`Searching: ${recipe.name}`)
      log.info(`Running recipe "${recipe.name}" (${recipe.source})`)
      let jobs = await runRecipe(recipe)
      entry.fetched = jobs.length
      result.fetched += jobs.length

      // Scraped sources give relative dates as text; convert before filtering.
      jobs = jobs.map((j) => (j.postedAt ? j : { ...j, postedAt: parsePostedDate(j.salaryText) }))

      // Only hydrate what could plausibly survive; fetching descriptions is the
      // slow part and there is no point paying it for a blocklisted company.
      const plausible = jobs.filter((j) => prefilter(j, settings.matchRules).pass || j.descriptionText.length < 400)
      if (recipe.source === 'indeed' || recipe.source === 'custom') {
        // The Indeed hydrator also resolves each listing's real apply target,
        // which is what lets the runner open a company ATS form directly
        // instead of landing on an advert and giving up.
        await hydrateIndeedJobs(plausible, Math.min(40, recipe.maxResultsPerRun))
      } else if (recipe.source === 'naukri') {
        await hydrateDescriptions(plausible, Math.min(12, recipe.maxResultsPerRun))
      }

      for (const raw of jobs) {
        const job = enrichJob(raw)

        if (await jobsRepo.exists(job.dedupeHash)) {
          result.duplicates++
          continue
        }

        const verdict = prefilter(job, settings.matchRules)
        if (!verdict.pass) {
          result.rejected++
          // Rejected jobs are stored so the same posting is never re-fetched or
          // re-evaluated, and so the user can see what the rules threw away.
          await jobsRepo.put({ ...job, status: 'rejected', rejectReason: verdict.reason })
          continue
        }

        await jobsRepo.put(job)
        entry.stored++
        result.stored++
      }

      await saveRecipe({ ...recipe, lastRunAt: Date.now() })
      log.info(`Recipe "${recipe.name}": ${entry.stored} new, ${result.duplicates} dupes, ${result.rejected} filtered out`)
    } catch (e) {
      entry.error = errorMessage(e)
      log.error(`Recipe "${recipe.name}" failed`, { error: entry.error })
    }
  }

  return result
}

/**
 * Jobs ready to be worked on, cheapest first.
 *
 * Indeed Easy Apply postings come first because they are prefilled from the
 * user's Indeed account and finish in seconds, where a listing that redirects
 * to a company ATS costs a full form-filling pass and often a model call. Over
 * a night that ordering is the difference between clearing the easy hundred and
 * getting stuck on the first twenty hard ones. Within each group the oldest
 * goes first, so nothing starves.
 */
export async function unscoredJobs(limit = 25): Promise<Job[]> {
  const jobs = await jobsRepo.byStatus('new', 500)
  return jobs.sort(byCheapestFirst).slice(0, limit)
}

export function byCheapestFirst(a: Job, b: Job): number {
  if (a.easyApply !== b.easyApply) return a.easyApply ? -1 : 1
  return a.discoveredAt - b.discoveredAt
}
