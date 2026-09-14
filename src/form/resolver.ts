/**
 * Field resolution: deciding what to put in each box.
 *
 * Four tiers, cheapest and most certain first. Every field falls through until
 * something answers it, and anything that reaches the bottom is parked for the
 * user rather than guessed at.
 *
 *   0. User override      - a selector the user mapped by hand for this domain
 *   1. Vendor adapter     - this ATS's own field naming
 *   2. Canonical matcher  - the eighty percent of questions everyone asks
 *   3. Answer bank        - anything this user has answered before
 *   4. Model (batched)    - genuinely novel questions, one call for the page
 *   5. Guess              - a defensible answer, so no mandatory box is blank
 *   6. Park               - only what must not be guessed at
 *
 * Tiers 0-3 are free and instant. On a mature answer bank most forms never
 * reach tier 4 at all, which is the whole point of the design.
 */

import { answerCanonical, canonicalKeyFor, isDocumentKey, type CanonicalKey } from './canonical'
import { guessAnswer } from './guess'
import { adapterById } from '@/sites/registry'
import { lookup as bankLookup, promptDigest, remember, touch } from '@/storage/answer-bank'
import { llm } from '@/llm/broker'
import { FieldAnswersResponseSchema, type FieldDescriptor, type FilledField, type Job, type Profile, type Settings } from '@/storage/schemas'
import { condenseDescription, renderTemplate } from '@/shared/text'
import { createLogger } from '@/shared/logger'
import { hostOf, truncate } from '@/shared/util'

const log = createLogger('resolver')

/** Below this, an answer is parked for review instead of filled unattended. */
export const LLM_PARK_THRESHOLD = 0.55

export type ResolveResult = {
  plan: FilledField[]
  unresolved: FieldDescriptor[]
  /** Mean confidence across the plan, weighted so required fields dominate. */
  confidence: number
  /** File inputs the runner should attach a generated document to. */
  documentTargets: Array<{ selector: string; key: 'resume' | 'coverLetter' }>
  /** Free-text cover letter boxes, filled with the generated letter body. */
  coverLetterTargets: string[]
  llmCalls: number
}

export type ResolveContext = {
  fields: FieldDescriptor[]
  profile: Profile
  job: Job | null
  vendor: string
  settings: Settings
  url: string
  /** Cover letter body, when one has been generated for this application. */
  coverLetterText?: string
}

