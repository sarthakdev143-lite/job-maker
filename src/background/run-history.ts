/**
 * Persisted per-cycle run records.
 *
 * A cycle that finds nothing is a normal outcome, but an *unexplained* nothing
 * is the worst failure mode an unattended agent has: from the outside a crash
 * and an empty night look identical. The in-memory `summarize()` string made
 * this worse -- it vanished on the next cycle or worker restart, so the morning
 * after never had an answer to "found? filtered? attempted? submitted? why
 * not?".
 *
 * These records live in `chrome.storage.local` (not IndexedDB) so they survive
 * worker eviction and browser restarts without a DB migration, and so the side
 * panel can read the last night without opening the database. Only the most
 * recent entries are kept; the log store holds the full history.
 */

export type CycleOutcome =
  | 'completed'
  | 'paused-hours'
  | 'paused-cap'
  | 'stopped'
  | 'error-circuit'
  | 'error'

export type RecipeSummary = {
  fetched: number
  stored: number
  error?: string
}

export type CycleSummary = {
  id: string
  startedAt: number
  endedAt: number
  outcome: CycleOutcome
  /** Jobs stored as new this cycle. */
  found: number
  duplicates: number
  /** Jobs rejected by the deterministic prefilter. */
  rejected: number
  /** Jobs that reached scoring/queueing. */
  scored: number
  /** Scoring attempts that threw (job left as `new` for retry). */
  scoreFailed: number
  queued: number
  /** applyToJob invocations. */
  attempted: number
  submitted: number
  /** Parked for review (gate review, dry_run, unconfirmed submit). */
  parked: number
  /** Skipped at apply time (no form, zero fields, vendor off). */
  skipped: number
  /** applyToJob threw or recorded `failed`. */
  failed: number
  /** Recipes whose discovery threw (e.g. Indeed human-verification). */
  blocked: number
  bestScore: number
  perRecipe: Record<string, RecipeSummary>
  /** Gate parking reasons -> count, so one screen shows what stopped submits. */
  gateReasons: Record<string, number>
  note: string
}

export type RecipeHealth = {
  lastRunAt: number | null
  lastFetched: number
  lastStored: number
  lastError: string
}

const HISTORY_KEY = 'agent:runHistory'
const RECIPE_HEALTH_KEY = 'agent:recipeHealth'
const MAX_HISTORY = 20

function storage(): chrome.storage.LocalStorageArea | null {
  try {
    return chrome.storage.local
  } catch {
    return null
  }
}

export function emptySummary(): Omit<CycleSummary, 'id' | 'startedAt' | 'endedAt' | 'outcome' | 'note'> {
  return {
    found: 0,
    duplicates: 0,
    rejected: 0,
    scored: 0,
    scoreFailed: 0,
    queued: 0,
    attempted: 0,
    submitted: 0,
    parked: 0,
    skipped: 0,
    failed: 0,
    blocked: 0,
    bestScore: 0,
    perRecipe: {},
    gateReasons: {},
  }
}

/** One-line morning answer, persisted rather than living only in memory. */
export function summarizeCycle(t: Omit<CycleSummary, 'id' | 'startedAt' | 'endedAt'>): string {
  if (t.blocked > 0 && t.found === 0 && t.scored === 0) {
    return 'blocked by bot checks - open the job board once by hand, then start again'
  }
  if (t.found === 0 && t.scored === 0 && t.attempted === 0) {
    return 'no new postings found - widen your searches or filters'
  }
  if (t.queued === 0 && t.scored > 0) {
    return `scored ${t.scored}, best was ${t.bestScore} - lower your match threshold or fix the searches`
  }
  if (t.attempted > 0 && t.submitted === 0 && t.parked > 0) {
    const top = Object.entries(t.gateReasons).sort((a, b) => b[1] - a[1])[0]
    return top
      ? `attempted ${t.attempted}, all parked - top reason: ${top[0]} (${top[1]})`
      : `attempted ${t.attempted}, all parked for review`
  }
  return `${t.found} found, ${t.scored} scored, ${t.queued} queued, ${t.submitted} submitted`
}

export async function saveCycleSummary(
  summary: Omit<CycleSummary, 'id'> & { id?: string }
): Promise<CycleSummary> {
  const record: CycleSummary = {
    ...summary,
    id: summary.id ?? `${summary.startedAt}-${Math.floor(Math.random() * 1e6)}`,
  }
  try {
    const area = storage()
    if (!area) return record
    const bag = await area.get(HISTORY_KEY)
    const prev = (bag[HISTORY_KEY] as CycleSummary[] | undefined) ?? []
    const next = [record, ...prev].slice(0, MAX_HISTORY)
    await area.set({ [HISTORY_KEY]: next })
  } catch {
    // A run record must never fail the run it describes.
  }
  return record
}

export async function getRecentSummaries(limit = 5): Promise<CycleSummary[]> {
  try {
    const area = storage()
    if (!area) return []
    const bag = await area.get(HISTORY_KEY)
    const all = (bag[HISTORY_KEY] as CycleSummary[] | undefined) ?? []
    return all.slice(0, limit)
  } catch {
    return []
  }
}

export async function getLastSummary(): Promise<CycleSummary | null> {
  const recent = await getRecentSummaries(1)
  return recent[0] ?? null
}

export async function recordRecipeHealth(
  recipeId: string,
  health: Partial<RecipeHealth> & { lastRunAt?: number | null }
): Promise<void> {
  try {
    const area = storage()
    if (!area) return
    const bag = await area.get(RECIPE_HEALTH_KEY)
    const all = ((bag[RECIPE_HEALTH_KEY] as Record<string, RecipeHealth> | undefined) ?? {})
    const prev = all[recipeId] ?? { lastRunAt: null, lastFetched: 0, lastStored: 0, lastError: '' }
    all[recipeId] = { ...prev, ...health }
    await area.set({ [RECIPE_HEALTH_KEY]: all })
  } catch {
    // Best effort only.
  }
}

export async function getRecipeHealth(): Promise<Record<string, RecipeHealth>> {
  try {
    const area = storage()
    if (!area) return {}
    const bag = await area.get(RECIPE_HEALTH_KEY)
    return (bag[RECIPE_HEALTH_KEY] as Record<string, RecipeHealth> | undefined) ?? {}
  } catch {
    return {}
  }
}
