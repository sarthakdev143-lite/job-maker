/**
 * Resume import.
 *
 * The first thing on the profile page, because filling thirty fields by hand
 * when the extension already has a model attached is busywork. Drop a PDF, get
 * a profile.
 *
 * The import is deliberately not silent: it reports what it filled, what it
 * left alone, and what a resume simply cannot tell it (expected salary, notice
 * period, work authorisation). Those last few are the fields that decide
 * whether an application is answered honestly, so the user is told plainly that
 * they still have to answer them.
 */

import { useCallback, useRef, useState } from 'react'
import { api, useAction, useWorkerEvents, type ResumeImportResult } from '../../shared/api'
import { extractResumeText } from '../../shared/resume-file'
import { Badge, TextArea } from '../../shared/components'
import type { Profile } from '@/storage/schemas'

type Mode = 'fill_empty' | 'replace'

export default function ResumeImport({
  profile,
  onImported,
}: {
  profile: Profile
  onImported: (profile: Profile) => void
}) {
  const [mode, setMode] = useState<Mode>('fill_empty')
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState('')
  const [dragging, setDragging] = useState(false)
  const [fileName, setFileName] = useState('')
  const [status, setStatus] = useState('')
  const [result, setResult] = useState<ResumeImportResult | null>(null)
  const { run, busy, error, clearError } = useAction()
  // A resume parse is a multi-minute model call. Without this the page shows a
  // frozen "Reading your resume..." and gives no way to tell work from a hang.
  const { activity } = useWorkerEvents(['evt:activity'])
  const inputRef = useRef<HTMLInputElement>(null)

  const hasProfile = Boolean(profile.firstName || profile.experience.length > 0)

  const importText = useCallback(
    (text: string, label: string) =>
      run(async () => {
        setResult(null)
        setStatus(`Reading ${label}…`)
        const imported = await api.parseResume(text, mode)
        setResult(imported)
        setStatus('')
        onImported(imported.profile)
      }, 'importing'),
    [mode, onImported, run]
  )

  const handleFile = useCallback(
    (file: File) =>
      run(async () => {
        setResult(null)
        clearError()
        setFileName(file.name)
        setStatus(`Extracting text from ${file.name}…`)
        const extracted = await extractResumeText(file)
        if (!extracted.text.trim()) {
          throw new Error(
            `No text found in ${file.name}. If it is a scanned image, the text has to be typed or pasted instead.`
          )
        }
        setStatus('Reading your resume…')
        const imported = await api.parseResume(extracted.text, mode)
        setResult(imported)
        setStatus('')
        onImported(imported.profile)
      }, 'importing'),
    [clearError, mode, onImported, run]
  )

  const importing = busy === 'importing'

  return (
    <section className="mb-6">
      <div
        className="surface px-4 py-4"
        style={{ borderColor: hasProfile ? 'var(--line)' : 'var(--accent)' }}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold">
              {hasProfile ? 'Update from a resume' : 'Start with your resume'}
            </h2>
            <p className="mt-0.5 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
              Drop a PDF and the model fills in everything below — name, contact details, every role and its bullets,
              education, skills. You check it afterwards rather than typing it.
            </p>
          </div>
          <button className="btn btn-ghost btn-sm shrink-0" onClick={() => setPasting((v) => !v)}>
            {pasting ? 'Upload a file' : 'Paste text instead'}
          </button>
        </div>

        {pasting ? (
          <div>
            <TextArea
              value={pasted}
              onChange={setPasted}
              rows={10}
              placeholder="Paste the full text of your resume here…"
            />
            <button
              className="btn btn-primary btn-sm mt-2"
              disabled={importing || pasted.trim().length < 80}
              onClick={() => importText(pasted, 'pasted text')}
            >
              {importing ? 'Reading…' : 'Read it and fill my profile'}
            </button>
          </div>
        ) : (
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              const file = e.dataTransfer.files?.[0]
              if (file) void handleFile(file)
            }}
            onClick={() => inputRef.current?.click()}
            className="flex cursor-pointer flex-col items-center justify-center rounded-lg px-4 py-8 text-center transition-colors"
            style={{
              border: `1.5px dashed ${dragging ? 'var(--accent)' : 'var(--line-strong)'}`,
              background: dragging ? 'var(--accent-soft)' : 'var(--bg-soft)',
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,application/pdf,text/plain"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleFile(file)
                e.target.value = ''
              }}
            />
            <p className="text-[13px] font-medium">
              {importing ? status || 'Working…' : 'Drop your resume here, or click to choose'}
            </p>
            <p className="mt-1 text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
              PDF, .docx or plain text. It is read on this machine; only the text goes to the model.
            </p>
            {fileName && !importing && (
              <p className="mt-2 text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
                last read: {fileName}
              </p>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
            When it finds something
          </span>
          {(
            [
              ['fill_empty', 'Only fill blanks'],
              ['replace', 'Replace what I have'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={`btn btn-sm ${mode === id ? 'btn-primary' : ''}`}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
          <span className="text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
            {mode === 'fill_empty'
              ? 'Anything you have already written is kept.'
              : 'The resume wins wherever it states a value.'}
          </span>
        </div>

        {importing && (
          <div className="mt-3">
            <div className="h-[3px] w-full overflow-hidden rounded-full progress-indeterminate" style={{ background: 'var(--bg-soft)' }} />
            <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
              {status || 'Reading your resume…'} A model that answers quickly takes under a minute; on a
              slow or unsuitable one this can run for several, so the line below is what proves it is
              still working.
            </p>
            {activity?.detail && (
              <p className="mono mt-1 text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
                {activity.detail}
              </p>
            )}
          </div>
        )}

        {error && (
          <div
            className="mt-3 rounded-md px-3 py-2 text-[12px]"
            style={{ background: 'var(--bad-soft)', color: 'var(--bad)' }}
          >
            {error}
          </div>
        )}

        {result && <ImportSummary result={result} />}
      </div>
    </section>
  )
}

function ImportSummary({ result }: { result: ResumeImportResult }) {
  return (
    <div className="mt-3 rounded-md px-3 py-2.5" style={{ background: 'var(--good-soft)' }}>
      <p className="text-[12.5px] font-medium" style={{ color: 'var(--good)' }}>
        Profile filled in from your resume — saved already.
      </p>

      {result.changes.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {result.changes.map((change) => (
            <Badge key={change} tone="good">
              {change}
            </Badge>
          ))}
        </div>
      )}

      {result.skipped.length > 0 && (
        <p className="mt-2 text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>
          Left alone because you had already filled them in: {result.skipped.join(', ')}. Choose{' '}
          <em>Replace what I have</em> and read it again if you want the resume to win.
        </p>
      )}

      {result.gaps.length > 0 && (
        <div className="mt-2">
          <p className="text-[11.5px] font-medium" style={{ color: 'var(--warn)' }}>
            A resume cannot tell it these — fill them in below or applications will stop for review:
          </p>
          <ul className="mt-1 list-inside list-disc text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>
            {result.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-2 text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>
        Read through what it extracted before you start the agent — it copies, but it can still misread a two-column
        layout.
      </p>
    </div>
  )
}
