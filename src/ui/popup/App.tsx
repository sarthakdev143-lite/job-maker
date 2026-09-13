/**
 * Toolbar popup: status at a glance, and the three things worth doing in one
 * click. Anything more involved opens the side panel or the settings page.
 */

import { api, useAction, useAsync } from '../shared/api'
import { Badge, ErrorBar } from '../shared/components'

export default function App() {
  const { data: state, reload } = useAsync(() => api.getState(), [])
  const { run, busy, error, clearError } = useAction()

  const openPanel = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId })
    window.close()
  }

  const running = state?.running ?? false

  return (
    <div className="p-3" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: running ? 'var(--good)' : 'var(--ink-faint)' }}
          />
          <span className="text-[13px] font-semibold">AutoApply</span>
        </div>
        <Badge tone={running ? 'good' : 'neutral'}>{running ? 'running' : 'idle'}</Badge>
      </div>

      <ErrorBar message={error} onDismiss={clearError} />

      <div className="surface mb-3 px-3 py-2">
        <Line label="Sent today" value={`${state?.appliedToday ?? 0} of ${state?.dailyCap ?? 0}`} />
        <Line label="Queued" value={`${state?.queueDepth ?? 0}`} />
        <Line label="Awaiting review" value={`${state?.reviewDepth ?? 0}`} />
        <Line
          label="Model"
          value={
            state?.llmHealth === 'ok' ? 'ready' : state?.llmHealth === 'needs_login' ? 'sign in needed' : 'unknown'
          }
        />
        {state?.currentStep && (
          <p className="mt-1.5 truncate text-[11px]" style={{ color: 'var(--ink-faint)' }}>
            {state.currentStep}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        {running ? (
          <button
            className="btn"
            disabled={!!busy}
            onClick={() => run(async () => { await api.stop(); reload() }, 'stopping')}
          >
            Stop the agent
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={!!busy}
            onClick={() => run(async () => { await api.start(); reload() }, 'starting')}
          >
            Start the agent
          </button>
        )}
        <button className="btn" onClick={openPanel}>
          Open console
        </button>
        <button className="btn btn-ghost" onClick={() => chrome.runtime.openOptionsPage()}>
          Settings
        </button>
      </div>
    </div>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-[12px]">
      <span style={{ color: 'var(--ink-faint)' }}>{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}
