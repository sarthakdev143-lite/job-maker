/**
 * Questions about the queue that do not change it.
 *
 * Each of these exists because something the agent does was invisible until it
 * had already cost the user a night:
 *
 *   - scoring and applying were welded together, so the only way to find out
 *     what a sweep had turned up was to let it start sending applications;
 *   - a sweep can reject two and a half thousand postings, and a list of two
 *     and a half thousand rows says nothing about which rule did it;
 *   - plenty of Greenhouse customers host the form on their own domain, and
 *     without the site-access grant those applications fail one at a time with
 *     a connection error that reads like a broken extension.
 *
 * They live here rather than in the service worker because the worker is an
 * entry point: message plumbing, not logic worth testing.
 */

import { getProfile, getSettings } from '@/storage/settings'
import { answersRepo, applicationsRepo, jobsRepo } from '@/storage/db'
import { unscoredJobs } from '@/discovery'
import { scoreJob } from '@/matching/scorer'
import { LlmError } from '@/llm/driver'
import { hasHostAccess, originPattern } from '@/shared/injection'
import { createLogger } from '@/shared/logger'
import { activity } from '@/shared/activity'
import { errorMessage } from '@/shared/util'
import { normalizeQuestion } from '@/shared/text'

const log = createLogger('insights')

export type ScoreQueueResult = {
  scored: number
  queued: number
  failed: number
  top: Array<{ title: string; company: string; score: number; reason: string }>
  /**
   * Set when scoring stopped because the model itself was unusable, rather
   * than because a particular posting was. Empty on an ordinary run.
   */
  blockedBy?: string
}

/**
 * Failures that will repeat for every posting in the queue.
 *
 * An expired DeepSeek session produced forty identical "Not signed in"
 * warnings and a result reading `scored=0 queued=0 failed=40`, which named the
 * count and not the cause. These say nothing about the posting, so there is no
 * point working through the rest of the list to be told the same thing again.
 */
function systemicFailure(e: unknown): string {
  if (!(e instanceof LlmError)) return ''
  switch (e.code) {
    case 'not_logged_in':
      return 'not signed in to the model provider'
    case 'not_ready':
      return 'the model provider is not ready'
    case 'config':
      return 'the model is not configured'
    default:
      return ''
  }
}

/**
 * Score everything discovery found, and apply to none of it.
 *
 * Ranking is cheap and reversible; applying is neither. Keeping them separate
 * is what lets someone look at a queue of fifty postings nobody has read yet
 * and decide, rather than finding out by watching applications go out.
 */
export async function scoreQueue(limit = 40): Promise<ScoreQueueResult> {
  const [settings, profile] = await Promise.all([getSettings(), getProfile()])
  // Same ordering the agent itself uses, so scoring by hand and scoring during
  // a run work through the queue in the same sequence.
  const jobs = await unscoredJobs(limit)
  const out: ScoreQueueResult = { scored: 0, queued: 0, failed: 0, top: [] }
  if (jobs.length === 0) return out

  activity.begin('scoring', `Scoring ${jobs.length} posting(s)`, 30_000)
  for (const [index, job] of jobs.entries()) {
    activity.begin('scoring', `Scoring ${index + 1} of ${jobs.length}: ${job.title}`, 30_000)
    try {
      const score = await scoreJob(job, profile, settings)
      const queue = score.shouldApply && score.score >= settings.autonomy.minMatchScore
      await jobsRepo.update(job.id, {
        status: queue ? 'queued' : 'rejected',
        matchScore: score.score,
        matchReasons: score.reasons,
        matchConcerns: score.concerns,
        rejectReason: queue ? '' : `scored ${score.score}: ${score.concerns.join('; ') || 'below threshold'}`,
        scoredAt: Date.now(),
      })
      out.scored++
      if (queue) out.queued++
      out.top.push({ title: job.title, company: job.company, score: score.score, reason: score.reasons[0] ?? '' })
    } catch (e) {
      out.failed++
      const systemic = systemicFailure(e)
      if (systemic) {
        // Stop here. The remaining postings are left `new`, so the next run
        // picks up exactly where this one gave up once the cause is fixed.
        out.blockedBy = systemic
        log.warn(`Stopped scoring after ${index + 1} of ${jobs.length}: ${systemic}`)
        break
      }
      log.warn(`Could not score ${job.title}: ${errorMessage(e)}`)
    }
  }

  out.top.sort((a, b) => b.score - a.score)
  out.top = out.top.slice(0, 15)
  activity.end(out.blockedBy ? `Stopped: ${out.blockedBy}` : `Scored ${out.scored}, queued ${out.queued}`)
  return out
}

