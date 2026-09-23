/**
 * The answer bank is what makes this cheap over time.
 *
 * Tier 1 of field resolution is a per-vendor selector map, tier 3 is an LLM
 * call. This module is tier 2: every question the agent has ever answered,
 * keyed by normalized text, looked up exactly first and fuzzily second. After
 * a few dozen applications most forms resolve entirely from here and the model
 * is only consulted for genuinely novel questions.
 */

import { answersRepo } from './db'
import { normalizeQuestion, questionSimilarity, similarity } from '@/shared/text'
import { uid } from '@/shared/util'
import type { AnswerBankEntry, Profile } from './schemas'

/** Below this, a fuzzy hit is not trustworthy enough to fill unattended. */
export const FUZZY_THRESHOLD = 0.78

/** A fuzzy hit's confidence is its similarity, capped so it never beats exact. */
const EXACT_CONFIDENCE = 0.97
const FUZZY_CONFIDENCE_CAP = 0.9

export type BankHit = {
  entry: AnswerBankEntry
  confidence: number
  kind: 'exact' | 'fuzzy'
}

let cache: AnswerBankEntry[] | null = null

export function invalidateCache(): void {
  cache = null
}

async function entries(): Promise<AnswerBankEntry[]> {
  if (!cache) cache = await answersRepo.all()
  return cache
}

/**
 * Look up an answer for a question. `scope` is the vendor or company; a scoped
 * entry only matches within its scope, an unscoped entry matches anywhere.
 */
export async function lookup(label: string, scope = ''): Promise<BankHit | null> {
  const q = normalizeQuestion(label)
  if (!q) return null
  const all = await entries()
  const eligible = all.filter((e) => !e.scope || e.scope === scope)

  const exact = eligible.find((e) => e.qNormalized === q)
  if (exact) return { entry: exact, confidence: EXACT_CONFIDENCE, kind: 'exact' }

  let best: BankHit | null = null
  for (const entry of eligible) {
    const score = questionSimilarity(q, entry.qNormalized)
    if (score >= FUZZY_THRESHOLD && (!best || score > best.confidence)) {
      best = { entry, confidence: Math.min(score, FUZZY_CONFIDENCE_CAP), kind: 'fuzzy' }
    }
  }
  return best
}

/**
 * Record an answer. Re-answering the same question overwrites the value, which
 * is what the user expects after they correct a field in the review queue.
 * User-sourced answers are never overwritten by an LLM-sourced one.
 */
export async function remember(input: {
  label: string
  value: string
  kind?: string
  source?: AnswerBankEntry['source']
  scope?: string
  pinned?: boolean
}): Promise<AnswerBankEntry | null> {
  const q = normalizeQuestion(input.label)
  if (!q || !input.value.trim()) return null

  const all = await entries()
  const scope = input.scope ?? ''
  const existing = all.find((e) => e.qNormalized === q && e.scope === scope)
  const source = input.source ?? 'user'

  if (existing) {
    const downgrade = existing.source === 'user' && source === 'llm'
    if (downgrade) return existing
    existing.value = input.value
    existing.label = input.label
    existing.source = source
    existing.kind = input.kind ?? existing.kind
    if (input.pinned !== undefined) existing.pinned = input.pinned
    await answersRepo.put(existing)
    invalidateCache()
    return existing
  }

  const entry: AnswerBankEntry = {
    id: uid('ans'),
    qNormalized: q,
    label: input.label,
    kind: input.kind ?? 'text',
    value: input.value,
    source,
    scope,
    usageCount: 0,
    lastUsed: null,
    createdAt: Date.now(),
    pinned: input.pinned ?? false,
  }
  await answersRepo.put(entry)
  invalidateCache()
  return entry
}

export async function touch(id: string): Promise<void> {
  await answersRepo.touch(id)
  invalidateCache()
}

export async function remove(id: string): Promise<void> {
  await answersRepo.delete(id)
  invalidateCache()
}

export async function list(query = ''): Promise<AnswerBankEntry[]> {
  const all = await entries()
  if (!query.trim()) return all
  const q = normalizeQuestion(query)
  return all
    .map((e) => ({ e, s: Math.max(similarity(q, e.qNormalized), e.label.toLowerCase().includes(query.toLowerCase()) ? 1 : 0) }))
    .filter((x) => x.s > 0.3)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.e)
}

/**
 * Seed the bank from the profile so the very first application already
 * resolves the obvious fields without an LLM call. Existing user answers win.
 */
export async function seedFromProfile(profile: Profile): Promise<number> {
  const pairs: Array<[string, string]> = [
    ['First name', profile.firstName],
    ['Last name', profile.lastName],
    ['Full name', `${profile.firstName} ${profile.lastName}`.trim()],
    ['Preferred name', profile.preferredName || profile.firstName],
    ['Email', profile.email],
    ['Email address', profile.email],
    ['Phone', profile.phone],
    ['Phone number', profile.phone],
    ['Address', profile.addressLine1],
    ['City', profile.city],
    ['State', profile.state],
    ['Province', profile.state],
    ['Postal code', profile.postalCode],
    ['Zip code', profile.postalCode],
    ['Country', profile.country],
    ['LinkedIn profile', profile.linkedin],
    ['LinkedIn URL', profile.linkedin],
    ['GitHub profile', profile.github],
    ['GitHub URL', profile.github],
    ['Portfolio website', profile.portfolio],
    ['Personal website', profile.portfolio],
    ['Current company', profile.currentCompany],
    ['Current employer', profile.currentCompany],
    ['Current title', profile.currentTitle],
    ['Current job title', profile.currentTitle],
    ['Years of experience', profile.yearsExperience ? String(profile.yearsExperience) : ''],
    ['Expected salary', profile.compensation.expectedCtc],
    ['Expected compensation', profile.compensation.expectedCtc],
    ['Current salary', profile.compensation.currentCtc],
    ['Current CTC', profile.compensation.currentCtc],
    ['Expected CTC', profile.compensation.expectedCtc],
    ['Notice period', profile.workAuthorization.noticePeriodDays ? `${profile.workAuthorization.noticePeriodDays} days` : ''],
    ['Available start date', profile.workAuthorization.availableFrom],
    [
      'Are you legally authorized to work in the United States',
      profile.workAuthorization.authorizedInCountries.some((c) => /united states|usa|us\b/i.test(c)) ? 'Yes' : 'No',
    ],
    [
      'Will you now or in the future require sponsorship for employment visa status',
      profile.workAuthorization.requiresSponsorship ? 'Yes' : 'No',
    ],
    ['Are you willing to relocate', profile.workAuthorization.willingToRelocate ? 'Yes' : 'No'],
  ]

  let written = 0
  for (const [label, value] of pairs) {
    if (!value || !String(value).trim()) continue
    const created = await remember({ label, value: String(value), source: 'profile' })
    if (created) written++
  }
  invalidateCache()
  return written
}

/** Compact view of the bank for inclusion in an LLM prompt. */
export async function promptDigest(limit = 60): Promise<string> {
  const all = await entries()
  const top = all
    .slice()
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.usageCount - a.usageCount)
    .slice(0, limit)
  if (top.length === 0) return '(none yet)'
  return top.map((e) => `- ${e.label}: ${e.value}`).join('\n')
}
