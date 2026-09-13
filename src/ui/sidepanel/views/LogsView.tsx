/**
 * The audit log.
 *
 * An agent acting on someone's behalf has to be inspectable after the fact, so
 * every decision it makes is written here. New lines arrive by broadcast and
 * are prepended live while the panel is open.
 */

import { useEffect, useState } from 'react'
import { api, useAction, useAsync, useWorkerEvents } from '../../shared/api'
import { ConfirmButton, Empty, Spinner } from '../../shared/components'
import type { LogEvent } from '@/storage/schemas'

type Level = 'all' | 'info' | 'warn' | 'error'

export default function LogsView() {
  const [level, setLevel] = useState<Level>('all')
  const { data, loading, reload } = useAsync(() => api.listLogs(400), [])
  const { logLine } = useWorkerEvents(['evt:log'])
  const [live, setLive] = useState<LogEvent[]>([])
  const { run } = useAction()

  useEffect(() => {
    if (!logLine) return
    setLive((prev) =>
      [
        {
          id: `live_${logLine.at}_${Math.random()}`,
          at: logLine.at,
          level: logLine.level as LogEvent['level'],
          scope: logLine.scope,
          message: logLine.message,
          jobId: '',
        },
        ...prev,
      ].slice(0, 200)
    )
  }, [logLine])

  const merged = [...live, ...(data ?? [])]
  const filtered = level === 'all' ? merged : merged.filter((l) => l.level === level)

  if (loading && !data) return <Spinner label="Loading log" />

  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5">
        {(['all', 'info', 'warn', 'error'] as const).map((l) => (
          <button
            key={l}
            className={`btn btn-sm ${level === l ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setLevel(l)}
          >
            {l}
          </button>
        ))}
        <ConfirmButton
          className="btn btn-ghost btn-sm ml-auto"
          confirmLabel="Clear it?"
          onConfirm={() => void run(async () => { await api.clearLogs(); setLive([]); reload() })}
        >
          Clear
        </ConfirmButton>
      </div>

      {filtered.length === 0 ? (
        <Empty title="Nothing logged yet" />
      ) : (
        <ul className="flex flex-col">
          {filtered.slice(0, 400).map((entry) => (
            <li
              key={entry.id}
              className="mono flex gap-2 py-1"
              style={{ borderBottom: '1px solid var(--line)' }}
            >
              <span className="shrink-0 tabular-nums" style={{ color: 'var(--ink-faint)' }}>
                {new Date(entry.at).toLocaleTimeString()}
              </span>
              <span className="shrink-0" style={{ color: levelColor(entry.level), minWidth: 62 }}>
                {entry.scope}
              </span>
              <span className="min-w-0 break-words" style={{ color: entry.level === 'error' ? 'var(--bad)' : 'var(--ink)' }}>
                {entry.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function levelColor(level: string): string {
  if (level === 'error') return 'var(--bad)'
  if (level === 'warn') return 'var(--warn)'
  return 'var(--ink-faint)'
}
