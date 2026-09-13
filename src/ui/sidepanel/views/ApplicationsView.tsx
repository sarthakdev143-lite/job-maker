/** Sent applications, newest first, with the documents that went with them. */

import { useState } from 'react'
import { api, download, useAction, useAsync, useWorkerEvents } from '../../shared/api'
import { Badge, Empty, Spinner, statusTone } from '../../shared/components'
import { formatRelative } from '@/shared/util'
import type { Application } from '@/storage/schemas'

export default function ApplicationsView() {
  const { tick } = useWorkerEvents(['evt:applications'])
  const { data, loading } = useAsync(() => api.listApplications('submitted', 200), [tick])
  const { run } = useAction()

  if (loading && !data) return <Spinner label="Loading applications" />
  if (data && data.length === 0) {
    return <Empty title="No applications sent yet" hint="Submitted applications and their documents are kept here." />
  }

  return (
    <div className="flex flex-col gap-2">
      {data?.map((app) => (
        <Row key={app.id} app={app} onDownload={(id) => run(async () => {
          const doc = await api.downloadDoc(id)
          await download(doc.dataUrl, doc.fileName)
        }, 'downloading')} />
      ))}
    </div>
  )
}

function Row({ app, onDownload }: { app: Application; onDownload: (docId: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <article className="surface px-3 py-2.5">
      <button className="w-full text-left" onClick={() => setOpen((v) => !v)}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-medium">{app.title}</div>
            <div className="mt-0.5 truncate text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
              {app.company} · sent {formatRelative(app.submittedAt)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {app.matchScore !== null && <Badge>{app.matchScore}</Badge>}
            <Badge tone={statusTone(app.status)}>{app.status}</Badge>
          </div>
        </div>
      </button>

      {open && (
        <div className="mt-2.5">
          <div className="flex flex-wrap gap-1.5">
            <a className="btn btn-sm" href={app.url} target="_blank" rel="noreferrer">
              Open posting
            </a>
            {app.docs.resumeDocId && (
              <button className="btn btn-sm" onClick={() => onDownload(app.docs.resumeDocId)}>
                Resume sent
              </button>
            )}
            {app.docs.coverDocId && (
              <button className="btn btn-sm" onClick={() => onDownload(app.docs.coverDocId)}>
                Cover letter
              </button>
            )}
          </div>

          <details className="mt-2">
            <summary className="cursor-pointer text-[12px] font-medium">
              Answers submitted ({app.fillPlan.length})
            </summary>
            <dl className="mt-1.5 flex flex-col gap-1">
              {app.fillPlan.map((f) => (
                <div key={f.selector} className="rounded px-2 py-1" style={{ background: 'var(--bg-soft)' }}>
                  <dt className="text-[11px] font-medium" style={{ color: 'var(--ink-faint)' }}>
                    {f.label || f.selector}
                  </dt>
                  <dd className="mono break-words">{f.value}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      )}
    </article>
  )
}