export async function resolveFields(ctx: ResolveContext): Promise<ResolveResult> {
  const { fields, profile, vendor, settings, url } = ctx
  const adapter = adapterById(vendor)
  const domain = hostOf(url)
  const overrides = settings.selectorOverrides[domain] ?? {}
  const overrideBySelector = new Map(
    Object.entries(overrides).map(([key, selector]) => [selector, key as CanonicalKey])
  )

  const plan: FilledField[] = []
  const documentTargets: ResolveResult['documentTargets'] = []
  const coverLetterTargets: string[] = []
  const needsModel: FieldDescriptor[] = []
  const unresolved: FieldDescriptor[] = []

  for (const field of fields) {
    // Documents are produced by the runner, not resolved as values.
    const overrideKey = overrideBySelector.get(field.selector) ?? null
    const adapterKey = adapter.canonicalKey?.(field) ?? null
    const genericKey = canonicalKeyFor(field)
    const key: CanonicalKey | null = overrideKey ?? adapterKey ?? genericKey

    if (field.kind === 'file' || isDocumentKey(key)) {
      if (key === 'coverLetterText' && field.kind !== 'file') {
        coverLetterTargets.push(field.selector)
        if (ctx.coverLetterText) {
          plan.push({
            selector: field.selector,
            label: field.label,
            kind: field.kind,
            value: ctx.coverLetterText,
            confidence: 0.9,
            source: 'default',
            reasoning: 'generated cover letter',
            verified: false,
            error: '',
            required: field.required,
          })
        }
        continue
      }
      if (field.kind === 'file') {
        documentTargets.push({ selector: field.selector, key: key === 'coverLetter' ? 'coverLetter' : 'resume' })
        continue
      }
    }

    // Tier 0-2: canonical answer from the profile.
    if (key) {
      const answer = answerCanonical(key, profile, field)
      if (answer) {
        plan.push({
          selector: field.selector,
          label: field.label,
          kind: field.kind,
          value: answer.value,
          confidence: overrideKey ? Math.max(answer.confidence, 0.98) : answer.confidence,
          source: overrideKey ? 'user' : adapterKey ? 'adapter' : 'profile',
          reasoning: answer.note,
          verified: false,
          error: '',
          required: field.required,
        })
        continue
      }
    }

    // Tier 3: the answer bank.
    const hit = await bankLookup(field.label, vendor)
    if (hit && isCompatible(hit.entry.value, field)) {
      plan.push({
        selector: field.selector,
        label: field.label,
        kind: field.kind,
        value: coerceToField(hit.entry.value, field),
        confidence: hit.confidence,
        source: 'answer_bank',
        reasoning: `${hit.kind} match on a previous answer`,
        verified: false,
        error: '',
        required: field.required,
      })
      void touch(hit.entry.id)
      continue
    }

    needsModel.push(field)
  }

  // Tier 4: one model call for everything still unanswered.
  let llmCalls = 0
  if (needsModel.length > 0) {
    try {
      const answers = await askModel(needsModel, ctx)
      llmCalls = 1
      const bySelector = new Map(answers.map((a) => [a.selector, a]))

      for (const field of needsModel) {
        const answer = bySelector.get(field.selector)
        if (!answer || !answer.value.trim() || answer.needsHuman || answer.confidence < LLM_PARK_THRESHOLD) {
          unresolved.push(field)
          continue
        }
        const value = coerceToField(answer.value, field)
        if (!isCompatible(value, field)) {
          unresolved.push(field)
          continue
        }
        plan.push({
          selector: field.selector,
          label: field.label,
          kind: field.kind,
          value,
          confidence: answer.confidence,
          source: 'llm',
          reasoning: truncate(answer.reasoning, 160),
          verified: false,
          error: '',
          required: field.required,
        })
        // Remember high-confidence answers so the next form skips the call.
        if (answer.confidence >= 0.8 && field.kind !== 'textarea') {
          void remember({ label: field.label, value, kind: field.kind, source: 'llm', scope: '' })
        }
      }
    } catch (e) {
      log.warn(`Model could not answer ${needsModel.length} field(s); parking them`, {
        error: (e as Error).message,
      })
      unresolved.push(...needsModel)
    }
  }

  // Tier 5: guess, rather than leave a mandatory question blank.
  //
  // A form submitted with an unanswered required question is rejected outright
  // by most ATSs, so a plausible answer is strictly better than none. What must
  // not be guessed at -- sponsorship, work authorization, credentials -- is
  // filtered out inside guessAnswer and still parks here.
  const stillUnresolved: FieldDescriptor[] = []
  if (settings.autonomy.answerEverything) {
    for (const field of unresolved) {
      const guess = guessAnswer(field, profile, ctx.job)
      if (!guess || !isCompatible(guess.value, field)) {
        stillUnresolved.push(field)
        continue
      }
      plan.push({
        selector: field.selector,
        label: field.label,
        kind: field.kind,
        value: coerceToField(guess.value, field),
        confidence: guess.confidence,
        source: 'guess',
        reasoning: guess.reasoning,
        verified: false,
        error: '',
        required: field.required,
      })
    }
  } else {
    stillUnresolved.push(...unresolved)
  }

  const guessed = plan.filter((f) => f.source === 'guess').length
  if (guessed > 0) log.info(`Guessed ${guessed} answer(s) rather than leave them blank`)

  return {
    plan,
    unresolved: stillUnresolved,
    confidence: planConfidence(plan, stillUnresolved),
    documentTargets,
    coverLetterTargets,
    llmCalls,
  }
}

/* ------------------------------------------------------------- model tier */

async function askModel(
  fields: FieldDescriptor[],
  ctx: ResolveContext
): Promise<Array<{ selector: string; value: string; confidence: number; reasoning: string; needsHuman: boolean }>> {
  const prompt = renderTemplate(ctx.settings.prompts.answerFields, {
    profile: profileForPrompt(ctx.profile),
    job: jobForPrompt(ctx.job),
    answerBank: await promptDigest(50),
    fields: fieldsForPrompt(fields),
  })

  const result = await llm.completeStructured(
    { prompt, schema: FieldAnswersResponseSchema, freshContext: true },
    `answer ${fields.length} field(s)`
  )
  return result.answers
}

function fieldsForPrompt(fields: FieldDescriptor[]): string {
  return fields
    .map((f, i) => {
      const parts = [
        `${i + 1}. selector: ${f.selector}`,
        `   question: ${f.label || '(unlabelled)'}`,
        `   type: ${f.kind}${f.required ? ' (required)' : ''}`,
      ]
      if (f.options.length > 0) {
        parts.push(`   options: ${f.options.map((o) => o.label).slice(0, 40).join(' | ')}`)
      }
      if (f.maxLength) parts.push(`   maxLength: ${f.maxLength}`)
      if (f.placeholder) parts.push(`   placeholder: ${f.placeholder}`)
      return parts.join('\n')
    })
    .join('\n\n')
}

