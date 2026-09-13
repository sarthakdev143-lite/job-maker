/**
 * Dashboard: what the agent is doing, what it has done, and — when it is not
 * doing anything — exactly why not.
 *
 * The readiness list is the answer to "I pressed Start and nothing happened".
 * Every condition that would make a run pointless is checked and named here,
 * with a link straight to the setting that fixes it, rather than being left to
 * a log line the user has no reason to go looking for.
 */

import { useState } from 'react'
import { api, openSettings, useAction, useAsync, type PreflightCheck } from '../../shared/api'
import { Badge, ConfirmButton, Empty, Spinner, Stat } from '../../shared/components'
import { formatRelative } from '@/shared/util'
import type { AgentState } from '@/shared/messages'

export default function Dashboard({
  state,
  onNavigate,
}: {
  state: AgentState | null
  onNavigate: (tab: 'jobs' | 'review' | 'applications') => void
}) {
  const { data: stats, loading, reload } = useAsync(() => api.stats(), [state?.updatedAt])
  const { data: checks, loading: checking, reload: recheck } = useAsync(() => api.preflight(), [])
  const { run, busy } = useAction()
  const [setupNote, setSetupNote] = useState('')

  if (loading && !stats) return <Spinner label="Reading agent state" />

  const blockers = (checks ?? []).filter((c) => c.blocking && !c.ok)
  const warnings = (checks ?? []).filter((c) => !c.blocking && !c.ok)
  const running = state?.running ?? false

  return (
    <div>
      {blockers.length > 0 && !running && (
        <div className="mb-3 rounded-md px-3 py-2.5" style={{ background: 'var(--bad-soft)' }}>
          <p className="text-[12.5px] font-medium" style={{ color: 'var(--bad)' }}>
            The agent cannot run yet — {blockers.length} thing{blockers.length === 1 ? '' : 's'} to fix.
          </p>
          <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>
            Pressing Start will refuse until these are sorted. Each one links to where it is fixed.
          </p>

          {/*
            Having nowhere to look is the one blocker the agent can fix for
            itself, so it offers to rather than sending the user to another
            screen to do it by hand.
          */}
          {blockers.some((c) => c.id === 'searches') && (
            <div className="mt-2">
              <button
                className="btn btn-primary btn-sm"
                disabled={!!busy}
                onClick={() =>
                  run(async () => {
                    const result = await api.setupSearches()
                    setSetupNote(
                      result.needsManual
                        ? 'The model would not name any boards it was sure of. Open Searches and add one by hand.'
                        : `Created and switched on — ${result.created.join('; ')}`
                    )
                    recheck()
                    reload()
                  }, 'setting up searches')
                }
              >
                {busy === 'setting up searches' ? 'Reading your profile…' : 'Set up searches for me'}
              </button>
              <p className="mt-1 text-[11px]" style={{ color: 'var(--ink-soft)' }}>
                Builds real searches from your profile. Takes about half a minute.
              </p>
              {setupNote && (
                <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--ink)' }}>
                  {setupNote}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mb-3 grid grid-cols-2 gap-2">
        <Stat label="Sent today" value={`${state?.appliedToday ?? 0}`} />
        <Stat label="Total sent" value={`${stats?.submittedTotal ?? 0}`} tone="good" />
        <Stat label="Queued" value={`${state?.queueDepth ?? 0}`} />
        <Stat
          label="Awaiting review"
          value={`${state?.reviewDepth ?? 0}`}
          tone={(state?.reviewDepth ?? 0) > 0 ? 'warn' : undefined}
        />
      </div>

      <div className="surface mb-3 px-3 py-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium">Readiness</span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={checking}
            onClick={() => recheck()}
          >
            {checking ? 'Checking…' : 'Re-check'}
          </button>
        </div>

        {checking && !checks && <Spinner label="Checking" />}

        <ul className="flex flex-col">
          {(checks ?? []).map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </ul>

        {blockers.length === 0 && warnings.length > 0 && (
          <p className="mt-2 text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
            It will start, but nothing will be submitted until the amber items above change.
          </p>
        )}
      </div>

      <div className="surface mb-3 px-3 py-2.5">
        <div className="mb-2 text-[12px] font-medium">Actions</div>
        <div className="flex flex-wrap gap-1.5">
          <button className="btn btn-sm" onClick={() => openSettings()}>
            Settings
          </button>
          <button
            className="btn btn-sm"
            disabled={!!busy}
            onClick={() =>
              run(async () => {
                await api.runDiscovery()
                reload()
                recheck()
              }, 'searching')
            }
          >
            {busy === 'searching' ? 'Searching…' : 'Search now'}
          </button>
          <ConfirmButton
            className="btn btn-danger btn-sm"
            confirmLabel="Halt everything?"
            onConfirm={() => void run(() => api.kill(), 'halting')}
          >
            Kill switch
          </ConfirmButton>
        </div>
      </div>

      {(state?.reviewDepth ?? 0) > 0 && (
        <button className="surface mb-3 w-full px-3 py-2.5 text-left row-hover" onClick={() => onNavigate('review')}>
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] font-medium">
              {state?.reviewDepth} application{state?.reviewDepth === 1 ? '' : 's'} need a look
            </span>
            <span style={{ color: 'var(--accent)' }}>→</span>
          </div>
          <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
            Check the answers, then approve to submit.
          </p>
        </button>
      )}

      <div className="surface px-3 py-2.5">
        <div className="mb-2 text-[12px] font-medium">Numbers</div>
        <Row label="Model queue" value={`${stats?.llmQueueDepth ?? 0} waiting`} />
        <Row label="Answers learned" value={`${stats?.answers ?? 0}`} />
        <Row label="Average score of sent" value={stats?.averageScore ? `${stats.averageScore}` : '—'} />
        <Row label="Jobs stored" value={`${stats?.storage.jobs ?? 0}`} />
        <Row label="Last activity" value={formatRelative(state?.updatedAt ?? null)} />
      </div>

      {!stats?.submittedTotal && blockers.length === 0 && (
        <div className="mt-3">
          <Empty
            title="Nothing sent yet"
            hint="Everything is ready. Press Start, and watch the Review tab — in dry run mode it fills forms without submitting them."
          />
        </div>
      )}
    </div>
  )
}

function CheckRow({ check }: { check: PreflightCheck }) {
  const tone = check.ok ? 'var(--good)' : check.blocking ? 'var(--bad)' : 'var(--warn)'
  const mark = check.ok ? '✓' : check.blocking ? '✕' : '!'

  return (
    <li className="flex items-start gap-2 py-1.5" style={{ borderTop: '1px solid var(--line)' }}>
      <span className="mt-[1px] w-3 shrink-0 text-center text-[12px] font-semibold" style={{ color: tone }}>
        {mark}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px]">{check.label}</div>
        <div className="text-[11px]" style={{ color: check.ok ? 'var(--ink-faint)' : tone }}>
          {check.detail}
        </div>
      </div>
      {!check.ok && check.fix && (
        <button className="btn btn-ghost btn-sm shrink-0" onClick={() => openSettings(check.fix)}>
          Fix
        </button>
      )}
    </li>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1 text-[12px]">
      <span style={{ color: 'var(--ink-faint)' }}>{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

export function HealthChip({ health }: { health: string }) {
  if (health === 'ok') return <Badge tone="good">ready</Badge>
  if (health === 'needs_login') return <Badge tone="warn">sign in</Badge>
  if (health === 'unreachable') return <Badge tone="bad">unreachable</Badge>
  return <Badge>unknown</Badge>
}
