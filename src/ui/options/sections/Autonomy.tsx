/**
 * Autonomy.
 *
 * The most consequential page in the extension: it decides whether a filled
 * form gets sent to a real employer. The mode picker is written as four plain
 * statements of what will happen rather than as a slider, because "how
 * autonomous" is not a quantity the user should have to infer.
 */

import { Field, NumberInput, Section, Toggle } from '../../shared/components'
import { VENDOR_LABELS } from '@/sites/registry'
import type { Autonomy, AutonomyMode, Settings } from '@/storage/schemas'

const MODES: Array<{ id: AutonomyMode; title: string; body: string; tone: string }> = [
  {
    id: 'dry_run',
    title: 'Dry run',
    body: 'Finds, scores, tailors and fills every form, then stops. Nothing is ever submitted. Start here.',
    tone: 'var(--ink-faint)',
  },
  {
    id: 'review',
    title: 'Review everything',
    body: 'Does all the work and waits for you to approve each application. Roughly ten seconds of your time per job.',
    tone: 'var(--accent)',
  },
  {
    id: 'gated',
    title: 'Submit above your thresholds',
    body: 'Submits on its own when the match score and fill confidence both clear the bars below. Everything else waits for you.',
    tone: 'var(--warn)',
  },
  {
    id: 'full',
    title: 'Submit everything',
    body: 'Submits whatever fills cleanly, regardless of score or confidence. A wrong answer reaches a real recruiter with no undo.',
    tone: 'var(--bad)',
  },
]

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function AutonomySection({
  settings,
  patch,
}: {
  settings: Settings
  patch: (p: Partial<Settings>) => void
}) {
  const a = settings.autonomy
  const set = (p: Partial<Autonomy>) => patch({ autonomy: { ...a, ...p } })

  return (
    <div>
      <Section title="Mode" description="What the agent is allowed to do without asking.">
        <div className="flex flex-col gap-2">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              className="surface px-3 py-2.5 text-left transition-colors"
              style={{
                borderColor: a.mode === mode.id ? mode.tone : 'var(--line)',
                background: a.mode === mode.id ? 'var(--bg-soft)' : 'var(--bg-raised)',
                cursor: 'pointer',
              }}
              onClick={() => set({ mode: mode.id })}
            >
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{
                    background: a.mode === mode.id ? mode.tone : 'transparent',
                    border: `1.5px solid ${a.mode === mode.id ? mode.tone : 'var(--line-strong)'}`,
                  }}
                />
                <span className="text-[13px] font-medium">{mode.title}</span>
              </div>
              <p className="ml-[18px] mt-0.5 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                {mode.body}
              </p>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Thresholds" description="Used in gated mode. Both bars must be cleared for an unattended submit.">
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Minimum match score"
            hint="Out of 100, from the scorer. 75 is a sensible starting point; raise it if the queue fills with weak fits."
          >
            <NumberInput value={a.minMatchScore} onChange={(v) => set({ minMatchScore: v })} min={0} max={100} />
          </Field>
          <Field
            label="Minimum fill confidence"
            hint="0 to 1. How sure the resolver is about the answers it produced, weighted toward required fields."
          >
            <NumberInput
              value={a.minFillConfidence}
              onChange={(v) => set({ minFillConfidence: v })}
              min={0}
              max={1}
              step={0.05}
            />
          </Field>
        </div>
        <Toggle
          checked={a.requireAllRequiredFields}
          onChange={(v) => set({ requireAllRequiredFields: v })}
          label="Never submit with an unanswered required field"
          description="Leave this on. A form with a blank required question fails validation anyway."
        />
        <Toggle
          checked={a.answerEverything}
          onChange={(v) => set({ answerEverything: v })}
          label="Answer every mandatory question, guessing when necessary"
          description="Picks the most defensible option rather than leaving a box blank - your city for a location question, the neutral option, or agreement where applying implies it. Sponsorship, work authorization and credential questions are never guessed and still park for you."
        />
      </Section>

      <Section title="Volume" description="Caps are absolute and counted per day, whatever the thresholds say.">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Applications per day" hint="Across every site.">
            <NumberInput value={a.maxApplicationsPerDay} onChange={(v) => set({ maxApplicationsPerDay: v })} min={1} max={200} />
          </Field>
          <Field label="Stop after consecutive failures">
            <NumberInput value={a.circuitBreakerFailures} onChange={(v) => set({ circuitBreakerFailures: v })} min={1} max={20} />
          </Field>
        </div>

        <div className="mt-2">
          <span className="label">Per-site daily caps</span>
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(a.perSiteDailyCap).map(([vendor, cap]) => (
              <div key={vendor} className="flex items-center gap-2">
                <span className="w-[104px] shrink-0 text-[12px]" style={{ color: 'var(--ink-soft)' }}>
                  {VENDOR_LABELS[vendor] ?? vendor}
                </span>
                <NumberInput
                  value={cap}
                  onChange={(v) => set({ perSiteDailyCap: { ...a.perSiteDailyCap, [vendor]: v } })}
                  min={0}
                  max={100}
                />
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="When it runs"
        description="Unattended runs only happen inside this window. Applications sent at 3am look exactly like what they are."
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start hour" hint="24-hour local time.">
            <NumberInput value={a.activeHours.start} onChange={(v) => set({ activeHours: { ...a.activeHours, start: v } })} min={0} max={23} />
          </Field>
          <Field label="End hour">
            <NumberInput value={a.activeHours.end} onChange={(v) => set({ activeHours: { ...a.activeHours, end: v } })} min={0} max={23} />
          </Field>
        </div>

        <div className="mt-2">
          <span className="label">Days</span>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((label, index) => (
              <button
                key={label}
                className={`btn btn-sm ${a.activeDays.includes(index) ? 'btn-primary' : ''}`}
                onClick={() =>
                  set({
                    activeDays: a.activeDays.includes(index)
                      ? a.activeDays.filter((d) => d !== index)
                      : [...a.activeDays, index].sort(),
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="Pacing"
        description="Delays are randomised within these ranges. Constant intervals are the most obvious signature of automation."
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Between fields, min (ms)">
            <NumberInput
              value={a.delayBetweenFieldsMs.min}
              onChange={(v) => set({ delayBetweenFieldsMs: { ...a.delayBetweenFieldsMs, min: v } })}
              min={0}
            />
          </Field>
          <Field label="Between fields, max (ms)">
            <NumberInput
              value={a.delayBetweenFieldsMs.max}
              onChange={(v) => set({ delayBetweenFieldsMs: { ...a.delayBetweenFieldsMs, max: v } })}
              min={0}
            />
          </Field>
          <Field label="Between applications, min (ms)">
            <NumberInput
              value={a.delayBetweenApplicationsMs.min}
              onChange={(v) => set({ delayBetweenApplicationsMs: { ...a.delayBetweenApplicationsMs, min: v } })}
              min={0}
              step={5000}
            />
          </Field>
          <Field label="Between applications, max (ms)">
            <NumberInput
              value={a.delayBetweenApplicationsMs.max}
              onChange={(v) => set({ delayBetweenApplicationsMs: { ...a.delayBetweenApplicationsMs, max: v } })}
              min={0}
              step={5000}
            />
          </Field>
        </div>
      </Section>

      <Section title="Scheduling and alerts">
        <Toggle
          checked={a.enabled}
          onChange={(v) => set({ enabled: v })}
          label="Let the agent start itself on a schedule"
          description="Without this the agent only runs when you press Start. The schedule checks every 30 minutes."
        />
        <Toggle checked={a.notifyOnSubmit} onChange={(v) => set({ notifyOnSubmit: v })} label="Notify me when an application is sent" />
        <Toggle
          checked={a.notifyOnReviewNeeded}
          onChange={(v) => set({ notifyOnReviewNeeded: v })}
          label="Notify me when something needs review"
        />
      </Section>

      <Section title="Where it may submit" description="Turn a site off to stop the agent submitting there entirely.">
        <div className="grid grid-cols-3 gap-2">
          {Object.entries(settings.enabledSites).map(([vendor, on]) => (
            <Toggle
              key={vendor}
              checked={on}
              onChange={(v) => patch({ enabledSites: { ...settings.enabledSites, [vendor]: v } })}
              label={VENDOR_LABELS[vendor] ?? vendor}
            />
          ))}
        </div>
        <p className="hint">
          Workday needs an account per employer, so it is off by default. Indeed discourages automation and is capped
          low even when enabled.
        </p>
      </Section>
    </div>
  )
}
