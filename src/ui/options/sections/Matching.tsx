/**
 * Matching rules.
 *
 * The rules on this page run for free before any model call, so they are both
 * the cheapest filter and the absolute one: a blocklisted company is never
 * scored, never queued, never applied to, whatever a model might think of it.
 */

import { useState } from 'react'
import { Badge, Field, ListInput, NumberInput, Section, TextInput, Toggle } from '../../shared/components'
import { api, useAction } from '../../shared/api'
import { asSeniority } from '@/matching/suggest'
import type { MatchRules, Settings, Seniority, SuggestedRules, WorkMode } from '@/storage/schemas'

const WORK_MODES: WorkMode[] = ['remote', 'hybrid', 'onsite', 'unknown']
const SENIORITIES: Seniority[] = ['intern', 'junior', 'mid', 'senior', 'staff', 'lead', 'manager', 'director', 'unknown']

export default function MatchingSection({
  settings,
  patch,
}: {
  settings: Settings
  patch: (p: Partial<Settings>) => void
}) {
  const rules = settings.matchRules
  const setRules = (p: Partial<MatchRules>) => patch({ matchRules: { ...rules, ...p } })

  const { run, busy, error } = useAction()
  const [suggestion, setSuggestion] = useState<SuggestedRules | null>(null)

  const applySuggestion = (s: SuggestedRules) => {
    setRules({
      titleIncludes: Array.from(new Set([...rules.titleIncludes, ...s.titleIncludes])),
      titleExcludes: Array.from(new Set([...rules.titleExcludes, ...s.titleExcludes])),
      descriptionIncludes: Array.from(new Set([...rules.descriptionIncludes, ...s.descriptionIncludes])),
      seniority: s.seniority.length > 0 ? asSeniority(s.seniority) : rules.seniority,
    })
    setSuggestion(null)
  }

  const toggleIn = <T extends string>(list: T[], value: T, set: (next: T[]) => void) => {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value])
  }

  return (
    <div>
      <Section
        title="Draft these from my profile"
        description="Reads what you have actually done and proposes a starting set of rules. You review them before anything is applied."
        actions={
          <button
            className="btn btn-primary btn-sm"
            disabled={!!busy}
            onClick={() => run(async () => setSuggestion(await api.suggestRules()), 'thinking')}
          >
            {busy === 'thinking' ? 'Thinking…' : 'Suggest rules'}
          </button>
        }
      >
        {error && (
          <p className="text-[12px]" style={{ color: 'var(--bad)' }}>
            {error}
          </p>
        )}

        {suggestion && (
          <div className="surface px-3 py-3">
            {suggestion.rationale && (
              <p className="mb-2 text-[12px]" style={{ color: 'var(--ink-soft)' }}>
                {suggestion.rationale}
              </p>
            )}

            <SuggestionRow label="Search for" items={suggestion.titleIncludes} tone="good" />
            <SuggestionRow label="Avoid" items={suggestion.titleExcludes} tone="bad" />
            <SuggestionRow label="Must mention" items={suggestion.descriptionIncludes} />
            <SuggestionRow label="Levels" items={suggestion.seniority} />
            <SuggestionRow
              label="Boards worth watching"
              items={[...suggestion.greenhouseBoards, ...suggestion.leverBoards]}
            />

            <div className="mt-3 flex items-center gap-2">
              <button className="btn btn-primary btn-sm" onClick={() => applySuggestion(suggestion)}>
                Add these to my rules
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setSuggestion(null)}>
                Discard
              </button>
              <span className="text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
                Added to what you already have, never replacing it. Board slugs go in Searches by hand.
              </span>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Hard filters"
        description="Applied before anything is scored. Nothing rejected here is ever reconsidered."
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Title must contain one of" hint="Leave empty to accept any title.">
            <ListInput value={rules.titleIncludes} onChange={(v) => setRules({ titleIncludes: v })} rows={4} />
          </Field>
          <Field label="Title must not contain" hint="e.g. intern, manager, sales">
            <ListInput value={rules.titleExcludes} onChange={(v) => setRules({ titleExcludes: v })} rows={4} />
          </Field>
          <Field label="Description must mention">
            <ListInput value={rules.descriptionIncludes} onChange={(v) => setRules({ descriptionIncludes: v })} rows={3} />
          </Field>
          <Field label="Description must not mention" hint="e.g. security clearance, on-call rotation">
            <ListInput value={rules.descriptionExcludes} onChange={(v) => setRules({ descriptionExcludes: v })} rows={3} />
          </Field>
          <Field label="Never apply to these companies">
            <ListInput value={rules.companyBlocklist} onChange={(v) => setRules({ companyBlocklist: v })} rows={3} />
          </Field>
          <Field label="Only these companies" hint="When set, everything else is rejected.">
            <ListInput value={rules.companyAllowlist} onChange={(v) => setRules({ companyAllowlist: v })} rows={3} />
          </Field>
          <Field label="Acceptable locations" hint="Ignored for remote roles.">
            <ListInput value={rules.locations} onChange={(v) => setRules({ locations: v })} rows={3} />
          </Field>
          <Field label="Maximum age (days)">
            <NumberInput value={rules.maxDaysOld} onChange={(v) => setRules({ maxDaysOld: v })} min={1} max={365} />
          </Field>
        </div>
      </Section>

      <Section title="Work mode and seniority">
        <div className="mb-3">
          <span className="label">Work modes to consider</span>
          <div className="flex flex-wrap gap-1.5">
            {WORK_MODES.map((mode) => (
              <button
                key={mode}
                className={`btn btn-sm ${rules.workModes.includes(mode) ? 'btn-primary' : ''}`}
                onClick={() => toggleIn(rules.workModes, mode, (next) => setRules({ workModes: next }))}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="label">Seniority levels to consider</span>
          <div className="flex flex-wrap gap-1.5">
            {SENIORITIES.map((level) => (
              <button
                key={level}
                className={`btn btn-sm ${rules.seniority.includes(level) ? 'btn-primary' : ''}`}
                onClick={() => toggleIn(rules.seniority, level, (next) => setRules({ seniority: next }))}
              >
                {level}
              </button>
            ))}
          </div>
          <p className="hint">
            Seniority is inferred from the title, falling back to the years of experience the posting asks for.
          </p>
        </div>
      </Section>

      <Section
        title="Compensation"
        description="Only enforced when the posting states a figure in the same currency; converting would be guesswork."
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Minimum acceptable" hint="Annual, in the currency below. Leave at 0 to ignore.">
            <NumberInput
              value={rules.minSalary ?? 0}
              onChange={(v) => setRules({ minSalary: v > 0 ? v : null })}
              min={0}
              step={10000}
            />
          </Field>
          <Field label="Currency">
            <TextInput value={rules.salaryCurrency} onChange={(v) => setRules({ salaryCurrency: v })} />
          </Field>
        </div>
        <Toggle
          checked={rules.requireSalaryPosted}
          onChange={(v) => setRules({ requireSalaryPosted: v })}
          label="Skip postings that do not state compensation"
        />
        <Toggle
          checked={rules.excludeIfSponsorshipUnavailable}
          onChange={(v) => setRules({ excludeIfSponsorshipUnavailable: v })}
          label="Skip postings that say sponsorship is unavailable"
          description="Worth turning on if you need sponsorship; it reads the posting text for the usual phrasings."
        />
      </Section>

      <Section
        title="Scoring weights"
        description="Handed to the model when it scores a posting out of 100. Set these to what you actually care about."
      >
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ['titleFit', 'Title fit'],
              ['skillsOverlap', 'Skills overlap'],
              ['seniorityFit', 'Seniority fit'],
              ['locationFit', 'Location fit'],
              ['compensationFit', 'Compensation fit'],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <NumberInput
                value={rules.weights[key]}
                onChange={(v) => setRules({ weights: { ...rules.weights, [key]: v } })}
                min={0}
                max={100}
              />
            </Field>
          ))}
        </div>
        <p className="hint">
          Total: {Object.values(rules.weights).reduce((a, b) => a + b, 0)}. They do not have to add to 100, but the
          scores are easier to reason about when they do.
        </p>
      </Section>
    </div>
  )
}

function SuggestionRow({
  label,
  items,
  tone,
}: {
  label: string
  items: string[]
  tone?: 'good' | 'bad'
}) {
  if (items.length === 0) return null
  return (
    <div className="mb-1.5 flex items-start gap-2">
      <span className="w-[140px] shrink-0 text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
        {label}
      </span>
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <Badge key={item} tone={tone}>
            {item}
          </Badge>
        ))}
      </div>
    </div>
  )
}