export function profileForPrompt(p: Profile): string {
  const lines: string[] = [
    `Name: ${p.firstName} ${p.lastName}`,
    `Email: ${p.email}`,
    `Phone: ${p.phoneCountryCode} ${p.phone}`,
    `Location: ${[p.city, p.state, p.country].filter(Boolean).join(', ')}`,
    p.headline ? `Headline: ${p.headline}` : '',
    p.currentTitle ? `Current role: ${p.currentTitle}${p.currentCompany ? ` at ${p.currentCompany}` : ''}` : '',
    p.yearsExperience ? `Years of experience: ${p.yearsExperience}` : '',
    p.linkedin ? `LinkedIn: ${p.linkedin}` : '',
    p.github ? `GitHub: ${p.github}` : '',
    p.portfolio ? `Website: ${p.portfolio}` : '',
    p.skills.length ? `Skills: ${p.skills.join(', ')}` : '',
    p.languages.length ? `Languages: ${p.languages.join(', ')}` : '',
    p.certifications.length ? `Certifications: ${p.certifications.join(', ')}` : '',
    '',
    'Work authorization:',
    `  Authorized in: ${p.workAuthorization.authorizedInCountries.join(', ') || 'not specified'}`,
    `  Requires sponsorship: ${p.workAuthorization.requiresSponsorship ? 'yes' : 'no'}`,
    `  Willing to relocate: ${p.workAuthorization.willingToRelocate ? 'yes' : 'no'}`,
    `  Notice period: ${p.workAuthorization.noticePeriodDays} days`,
    p.workAuthorization.availableFrom ? `  Available from: ${p.workAuthorization.availableFrom}` : '',
    '',
    'Compensation:',
    `  Currency: ${p.compensation.currency}`,
    p.compensation.currentCtc ? `  Current: ${p.compensation.currentCtc}` : '',
    p.compensation.expectedCtc ? `  Expected: ${p.compensation.expectedCtc}` : '',
    '',
  ]

  if (p.experience.length > 0) {
    lines.push('Experience:')
    for (const role of p.experience.slice(0, 6)) {
      lines.push(
        `  - ${role.title} at ${role.company} (${role.startDate} to ${role.current ? 'present' : role.endDate})`
      )
      for (const bullet of role.bullets.slice(0, 4)) lines.push(`      * ${bullet}`)
    }
    lines.push('')
  }

  if (p.education.length > 0) {
    lines.push('Education:')
    for (const ed of p.education.slice(0, 4)) {
      lines.push(`  - ${ed.degree} ${ed.field} at ${ed.school} (${ed.endDate})`)
    }
    lines.push('')
  }

  if (p.extraContext.trim()) {
    lines.push('Additional context:', p.extraContext.trim())
  }

  return lines.filter((l) => l !== '').join('\n')
}

export function jobForPrompt(job: Job | null): string {
  if (!job) return '(no job record; answer generically from the profile)'
  return [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location} (${job.workMode})`,
    job.salaryText ? `Compensation: ${job.salaryText}` : '',
    '',
    'Description:',
    condenseDescription(job.descriptionText, 4000),
  ]
    .filter(Boolean)
    .join('\n')
}

/* -------------------------------------------------------------- coercion */

/** Snap a free-text answer onto one of the field's real options. */
function coerceToField(value: string, field: FieldDescriptor): string {
  const trimmed = String(value ?? '').trim()
  if (field.options.length === 0) {
    return field.maxLength && trimmed.length > field.maxLength ? trimmed.slice(0, field.maxLength) : trimmed
  }
  const lower = trimmed.toLowerCase()
  const exact = field.options.find((o) => o.label.toLowerCase() === lower || o.value.toLowerCase() === lower)
  if (exact) return exact.label
  const partial = field.options.find(
    (o) => o.label.toLowerCase().includes(lower) || lower.includes(o.label.toLowerCase())
  )
  return partial?.label ?? trimmed
}

/**
 * Would this value actually be accepted by this control? A select whose options
 * do not contain the answer is worse than an empty select: it either silently
 * keeps the placeholder or trips validation on submit.
 */
function isCompatible(value: string, field: FieldDescriptor): boolean {
  const v = String(value ?? '').trim()
  if (!v) return false
  if (field.options.length > 0 && (field.kind === 'select' || field.kind === 'radio')) {
    const lower = v.toLowerCase()
    return field.options.some(
      (o) =>
        o.label.toLowerCase() === lower ||
        o.value.toLowerCase() === lower ||
        o.label.toLowerCase().includes(lower) ||
        lower.includes(o.label.toLowerCase())
    )
  }
  if (field.kind === 'email') return /.+@.+\..+/.test(v)
  if (field.kind === 'number') return /^-?\d+(\.\d+)?$/.test(v.replace(/[,\s]/g, ''))
  return true
}

/**
 * Confidence for the whole plan.
 *
 * Required fields count triple and every unresolved field drags the number
 * down, so a form with one parked required question can never read as
 * high-confidence no matter how many easy fields it also had.
 */
export function planConfidence(plan: FilledField[], unresolved: FieldDescriptor[]): number {
  if (plan.length === 0) return 0
  let weighted = 0
  let weight = 0
  for (const f of plan) {
    const w = f.required ? 3 : 1
    weighted += f.confidence * w
    weight += w
  }
  for (const f of unresolved) {
    const w = f.required ? 3 : 1
    weighted += 0
    weight += w
  }
  return weight === 0 ? 0 : Number((weighted / weight).toFixed(3))
}
