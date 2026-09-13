/**
 * The side panel: the agent's console.
 *
 * Five views, one always-visible header. The header carries the things the user
 * needs regardless of where they are -- is it running, is the model reachable,
 * how many applications went out today, and the stop button.
 */

import { useEffect, useMemo, useState } from 'react'
import { api, useAction, useAsync, useWorkerEvents } from '../shared/api'
import { Badge, ErrorBar, ProgressBar, Tabs } from '../shared/components'
import Dashboard from './views/Dashboard'
import JobsView from './views/JobsView'
import ReviewView from './views/ReviewView'
import ApplicationsView from './views/ApplicationsView'
import LogsView from './views/LogsView'
import type { AgentState } from '@/shared/messages'

type TabId = 'dashboard' | 'jobs' | 'review' | 'applications' | 'logs'

export default function App() {
  const [tab, setTab] = useState<TabId>('dashboard')
  const { state: pushed, tick } = useWorkerEvents(['evt:state', 'evt:jobs', 'evt:applications'])
  const { data: polled, reload } = useAsync(() => api.getState(), [])
  const { run, busy, error, clearError } = useAction()

  const state: AgentState | null = pushed ?? polled

  // The worker can be evicted between broadcasts, so poll slowly as a backstop.
  useEffect(() => {
    const id = setInterval(reload, 15000)
    return () => clearInterval(id)
  }, [reload])

  useEffect(() => {
    if (tick > 0) reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  const tabs = useMemo(
    () => [
      { id: 'dashboard' as const, label: 'Agent' },
      { id: 'jobs' as const, label: 'Jobs', badge: state?.queueDepth ?? 0 },
      { id: 'review' as const, label: 'Review', badge: state?.reviewDepth ?? 0 },
      { id: 'applications' as const, label: 'Sent' },
      { id: 'logs' as const, label: 'Log' },
    ],
    [state?.queueDepth, state?.reviewDepth]
  )

  const running = state?.running ?? false

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--bg)' }}>
      <header className="shrink-0 px-3 pt-3" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{
                background: running ? 'var(--good)' : state?.phase === 'error' ? 'var(--bad)' : 'var(--ink-faint)',
                boxShadow: running ? '0 0 0 3px var(--good-soft)' : 'none',
              }}
            />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">AutoApply</div>
              <div className="truncate text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                {state?.currentStep || phaseLabel(state)}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Badge tone={state?.appliedToday && state.appliedToday >= state.dailyCap ? 'warn' : 'neutral'}>
              {state?.appliedToday ?? 0}/{state?.dailyCap ?? 0} today
            </Badge>
            {running ? (
              <button className="btn btn-sm" disabled={!!busy} onClick={() => run(() => api.stop(), 'stopping')}>
                Stop
              </button>
            ) : (
              <button
                className="btn btn-primary btn-sm"
                disabled={!!busy}
                onClick={() => run(async () => void (await api.start()), 'starting')}
              >
                Start
              </button>
            )}
          </div>
        </div>

        <div className="-mx-1 mt-2">
          <ProgressBar active={running && state?.phase !== 'paused'} />
        </div>

        <div className="mt-1">
          <Tabs tabs={tabs} active={tab} onChange={setTab} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <ErrorBar message={error || state?.lastError || ''} onDismiss={clearError} />

        {state && state.llmHealth !== 'ok' && state.llmHealth !== 'unknown' && (
          <div
            className="mb-3 flex items-center justify-between gap-2 rounded-md px-3 py-2 text-[12px]"
            style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}
          >
            <span>
              {state.llmHealth === 'needs_login'
                ? 'DeepSeek needs you to sign in before the agent can think.'
                : 'The language model is unreachable.'}
            </span>
            <button
              className="btn btn-sm"
              style={{ color: 'inherit' }}
              onClick={() => run(() => api.openLlmLogin(), 'opening')}
            >
              Open
            </button>
          </div>
        )}

        {tab === 'dashboard' && <Dashboard state={state} onNavigate={setTab} />}
        {tab === 'jobs' && <JobsView />}
        {tab === 'review' && <ReviewView />}
        {tab === 'applications' && <ApplicationsView />}
        {tab === 'logs' && <LogsView />}
      </div>
    </div>
  )
}

function phaseLabel(state: AgentState | null): string {
  if (!state) return 'connecting'
  switch (state.phase) {
    case 'discovering':
      return 'searching for jobs'
    case 'scoring':
      return 'scoring matches'
    case 'applying':
      return 'applying'
    case 'paused':
      return 'paused'
    case 'stopped':
      return 'stopped'
    case 'error':
      return 'needs attention'
    default:
      return state.running ? 'running' : 'idle'
  }
}
