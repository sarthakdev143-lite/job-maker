/**
 * Proposing search and matching rules from a profile.
 *
 * The rules pages are the second place the extension used to demand a lot of
 * typing before it would do anything useful. Since the profile already says
 * what the person has done, the model can draft a sensible starting set and
 * the user can edit it instead of inventing it.
 *
 * Suggestions are always returned for review rather than applied silently:
 * these rules decide which jobs are never even looked at, and a hallucinated
 * title exclusion would quietly hide good postings for weeks.
 */

import { llm } from '@/llm/broker'
import { profileForPrompt } from '@/form/resolver'
import {
  SenioritySchema,
  SuggestedRulesSchema,
  type Profile,
  type Seniority,
  type Settings,
  type SuggestedRules,
} from '@/storage/schemas'
import { renderTemplate } from '@/shared/text'
import { createLogger } from '@/shared/logger'

const log = createLogger('suggest')

export async function suggestRules(profile: Profile, settings: Settings): Promise<SuggestedRules> {
  const prompt = renderTemplate(settings.prompts.suggestRules, {
    profile: profileForPrompt(profile),
  })

  const raw = await llm.completeStructured(
    { prompt, schema: SuggestedRulesSchema, freshContext: true },
    'suggest search rules'
  )

  const cleaned = sanitize(raw)
  log.info(
    `Suggested ${cleaned.titleIncludes.length} title keyword(s), ${cleaned.greenhouseBoards.length + cleaned.leverBoards.length} board(s)`
  )
  return cleaned
}

/**
 * Keep the model inside the vocabulary the rest of the system understands.
 * A seniority level that is not in the enum would be silently dropped by the
 * prefilter later; a board slug with a space in it is a guess, not a slug.
 */
function sanitize(raw: SuggestedRules): SuggestedRules {
  const validSeniority = new Set(SenioritySchema.options as readonly string[])
  const slug = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, '')

  const keywords = (list: string[], limit: number): string[] =>
    Array.from(new Set(list.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 1))).slice(0, limit)

  const boards = (list: string[]): string[] =>
    Array.from(new Set(list.map(slug).filter((s) => /^[a-z0-9-]{2,40}$/.test(s)))).slice(0, 8)

  return {
    titleIncludes: keywords(raw.titleIncludes, 8),
    titleExcludes: keywords(raw.titleExcludes, 8),
    descriptionIncludes: keywords(raw.descriptionIncludes, 4),
    seniority: Array.from(new Set(raw.seniority.map((s) => s.trim().toLowerCase()))).filter((s) =>
      validSeniority.has(s)
    ),
    searchKeywords: keywords(raw.searchKeywords, 4),
    greenhouseBoards: boards(raw.greenhouseBoards),
    leverBoards: boards(raw.leverBoards),
    rationale: raw.rationale.trim(),
  }
}

/** The seniority list as the schema's own type, for applying a suggestion. */
export function asSeniority(values: string[]): Seniority[] {
  const valid = new Set(SenioritySchema.options as readonly string[])
  const kept = values.filter((v): v is Seniority => valid.has(v))
  // 'unknown' is always kept: most postings do not state a level, and dropping
  // it would filter out the majority of a board.
  return kept.includes('unknown') ? kept : [...kept, 'unknown']
}