/**
 * Why everything that was thrown away, was thrown away.
 *
 * Reasons are collapsed to their shape, since each one names a different city
 * or company: "location Bengaluru not in allowed list" and the same line for
 * Pune are one reason, not two. A reason that accounts for nearly everything is
 * usually a rule that is tighter than its owner meant it to be.
 */
export async function rejectionSummary(): Promise<{
  total: number
  reasons: Array<{ reason: string; count: number }>
}> {
  const rejected = await jobsRepo.byStatus('rejected', 5000)
  const counts = new Map<string, number>()

  for (const job of rejected) {
    const raw = (job.rejectReason || 'no reason recorded').toLowerCase()
    const shape = raw
      .replace(/"[^"]*"/g, '…')
      .replace(/\b\d+(\.\d+)?\b/g, 'N')
      .replace(/\s+/g, ' ')
      .trim()
    counts.set(shape, (counts.get(shape) ?? 0) + 1)
  }

  return {
    total: rejected.length,
    reasons: [...counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
  }
}

/**
 * Queued jobs the extension currently cannot touch.
 *
 * `databricks.com/careers/...?gh_jid=` is a Greenhouse form wearing a company
 * URL, and Chrome gives an extension nothing it did not declare. The grant is
 * one click and already exists; this is what makes anyone realise they need it.
 */
export async function accessNeeded(): Promise<{
  blocked: number
  origins: Array<{ origin: string; count: number; example: string }>
}> {
  const queued = await jobsRepo.byStatus('queued', 300)
  const byOrigin = new Map<string, { count: number; example: string }>()

  for (const job of queued) {
    const url = job.applyUrl || job.url
    if (!url) continue

    let origin: string
    try {
      origin = originPattern(url)
    } catch {
      continue // a URL we cannot parse is not a permission problem
    }
    if (await hasHostAccess(url)) continue

    const seen = byOrigin.get(origin) ?? { count: 0, example: job.title }
    byOrigin.set(origin, { count: seen.count + 1, example: seen.example })
  }

  const origins = [...byOrigin.entries()]
    .map(([origin, v]) => ({ origin, count: v.count, example: v.example }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  return { blocked: origins.reduce((n, o) => n + o.count, 0), origins }
}

/* ----------------------------------------------------------- bank coverage */

/** Which tier of the resolver a filled field came from, in cost order. */
const TIER_ORDER = ['user', 'adapter', 'profile', 'answer_bank', 'llm', 'guess', 'default'] as const

export type BankCoverage = {
  /** Applications the numbers were taken from. */
  applications: number
  /** Fields those applications filled between them. */
  fields: number
  /** Field count per resolver tier, cheapest first. */
  bySource: Array<{ source: string; count: number; share: number }>
  /** Share of fields answered without a model call, in [0,1]. */
  freeShare: number
  /** Entries in the bank, and how many have never been reused. */
  entries: number
  unusedEntries: number
  /** The entries carrying the most weight, which are worth checking by hand. */
  topEntries: Array<{ label: string; value: string; usageCount: number }>
}

/**
 * How much of the form filling is already free.
 *
 * The answer bank is the mechanism that makes a hundred applications affordable
 * -- tiers 0 to 3 of the resolver cost nothing, and tier 4 is a model call per
 * page. Nothing reported that ratio, so there was no way to tell a bank that
 * was maturing from one that was quietly missing every question and paying for
 * a call each time. A share that stays low after twenty applications means the
 * questions are not collapsing to the same key, not that the forms are hard.
 *
 * The most-used entries come back with it because they are the ones a bad
 * answer would propagate through everything: one wrong stored value that
 * fifteen applications reused is worth a minute of anyone's attention.
 */
export async function bankCoverage(): Promise<BankCoverage> {
  const [apps, entries] = await Promise.all([applicationsRepo.all(500), answersRepo.all()])

  const counts = new Map<string, number>()
  let fields = 0
  let considered = 0
  for (const app of apps) {
    if (app.fillPlan.length === 0) continue
    considered++
    for (const f of app.fillPlan) {
      counts.set(f.source, (counts.get(f.source) ?? 0) + 1)
      fields++
    }
  }

  const known = [...TIER_ORDER] as string[]
  const bySource = [...counts.entries()]
    .sort((a, b) => {
      const ai = known.indexOf(a[0])
      const bi = known.indexOf(b[0])
      return (ai < 0 ? known.length : ai) - (bi < 0 ? known.length : bi)
    })
    .map(([source, count]) => ({ source, count, share: fields === 0 ? 0 : Number((count / fields).toFixed(3)) }))

  const paid = (counts.get('llm') ?? 0) + (counts.get('guess') ?? 0)
  return {
    applications: considered,
    fields,
    bySource,
    freeShare: fields === 0 ? 0 : Number(((fields - paid) / fields).toFixed(3)),
    entries: entries.length,
    unusedEntries: entries.filter((e) => e.usageCount === 0).length,
    topEntries: entries
      .filter((e) => e.usageCount > 0)
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 10)
      .map((e) => ({ label: e.label, value: e.value, usageCount: e.usageCount })),
  }
}

/* ------------------------------------------------------------ source yield */

export type SourceYield = {
  total: number
  sources: Array<{
    source: string
    found: number
    /** Still waiting to be scored. */
    unscored: number
    /** Cleared scoring and is waiting to be applied to. */
    queued: number
    applied: number
    rejected: number
    /** Share of this source's postings that were worth keeping, in [0,1]. */
    hitRate: number
  }>
}

/**
 * What each search source is actually worth.
 *
 * Five sources run on every sweep and they are wildly unequal: one board list
 * can return two thousand postings of which none survive the filters, while an
 * index returning forty contributes half the queue. Without this the only
 * visible number is the total found, which rewards exactly the source that
 * wastes the most time.
 *
 * `hitRate` counts against what has been judged, not against everything found,
 * so a source whose postings are still unscored is not punished for it.
 */
export async function sourceYield(): Promise<SourceYield> {
  const jobs = await jobsRepo.all(5000)
  const by = new Map<string, { found: number; unscored: number; queued: number; applied: number; rejected: number }>()

  for (const job of jobs) {
    const key = job.source || 'unknown'
    const row = by.get(key) ?? { found: 0, unscored: 0, queued: 0, applied: 0, rejected: 0 }
    row.found++
    // 'scored' is the in-between state a run leaves behind when it is stopped
    // mid-sweep; it has been judged but never sorted, so it counts as neither.
    if (job.status === 'new' || job.status === 'scored') row.unscored++
    else if (job.status === 'queued') row.queued++
    else if (job.status === 'rejected' || job.status === 'skipped') row.rejected++
    else row.applied++ // applied or failed: either way the source produced a real attempt
    by.set(key, row)
  }

  const sources = [...by.entries()]
    .map(([source, r]) => {
      const judged = r.found - r.unscored
      const kept = r.queued + r.applied
      // Five places, because a source keeping five of 1,765 is a real number
      // and three places rounds it into a different one.
      return { source, ...r, hitRate: judged === 0 ? 0 : Number((kept / judged).toFixed(5)) }
    })
    .sort((a, b) => b.queued + b.applied - (a.queued + a.applied) || b.found - a.found)

  return { total: jobs.length, sources }
}

/* --------------------------------------------------- questions that park */

export type RecurringPark = {
  /** The question, as the last form that asked it worded it. */
  label: string
  /** How many applications parked on it. */
  count: number
  /** True when at least one of those forms would not submit without it. */
  required: boolean
  /** The choices on offer, when it was a multiple-choice question. */
  options: string[]
  example: { company: string; title: string }
}

/**
 * The questions that keep stopping applications.
 *
 * A parked field is not a failure, it is the agent declining to invent an
 * answer -- but the same question parking on every application is a different
 * thing, and it is invisible unless someone reads twenty timelines. A live
 * Greenhouse form parked on "Are you legally authorized to work in the country
 * in which this role is located?" because the profile listed no authorized
 * countries; that is thirty seconds of work that nothing asked anyone to do.
 *
 * Answering one of these in the answer bank fixes it everywhere, which is why
 * this is shown next to the bank rather than buried in a timeline.
 */
export async function recurringParks(): Promise<RecurringPark[]> {
  const apps = await applicationsRepo.all(200)
  const byQuestion = new Map<string, RecurringPark>()

  for (const app of apps) {
    // One application asking the same question twice is still one question.
    const seenHere = new Set<string>()
    for (const field of app.unresolved) {
      const label = (field.label || '').trim()
      if (!label) continue
      const key = normalizeQuestion(label)
      if (!key || seenHere.has(key)) continue
      seenHere.add(key)

      const row = byQuestion.get(key) ?? {
        label,
        count: 0,
        required: false,
        options: [],
        example: { company: app.company, title: app.title },
      }
      row.count++
      row.required = row.required || field.required
      // The most recent wording and its choices, since a stale option list is
      // worse than none when someone is about to answer from it.
      if (field.options.length > 0 && row.options.length === 0) {
        row.options = field.options.map((o) => o.label).slice(0, 12)
      }
      byQuestion.set(key, row)
    }
  }

  return [...byQuestion.values()]
    .sort((a, b) => Number(b.required) - Number(a.required) || b.count - a.count)
    .slice(0, 12)
}
