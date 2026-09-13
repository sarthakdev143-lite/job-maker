/**
 * The autonomy gate.
 *
 * Everything the agent does converges here: this is the single place that
 * decides whether an application is submitted or parked for the user. It is
 * kept small and pure on purpose -- it takes facts and returns a decision, with
 * no I/O -- because it is the one function whose bugs email real recruiters.
 *
 * Every check is a veto. Nothing overrides a veto, including a perfect score.
 */

import { dayKey } from '@/shared/util'
import type { Application, Autonomy, FieldDescriptor, FilledField } from '@/storage/schemas'

export type GateDecision = {
  action: 'submit' | 'review' | 'skip'
  reasons: string[]
  /** Set when the decision is a hard stop for the whole run, not this job. */
  haltRun?: boolean
}

export type GateFacts = {
  autonomy: Autonomy
  /**
   * Set for a run the user started by hand.
   *
   * The active-hours window exists so unattended runs do not fire at 3am. It
   * has no business blocking a button the user just pressed, whatever day it
   * happens to be.
   */
  ignoreActiveHours?: boolean
  matchScore: number | null
  fillConfidence: number
  plan: FilledField[]
  unresolved: FieldDescriptor[]
  vendor: string
  vendorEnabled: boolean
  appliedToday: number
  appliedTodayOnVendor: number
  now: Date
}

export function evaluateGate(facts: GateFacts): GateDecision {
  const { autonomy } = facts
  const reasons: string[] = []

  if (!facts.vendorEnabled) {
    return { action: 'skip', reasons: [`submitting on ${facts.vendor} is switched off in settings`] }
  }

  // Caps first: they are absolute, and checking them before the expensive
  // reasoning below keeps the messages honest about why nothing happened.
  if (facts.appliedToday >= autonomy.maxApplicationsPerDay) {
    return {
      action: 'review',
      reasons: [`daily cap reached (${facts.appliedToday}/${autonomy.maxApplicationsPerDay})`],
      haltRun: true,
    }
  }

  const vendorCap = autonomy.perSiteDailyCap[facts.vendor] ?? Infinity
  if (facts.appliedTodayOnVendor >= vendorCap) {
    return { action: 'review', reasons: [`${facts.vendor} daily cap reached (${vendorCap})`] }
  }

  if (!facts.ignoreActiveHours && !withinActiveWindow(autonomy, facts.now)) {
    return { action: 'review', reasons: ['outside the configured active hours'], haltRun: true }
  }

  // Mode gates.
  if (autonomy.mode === 'dry_run') {
    return { action: 'review', reasons: ['dry run mode: filling but never submitting'] }
  }
  if (autonomy.mode === 'review') {
    return { action: 'review', reasons: ['review mode: every application waits for approval'] }
  }

  // Quality gates. In 'full' mode the thresholds are skipped, but the
  // unresolved-required-field check still applies -- submitting a form with a
  // blank required question just fails validation anyway.
  const requiredUnresolved = facts.unresolved.filter((f) => f.required)
  if (autonomy.requireAllRequiredFields && requiredUnresolved.length > 0) {
    reasons.push(
      `${requiredUnresolved.length} required field(s) unanswered: ${requiredUnresolved
        .slice(0, 3)
        .map((f) => f.label || f.selector)
        .join(', ')}`
    )
  }

  const failedRequired = facts.plan.filter((f) => f.required && f.error)
  if (failedRequired.length > 0) {
    reasons.push(`${failedRequired.length} required field(s) did not accept their value`)
  }

  if (autonomy.mode === 'gated') {
    if (facts.matchScore !== null && facts.matchScore < autonomy.minMatchScore) {
      reasons.push(`match score ${facts.matchScore} below threshold ${autonomy.minMatchScore}`)
    }
    if (facts.fillConfidence < autonomy.minFillConfidence) {
      reasons.push(
        `fill confidence ${facts.fillConfidence.toFixed(2)} below threshold ${autonomy.minFillConfidence}`
      )
    }
  }

  if (reasons.length > 0) return { action: 'review', reasons }

  return {
    action: 'submit',
    reasons: [
      facts.matchScore !== null ? `match ${facts.matchScore}` : 'unscored',
      `confidence ${facts.fillConfidence.toFixed(2)}`,
      `${facts.plan.length} field(s) filled`,
    ],
  }
}

/** Is `now` inside the user's configured working window? */
export function withinActiveWindow(autonomy: Autonomy, now: Date = new Date()): boolean {
  const day = now.getDay()
  if (autonomy.activeDays.length > 0 && !autonomy.activeDays.includes(day)) return false

  const hour = now.getHours() + now.getMinutes() / 60
  const { start, end } = autonomy.activeHours
  if (start === end) return true // a zero-width window means "no restriction"
  if (start < end) return hour >= start && hour < end
  // Window wrapping midnight, e.g. 22:00 to 06:00.
  return hour >= start || hour < end
}

/** Counter keys, shared by the gate's callers and the counter store. */
export function dailyCounterKey(vendor = ''): string {
  return vendor ? `applied:${dayKey()}:${vendor}` : `applied:${dayKey()}`
}

/** Human-readable summary of why an application is sitting in review. */
export function explainDecision(app: Application, decision: GateDecision): string {
  const head =
    decision.action === 'submit'
      ? 'Submitting'
      : decision.action === 'skip'
        ? 'Skipped'
        : 'Parked for review'
  return `${head}: ${decision.reasons.join('; ')} (${app.company} / ${app.title})`
}
