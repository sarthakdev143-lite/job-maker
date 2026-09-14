/**
 * Model scoring, tier two of matching.
 *
 * Only postings that survive the prefilter get here, one model call each. The
 * score decides whether an application is queued at all and, at submit time,
 * is half of the autonomy gate -- so the prompt asks for reasons and concerns
 * alongside the number, and those are what the side panel shows the user when
 * they are deciding whether their thresholds are set sensibly.
 */

import { llm } from '@/llm/broker'
import { jobForPrompt, profileForPrompt } from '@/form/resolver'
import { ScoreResponseSchema, type Job, type Profile, type ScoreResponse, type Settings } from '@/storage/schemas'
import { renderTemplate } from '@/shared/text'
import { createLogger } from '@/shared/logger'

const log = createLogger('scorer')

export async function scoreJob(job: Job, profile: Profile, settings: Settings): Promise<ScoreResponse> {
  const rules = settings.matchRules
  const prompt = renderTemplate(settings.prompts.score, {
    profile: profileForPrompt(profile),
    rules: rulesForPrompt(settings),
    weights: Object.entries(rules.weights)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n'),
    title: job.title,
    company: job.company,
    location: `${job.location}${job.workMode !== 'unknown' ? ` (${job.workMode})` : ''}`,
    salary: job.salaryText || 'not stated',
    description: jobForPrompt(job).replace(/^Title:[\s\S]*?Description:\n/, ''),
  })

  const result = await llm.completeStructured(
    { prompt, schema: ScoreResponseSchema, freshContext: true },
    `score ${job.company} / ${job.title}`
  )

  return result
}

function rulesForPrompt(settings: Settings): string {
  const r = settings.matchRules
  const lines = [
    r.titleIncludes.length ? `Wants titles containing: ${r.titleIncludes.join(', ')}` : '',
    r.titleExcludes.length ? `Refuses titles containing: ${r.titleExcludes.join(', ')}` : '',
    r.locations.length ? `Acceptable locations: ${r.locations.join(', ')}` : '',
    `Acceptable work modes: ${r.workModes.join(', ')}`,
    `Acceptable seniority: ${r.seniority.join(', ')}`,
    r.minSalary ? `Minimum acceptable compensation: ${r.minSalary} ${r.salaryCurrency}` : '',
    r.descriptionIncludes.length ? `Must mention: ${r.descriptionIncludes.join(', ')}` : '',
    r.descriptionExcludes.length ? `Must not mention: ${r.descriptionExcludes.join(', ')}` : '',
    r.companyBlocklist.length ? `Will not work for: ${r.companyBlocklist.join(', ')}` : '',
  ].filter(Boolean)
  return lines.length > 0 ? lines.join('\n') : '(no explicit rules set; judge on profile fit alone)'
}

/**
 * Score several jobs in sequence.
 *
 * Deliberately serial: the default driver is a single chat tab, and firing
 * these concurrently would just queue inside the broker while making failures
 * harder to attribute. `onProgress` keeps the side panel honest about how far
 * along a long scoring run is.
 */
export async function scoreBatch(
  jobs: Job[],
  profile: Profile,
  settings: Settings,
  onProgress?: (done: number, total: number, job: Job, score: ScoreResponse | null) => void,
  shouldStop?: () => boolean
): Promise<Map<string, ScoreResponse>> {
  const out = new Map<string, ScoreResponse>()
  let done = 0

  for (const job of jobs) {
    if (shouldStop?.()) {
      log.info(`Scoring stopped early after ${done}/${jobs.length}`)
      break
    }
    try {
      const score = await scoreJob(job, profile, settings)
      out.set(job.id, score)
      onProgress?.(++done, jobs.length, job, score)
    } catch (e) {
      log.warn(`Could not score ${job.title} at ${job.company}`, { error: (e as Error).message })
      onProgress?.(++done, jobs.length, job, null)
    }
  }
  return out
}
