/**
 * Review queue: the main place a person actually spends time.
 *
 * Everything the agent was not confident enough to submit lands here with its
 * full fill plan intact. Approving replays that plan and submits, so an edit
 * made here is exactly what the employer receives -- there is no second
 * resolution pass that could quietly overwrite it.
 *
 * Fields are ordered worst-first: unanswered required questions, then failures,
 * then low confidence, then everything that was fine. The user should be able
 * to fix what matters without scrolling past thirty correct answers.
 */

import { useMemo, useState } from 'react'
import { api, useAction, useAsync, useWorkerEvents } from '../../shared/api'
import { Badge, ConfirmButton, Empty, Spinner } from '../../shared/components'
import { formatRelative } from '@/shared/util'
import type { Application, FilledField } from '@/storage/schemas'

export default function ReviewView() {
  const { tick } = useWorkerEvents(['evt:applications'])
  const { data, loading, reload } = useAsync(
    async () => {
      const [review, dry, failed] = await Promise.all([
        api.listApplications('needs_review', 100),
        api.listApplications('dry_run', 50),
        api.listApplications('failed', 50),
      ])
      return [...review, ...dry, ...failed]
    },
    [tick]
  )

  if (loading && !data) return <Spinner label="Loading review queue" />
  if (data && data.length === 0) {
    return (
      <Empty
        title="Nothing waiting"
        hint="Applications the agent is unsure about appear here with every answer it planned to submit."
      />
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {data?.map((app) => (
        <ReviewCard key={app.id} application={app} onChanged={reload} />
      ))}
    </div>
  )
}

function ReviewCard({ application, onChanged }: { application: Application; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const { run, busy, error } = useAction()

  const ordered = useMemo(() => orderFields(application), [application])
  const unresolvedRequired = application.unresolved.filter((f) => f.required).length
  const failedCount = application.fillPlan.filter((f) => f.error).length
  /** The site declined an automated submission; a person has to press submit. */
  const refused = /refused the submission/i.test(application.error ?? '')

  const submit = () => {
    const merged: FilledField[] = [
      ...application.fillPlan.map((f) => (edits[f.selector] !== undefined ? { ...f, value: edits[f.selector]! } : f)),
      ...application.unresolved
        .filter((f) => (edits[f.selector] ?? '').trim())
        .map<FilledField>((f) => ({
          selector: f.selector,
          label: f.label,
          kind: f.kind,
          value: edits[f.selector] ?? '',
          confidence: 1,
          source: 'user',
          reasoning: 'answered in review',
          verified: false,
          error: '',
          required: f.required,
        })),
    ]
    void run(async () => {
      await api.approve(application.id, merged)
      onChanged()
    }, 'submitting')
  }

  return (
    <article className="surface px-3 py-2.5">
      <button className="w-full text-left" onClick={() => setOpen((v) => !v)}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-medium">{application.title || 'Untitled role'}</div>
            <div className="mt-0.5 truncate text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
              {application.company} · {application.vendor} · {formatRelative(application.updatedAt)}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge tone={application.status === 'failed' ? 'bad' : 'warn'}>
              {application.status === 'dry_run' ? 'dry run' : application.status.replace('_', ' ')}
            </Badge>
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--ink-faint)' }}>
              {Math.round(application.confidence * 100)}% filled
            </span>
          </div>
        </div>
      </button>

      <div className="mt-1.5 flex flex-wrap gap-1">
        {unresolvedRequired > 0 && <Badge tone="bad">{unresolvedRequired} required unanswered</Badge>}
        {failedCount > 0 && <Badge tone="warn">{failedCount} did not stick</Badge>}
        {application.matchScore !== null && <Badge>match {application.matchScore}</Badge>}
        {application.error && !refused && <Badge tone="bad">{application.error.slice(0, 60)}</Badge>}
      </div>

      {/*
        A refusal is not a mistake to fix, so it does not belong in the same row
        as "3 required unanswered". The site declined an automated submission --
        every answer is already in the form, and the only thing left is a person
        pressing the button. Say that, quote the site, and open the page.
      */}
      {refused && (
        <div
          className="mt-2 rounded-md px-2.5 py-2 text-[11.5px]"
          style={{ background: 'color-mix(in srgb, var(--warn) 12%, transparent)' }}
        >
          <div style={{ color: 'var(--warn)' }}>{application.error}</div>
          <p className="mt-1" style={{ color: 'var(--ink-faint)' }}>
            Everything was filled in and the documents attached. This board checks whether a person is driving
            the browser, so the last click has to be yours.
          </p>
          {application.url && (
            <button
              className="btn btn-primary mt-2"
              onClick={(e) => {
                e.stopPropagation()
                void chrome.tabs.create({ url: application.url })
              }}
            >
              Open the form and finish it
            </button>
          )}
        </div>
      )}

      {open && (
        <div className="mt-3">
          {error && (
            <p className="mb-2 text-[11.5px]" style={{ color: 'var(--bad)' }}>
              {error}
            </p>
          )}

          <div className="flex flex-col gap-2">
            {ordered.map((row) => (
              <FieldRow
                key={row.selector}
                row={row}
                value={edits[row.selector] ?? row.value}
                onChange={(v) => setEdits((e) => ({ ...e, [row.selector]: v }))}
              />
            ))}
          </div>

          {application.docs.coverLetterText && (
            <details className="mt-3">
              <summary className="cursor-pointer text-[12px] font-medium">Cover letter</summary>
              <p className="mono mt-1.5 whitespace-pre-wrap" style={{ color: 'var(--ink-soft)' }}>
                {application.docs.coverLetterText}
              </p>
            </details>
          )}

          <details className="mt-2">
            <summary className="cursor-pointer text-[12px] font-medium">
              Timeline ({application.timeline.length})
            </summary>
            <ul className="mono mt-1.5 flex flex-col gap-0.5">
              {application.timeline.slice(-30).map((t, i) => (
                <li
                  key={i}
                  style={{ color: t.level === 'error' ? 'var(--bad)' : t.level === 'warn' ? 'var(--warn)' : 'var(--ink-faint)' }}
                >
                  {new Date(t.at).toLocaleTimeString()} {t.step}
                  {t.detail ? ` — ${t.detail}` : ''}
                </li>
              ))}
            </ul>
          </details>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={submit}>
              {busy === 'submitting' ? 'Submitting…' : 'Approve and submit'}
            </button>
            <a className="btn btn-sm" href={application.url} target="_blank" rel="noreferrer">
              Open form
            </a>
            {application.status === 'failed' && (
              <button
                className="btn btn-sm"
                disabled={!!busy}
                onClick={() => run(async () => { await api.retry(application.id); onChanged() }, 'retrying')}
              >
                Try again
              </button>
            )}
            <ConfirmButton
              className="btn btn-ghost btn-sm ml-auto"
              confirmLabel="Discard it?"
              onConfirm={() => void run(async () => { await api.reject(application.id); onChanged() }, 'discarding')}
            >
              Discard
            </ConfirmButton>
          </div>
        </div>
      )}
    </article>
  )
}

type Row = {
  selector: string
  label: string
  kind: string
  value: string
  confidence: number
  source: string
  reasoning: string
  error: string
  required: boolean
  state: 'unanswered' | 'failed' | 'uncertain' | 'ok'
}

function orderFields(app: Application): Row[] {
  const planned: Row[] = app.fillPlan.map((f) => ({
    selector: f.selector,
    label: f.label,
    kind: f.kind,
    value: f.value,
    confidence: f.confidence,
    source: f.source,
    reasoning: f.reasoning,
    error: f.error,
    required: f.required,
    state: f.error ? 'failed' : f.confidence < 0.8 ? 'uncertain' : 'ok',
  }))

  const unanswered: Row[] = app.unresolved.map((f) => ({
    selector: f.selector,
    label: f.label,
    kind: f.kind,
    value: '',
    confidence: 0,
    source: 'none',
    reasoning: '',
    error: '',
    required: f.required,
    state: 'unanswered',
  }))

  const rank: Record<Row['state'], number> = { unanswered: 0, failed: 1, uncertain: 2, ok: 3 }
  return [...unanswered, ...planned].sort(
    (a, b) => rank[a.state] - rank[b.state] || Number(b.required) - Number(a.required)
  )
}

function FieldRow({ row, value, onChange }: { row: Row; value: string; onChange: (v: string) => void }) {
  const tone =
    row.state === 'unanswered' ? 'var(--bad)' : row.state === 'failed' ? 'var(--warn)' : row.state === 'uncertain' ? 'var(--warn)' : 'var(--line)'

  return (
    <div className="rounded-md px-2.5 py-2" style={{ background: 'var(--bg-soft)', borderLeft: `2px solid ${tone}` }}>
      <div className="mb-1 flex items-start justify-between gap-2">
        <span className="text-[11.5px] font-medium">
          {row.label || row.selector}
          {row.required && <span style={{ color: 'var(--bad)' }}> *</span>}
        </span>
        <span className="shrink-0 text-[10.5px] tabular-nums" style={{ color: 'var(--ink-faint)' }}>
          {row.state === 'unanswered' ? 'unanswered' : `${row.source} · ${Math.round(row.confidence * 100)}%`}
        </span>
      </div>

      {row.kind === 'textarea' ? (
        <textarea className="textarea" rows={4} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="input" value={value} onChange={(e) => onChange(e.target.value)} />
      )}

      {(row.error || row.reasoning) && (
        <p className="mt-1 text-[11px]" style={{ color: row.error ? 'var(--warn)' : 'var(--ink-faint)' }}>
          {row.error || row.reasoning}
        </p>
      )}
    </div>
  )
}
