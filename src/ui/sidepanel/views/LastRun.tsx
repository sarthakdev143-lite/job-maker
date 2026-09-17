/**
 * Last run: the morning-after screen.
 *
 * "Found? filtered? attempted? submitted? why not?" used to require stitching
 * the log, three job tabs and the review queue together by hand -- and after a
 * worker restart even the one-line summary was gone. This card reads the
 * persisted cycle record, so a night that produced nothing still says exactly
 * what it did and what stopped it, in one place.
 */

import { api, useAsync } from '../../shared/api'
import { Spinner } from '../../shared/components'
import { formatRelative } from '@/shared/util'
import type { CycleSummary } from '@/background/run-history'

const OUTCOME_LABEL: Record<CycleSummary['outcome'], { text: string; color: string }> = {
  completed: { text: 'completed', color: 'var(--good)' },
  'paused-hours': { text: 'paused · hours', color: 'var(--warn)' },
  'paused-cap': { text: 'paused · cap', color: 'var(--warn)' },
  stopped: { text: 'stopped', color: 'var(--ink-faint)' },
  'error-circuit': { text: 'circuit breaker', color: 'var(--bad)' },
  error: { text: 'error', color: 'var(--bad)' },
}

export default function LastRun({ tick }: { tick: unknown }) {
  const { data: last, loading } = useAsync(() => api.getLastRun(), [tick])

  if (loading && !last) {
    return (
      <div className="surface mb-3 px-3 py-2.5">
        <Spinner label="Reading last run" />
      </div>
    )
  }
  if (!last) {
    return (
      <div className="surface mb-3 px-3 py-2.5">
        <div className="mb-1 text-[12px] font-medium">Last run</div>
        <p className="text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
          No completed cycle yet. Press Start and the funnel will appear here.
        </p>
      </div>
    )
  }

  const outcome = OUTCOME_LABEL[last.outcome]
  const funnel: Array<[string, number]> = [
    ['found', last.found],
    ['scored', last.scored],
    ['queued', last.queued],
    ['attempted', last.attempted],
    ['submitted', last.submitted],
  ]
  const parked: Array<[string, number]> = (
    [
      ['parked', last.parked],
      ['skipped', last.skipped],
      ['failed', last.failed],
    ] as Array<[string, number]>
  ).filter(([, n]) => n > 0)
  const gateReasons = Object.entries(last.gateReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
  const blockedRecipes = Object.entries(last.perRecipe).filter(([, r]) => r.error)

  return (
    <div className="surface mb-3 px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium">Last run</span>
        <span className="text-[11px]" style={{ color: 'var(--ink-faint)' }}>
          {formatRelative(last.endedAt)} · <span style={{ color: outcome.color }}>{outcome.text}</span>
        </span>
      </div>

      <p className="text-[12px]" style={{ color: 'var(--ink)' }}>
        {last.note}
      </p>

      <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>
        {funnel.map(([label, n]) => `${n} ${label}`).join(' → ')}
        {last.duplicates > 0 || last.rejected > 0
          ? ` (${last.duplicates} dupes, ${last.rejected} filtered out)`
          : ''}
        {parked.length > 0 ? ` · ${parked.map(([label, n]) => `${n} ${label}`).join(', ')}` : ''}
        {last.blocked > 0 ? ` · ${last.blocked} recipe(s) blocked` : ''}
        {last.scoreFailed > 0 ? ` · ${last.scoreFailed} unscored` : ''}
      </p>

      {gateReasons.length > 0 && (
        <ul className="mt-1.5">
          {gateReasons.map(([reason, n]) => (
            <li key={reason} className="text-[11.5px]" style={{ color: 'var(--warn)' }}>
              {n}× {reason}
            </li>
          ))}
        </ul>
      )}

      {blockedRecipes.length > 0 && (
        <ul className="mt-1.5">
          {blockedRecipes.map(([id, r]) => (
            <li key={id} className="text-[11.5px]" style={{ color: 'var(--bad)' }}>
              Blocked: {r.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
