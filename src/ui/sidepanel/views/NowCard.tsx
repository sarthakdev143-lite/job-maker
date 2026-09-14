/**
 * What the agent is doing, right now, with a clock on it.
 *
 * This exists because every silent stretch looked identical to a crash. Three
 * things fix that, and all three have to be present at once:
 *
 *   - the coarse step, so you know where in the pipeline it is
 *   - the fine detail underneath it, updated as often as the work allows, which
 *     is what proves it is alive during a long model reply
 *   - an elapsed clock that ticks locally, so nothing ever looks frozen just
 *     because there was nothing new to report
 *
 * And when it genuinely is stuck, this says so plainly and offers the ways out
 * rather than leaving you to guess.
 */

import { api, openSettings, useAction, useNow } from '../../shared/api'
import { formatDuration, readActivity, type ActivityStep } from '@/shared/activity'
import type { AgentState } from '@/shared/messages'

const KIND_LABEL: Record<ActivityStep['kind'], string> = {
  idle: 'Idle',
  discovering: 'Searching',
  scoring: 'Scoring',
  applying: 'Applying',
  thinking: 'Thinking',
  paused: 'Paused',
  stopped: 'Stopped',
}

export default function NowCard({
  state,
  reachable,
  onRecheck,
}: {
  state: AgentState | null
  reachable: boolean
  onRecheck: () => void
}) {
  const now = useNow(500)
  const { run, busy } = useAction()

  const step = state?.step
  if (!step) return null

  const reading = readActivity(step, { now, running: state?.running ?? false, workerReachable: reachable })
  const tone =
    reading.health === 'stuck' || reading.health === 'unreachable'
      ? 'var(--bad)'
      : reading.health === 'slow'
        ? 'var(--warn)'
        : reading.health === 'working'
          ? 'var(--accent)'
          : 'var(--ink-faint)'

  const active = reading.health === 'working' || reading.health === 'slow'

  return (
    <div className="surface mb-3 px-3 py-2.5" style={{ borderColor: active ? tone : 'var(--line)' }}>
      <div className="flex items-start gap-2.5">
        <span
          className="mt-[3px] inline-block h-2 w-2 shrink-0 rounded-full"
          style={{
            background: tone,
            boxShadow: reading.health === 'working' ? `0 0 0 3px color-mix(in srgb, ${tone} 18%, transparent)` : 'none',
            animation: reading.health === 'working' ? 'pulse 1.6s ease-in-out infinite' : 'none',
          }}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: tone }}>
              {KIND_LABEL[step.kind]}
            </span>
            {active && (
              <span className="shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--ink-faint)' }}>
                {formatDuration(reading.elapsedMs)}
              </span>
            )}
          </div>

          <p className="mt-0.5 break-words text-[12.5px] font-medium">{step.label || 'Waiting'}</p>

          {step.detail && (
            <p className="mt-0.5 break-words text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>
              {step.detail}
            </p>
          )}

          {(reading.health === 'slow' || reading.health === 'stuck' || reading.health === 'unreachable') && (
            <div className="mt-2 rounded px-2 py-1.5" style={{ background: 'var(--warn-soft)' }}>
              <p className="text-[11.5px]" style={{ color: reading.health === 'slow' ? 'var(--warn)' : 'var(--bad)' }}>
                {reading.message}
              </p>

              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {reading.health === 'unreachable' ? (
                  <button className="btn btn-sm" onClick={() => chrome.runtime.reload()}>
                    Reload the extension
                  </button>
                ) : (
                  <>
                    <button
                      className="btn btn-sm"
                      disabled={!!busy}
                      onClick={() => run(() => api.openLlmLogin(), 'opening')}
                    >
                      Show me the model tab
                    </button>
                    <button className="btn btn-sm" disabled={!!busy} onClick={() => run(() => api.stop(), 'stopping')}>
                      Stop after this step
                    </button>
                    {reading.health === 'stuck' && (
                      <button className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => run(() => api.kill(), 'halting')}>
                        Force stop
                      </button>
                    )}
                  </>
                )}
              </div>

              {reading.health === 'slow' && (
                <p className="mt-1.5 text-[11px]" style={{ color: 'var(--ink-soft)' }}>
                  Chrome slows timers in minimised windows. If this keeps happening, turn off{' '}
                  <button
                    className="underline"
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit' }}
                    onClick={() => openSettings('model')}
                  >
                    Keep the worker window minimised
                  </button>
                  .
                </p>
              )}
            </div>
          )}

          {reading.health === 'idle' && !state?.running && (
            <button className="btn btn-ghost btn-sm mt-1.5" onClick={onRecheck}>
              Refresh
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
