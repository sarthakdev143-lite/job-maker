/**
 * Jobs: everything discovery found, grouped by what the agent decided.
 *
 * The rejected list matters as much as the queue -- it is how the user finds
 * out their rules are too tight, and every rejection carries the reason that
 * caused it.
 */

import { useState } from 'react'
import { api, useAction, useAsync, useWorkerEvents } from '../../shared/api'
import { Badge, Empty, Spinner, Tabs, scoreTone } from '../../shared/components'
import { formatRelative } from '@/shared/util'
import type { Job } from '@/storage/schemas'

type Bucket = 'queued' | 'new' | 'rejected' | 'applied' | 'skipped' | 'failed'

export default function JobsView() {
  const [bucket, setBucket] = useState<Bucket>('queued')
  const { tick } = useWorkerEvents(['evt:jobs'])
  const { data: jobs, loading, reload } = useAsync(() => api.listJobs(bucket, 150), [bucket, tick])
  const { run, busy } = useAction()

  return (
    <div>
      <Tabs
        tabs={[
          { id: 'queued' as const, label: 'Queued' },
          { id: 'new' as const, label: 'Unscored' },
          { id: 'rejected' as const, label: 'Filtered out' },
          { id: 'applied' as const, label: 'Applied' },
          { id: 'skipped' as const, label: 'Skipped' },
          { id: 'failed' as const, label: 'Failed' },
        ]}
        active={bucket}
        onChange={setBucket}
      />

      <div className="mt-3">
        {loading && !jobs && <Spinner label="Loading jobs" />}

        {jobs && jobs.length === 0 && (
          <Empty
            title={bucket === 'queued' ? 'Nothing queued' : 'Nothing here'}
            hint={
              bucket === 'queued'
                ? 'Run a search, then the agent scores what it finds and queues the good ones.'
                : undefined
            }
            action={
              bucket === 'queued' ? (
                <button
                  className="btn btn-sm"
                  disabled={!!busy}
                  onClick={() => run(async () => { await api.runDiscovery(); reload() }, 'searching')}
                >
                  {busy ? 'Searching…' : 'Search now'}
                </button>
              ) : undefined
            }
          />
        )}

        <div className="flex flex-col gap-2">
          {jobs?.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              busy={!!busy}
              onQueue={() => run(async () => { await api.queueJob(job.id); reload() }, 'queueing')}
              onSkip={() => run(async () => { await api.skipJob(job.id); reload() }, 'skipping')}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function JobCard({
  job,
  busy,
  onQueue,
  onSkip,
}: {
  job: Job
  busy: boolean
  onQueue: () => void
  onSkip: () => void
}) {
  const [open, setOpen] = useState(false)
  const tone = scoreTone(job.matchScore)

  return (
    <article className="surface px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen((v) => !v)}>
          <div className="truncate text-[12.5px] font-medium">{job.title || 'Untitled role'}</div>
          <div className="mt-0.5 truncate text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
            {job.company || 'Unknown company'}
            {job.location ? ` · ${job.location}` : ''}
            {job.workMode !== 'unknown' ? ` · ${job.workMode}` : ''}
          </div>
        </button>
        {job.matchScore !== null && (
          <span className="shrink-0">
            <Badge tone={tone === 'neutral' ? 'neutral' : tone}>{job.matchScore}</Badge>
          </span>
        )}
      </div>

      {job.rejectReason && (
        <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
          {job.rejectReason}
        </p>
      )}

      {open && (
        <div className="mt-2.5">
          {job.matchReasons.length > 0 && (
            <ul className="mb-1.5 flex flex-wrap gap-1">
              {job.matchReasons.map((r, i) => (
                <li key={i}>
                  <Badge tone="good">{r}</Badge>
                </li>
              ))}
            </ul>
          )}
          {job.matchConcerns.length > 0 && (
            <ul className="mb-1.5 flex flex-wrap gap-1">
              {job.matchConcerns.map((c, i) => (
                <li key={i}>
                  <Badge tone="warn">{c}</Badge>
                </li>
              ))}
            </ul>
          )}
          <p className="mono mb-2 whitespace-pre-wrap" style={{ color: 'var(--ink-soft)' }}>
            {job.descriptionText.slice(0, 900)}
            {job.descriptionText.length > 900 ? '…' : ''}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <a className="btn btn-sm" href={job.applyUrl || job.url} target="_blank" rel="noreferrer">
              Open posting
            </a>
            {job.status !== 'queued' && job.status !== 'applied' && (
              <button className="btn btn-sm" disabled={busy} onClick={onQueue}>
                Queue it
              </button>
            )}
            {job.status !== 'skipped' && job.status !== 'applied' && (
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onSkip}>
                Skip
              </button>
            )}
            <span className="ml-auto text-[11px]" style={{ color: 'var(--ink-faint)' }}>
              found {formatRelative(job.discoveredAt)} · {job.source}
            </span>
          </div>
        </div>
      )}
    </article>
  )
}
