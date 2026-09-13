/**
 * Building searches from the profile.
 *
 * Lives in the worker rather than in the options page because both the side
 * panel and the settings page need it: the readiness list is where a user finds
 * out they have nowhere to look, and making them navigate to another screen to
 * fix it is the friction this whole feature exists to remove.
 */

import { suggestRules } from '@/matching/suggest'
import { getProfile, getRecipes, getSettings, saveRecipe } from '@/storage/settings'
import { createLogger } from '@/shared/logger'
import { uid } from '@/shared/util'
import type { SearchRecipe } from '@/storage/schemas'

const log = createLogger('setup')

export type SetupResult = {
  created: string[]
  /** True when nothing could be built and the user has to add one by hand. */
  needsManual: boolean
}

export async function setUpSearchesFromProfile(): Promise<SetupResult> {
  const [settings, profile, existing] = await Promise.all([getSettings(), getProfile(), getRecipes()])
  const suggestion = await suggestRules(profile, settings)

  const keywords = suggestion.searchKeywords.length > 0 ? suggestion.searchKeywords : suggestion.titleIncludes
  const created: string[] = []

  /** Do not create a second copy of a board list the user already has. */
  const alreadyHas = (source: SearchRecipe['source'], boards: string[]): boolean =>
    existing.some(
      (r) => r.source === source && boards.every((b) => r.boards.map((x) => x.toLowerCase()).includes(b.toLowerCase()))
    )

  const make = async (recipe: SearchRecipe, description: string): Promise<void> => {
    await saveRecipe(recipe)
    created.push(description)
  }

  const base = {
    keywords,
    location: '',
    remoteOnly: false,
    customUrls: [],
    maxResultsPerRun: 40,
    lastRunAt: null,
  }

  if (suggestion.greenhouseBoards.length > 0 && !alreadyHas('greenhouse', suggestion.greenhouseBoards)) {
    await make(
      { ...base, id: uid('recipe'), name: 'Greenhouse boards', enabled: true, source: 'greenhouse', boards: suggestion.greenhouseBoards },
      `Greenhouse: ${suggestion.greenhouseBoards.join(', ')}`
    )
  }

  if (suggestion.leverBoards.length > 0 && !alreadyHas('lever', suggestion.leverBoards)) {
    await make(
      { ...base, id: uid('recipe'), name: 'Lever boards', enabled: true, source: 'lever', boards: suggestion.leverBoards },
      `Lever: ${suggestion.leverBoards.join(', ')}`
    )
  }

  // Naukri is the only broad search switched on automatically, and only for
  // India. Indeed stays off deliberately: its terms prohibit automation.
  if (/india/i.test(profile.country) && keywords.length > 0) {
    await make(
      {
        ...base,
        id: uid('recipe'),
        name: `Naukri - ${keywords[0]}`,
        enabled: true,
        source: 'naukri',
        boards: [],
        location: profile.city,
        maxResultsPerRun: 30,
      },
      `Naukri: ${keywords.join(', ')}${profile.city ? ` in ${profile.city}` : ''}`
    )
  }

  log.info(created.length > 0 ? `Created ${created.length} search(es) from the profile` : 'No searches could be built')
  return { created, needsManual: created.length === 0 }
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
