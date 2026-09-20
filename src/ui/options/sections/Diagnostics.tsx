/**
 * What broke, and what the agent has learned.
 *
 * Two lists that used to exist only in the code's imagination. A failed
 * application recorded a sentence -- "no application form found on this page"
 * -- and the page that produced it was closed and forgotten, so diagnosing a
 * breakage meant opening the site by hand and guessing, which on a listing that
 * only appears once is not possible at all.
 *
 * Now each failure keeps the outline of the page, and each failure here can be
 * copied as plain text: the controls that were on screen, their labels and
 * their selectors. That is everything needed to write the selector that fixes
 * it, or to paste into a bug report and have someone else write it.
 */

import { useCallback, useEffect, useState } from 'react'
import { api, useAction, type Evidence, type SelfTestReport, type SiteMemoryRow } from '../../shared/api'
import { Badge, Empty, Section } from '../../shared/components'
import { formatEvidence } from '@/storage/evidence'
import { formatSelfTest } from '@/background/self-test'
import { formatRelative } from '@/shared/util'

export default function DiagnosticsSection() {
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const [sites, setSites] = useState<SiteMemoryRow[]>([])
  const [open, setOpen] = useState('')
  const [copied, setCopied] = useState('')
  const [report, setReport] = useState<SelfTestReport | null>(null)
  const [probePages, setProbePages] = useState(true)
  const { run, busy } = useAction()

  const refresh = useCallback(async () => {
    const [e, s] = await Promise.all([api.listEvidence(), api.listSiteMemory()])
    setEvidence(e.evidence)
    setSites(s.sites)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const copy = (e: Evidence) => copyText(formatEvidence(e), e.id)

  const copyText = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      setTimeout(() => setCopied(''), 2000)
    } catch {
      setCopied('')
    }
  }

  return (
    <div>
      <Section
        title="Check itself"
        description="Runs the whole pipeline against the real browser and, if you let it, against real job pages. Nothing is filled in and nothing is submitted. The result is one block of text you can hand to someone who can fix it."
      >
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="btn btn-primary"
            disabled={!!busy}
            onClick={() =>
              run(async () => {
                setReport(null)
                setReport(await api.selfTest({ probePages, probeCount: 3 }))
              }, 'testing')
            }
          >
            {busy === 'testing' ? 'Checking…' : 'Run the self-test'}
          </button>
          <label className="flex items-center gap-1.5 text-[12px]">
            <input type="checkbox" checked={probePages} onChange={(e) => setProbePages(e.target.checked)} />
            Also open up to 3 queued job pages and read them
          </label>
        </div>

        {busy === 'testing' && (
          <p className="mt-2 text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
            The model check alone can take up to a minute; reading pages adds roughly twenty seconds each.
          </p>
        )}

        {report && <SelfTestResult report={report} onCopy={copyText} copied={copied} />}
      </Section>

      <Section
        title="Recent failures"
        description="What the page actually looked like when an application did not go through. Copy one of these into a bug report and it contains everything needed to fix the selector."
      >
        <div className="mb-2 flex items-center gap-2">
          <button className="btn btn-sm" disabled={!!busy} onClick={() => void refresh()}>
            Refresh
          </button>
          {evidence.length > 0 && (
            <button
              className="btn btn-sm"
              disabled={!!busy}
              onClick={() =>
                run(async () => {
                  await api.clearEvidence()
                  await refresh()
                }, 'clearing')
              }
            >
              Clear
            </button>
          )}
        </div>

        {evidence.length === 0 ? (
          <Empty title="Nothing recorded" hint="Failures during an application will show up here with the page that caused them." />
        ) : (
          <div className="flex flex-col gap-2">
            {evidence.map((e) => (
              <div key={e.id} className="surface px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge tone={e.stage === 'detect' ? 'warn' : 'bad'}>{e.stage}</Badge>
                      <span className="truncate text-[12.5px] font-medium">{e.title || e.url}</span>
                    </div>
                    <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
                      {formatRelative(e.at)} — {e.reason}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button className="btn btn-sm" onClick={() => void copy(e)}>
                      {copied === e.id ? 'Copied' : 'Copy'}
                    </button>
                    <button className="btn btn-sm" onClick={() => setOpen(open === e.id ? '' : e.id)}>
                      {open === e.id ? 'Hide' : 'What was on the page'}
                    </button>
                  </div>
                </div>

                {open === e.id && (
                  <pre
                    className="mono mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md px-3 py-2 text-[11px]"
                    style={{ background: 'var(--bg-soft)' }}
                  >
                    {formatEvidence(e)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="What the agent has learned"
        description="Apply controls it worked out for itself on sites the built-in selectors did not cover. These are tried before anything else, so a site only costs the model once."
      >
        <div className="mb-2 flex items-center gap-2">
          {sites.length > 0 && (
            <button
              className="btn btn-sm"
              disabled={!!busy}
              onClick={() =>
                run(async () => {
                  await api.clearSiteMemory()
                  await refresh()
                }, 'clearing')
              }
            >
              Forget all
            </button>
          )}
        </div>

        {sites.length === 0 ? (
          <Empty
            title="Nothing learned yet"
            hint="When the built-in selectors miss and the model finds the apply button instead, the result is remembered here."
          />
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ color: 'var(--ink-faint)' }}>
                <th className="py-1 text-left font-medium">Site</th>
                <th className="py-1 text-left font-medium">Control</th>
                <th className="py-1 text-right font-medium">Worked</th>
                <th className="py-1 text-right font-medium">Missed</th>
                <th className="py-1 text-right font-medium">Last used</th>
              </tr>
            </thead>
            <tbody>
              {sites
                .filter((s) => s.applyEntry)
                .map((s) => (
                  <tr key={s.host} style={{ borderTop: '1px solid var(--line)' }}>
                    <td className="py-1.5">{s.host}</td>
                    <td className="mono py-1.5 text-[11px]" style={{ color: 'var(--ink-soft)' }}>
                      {s.applyEntry!.text ? `"${s.applyEntry!.text}" — ` : ''}
                      {s.applyEntry!.selector}
                    </td>
                    <td className="py-1.5 text-right">{s.applyEntry!.hits}</td>
                    <td className="py-1.5 text-right" style={{ color: s.applyEntry!.misses > 0 ? 'var(--warn)' : undefined }}>
                      {s.applyEntry!.misses}
                    </td>
                    <td className="py-1.5 text-right" style={{ color: 'var(--ink-faint)' }}>
                      {formatRelative(s.applyEntry!.lastUsedAt)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  )
}

/**
 * The result, shown twice: as a list a person reads, and as one block of text
 * they can copy. The list is for deciding whether to worry; the block is the
 * thing that actually gets a problem fixed by somebody else.
 */
function SelfTestResult({
  report,
  onCopy,
  copied,
}: {
  report: SelfTestReport
  onCopy: (text: string, id: string) => void
  copied: string
}) {
  const tone = (status: string) =>
    status === 'fail' ? 'bad' : status === 'warn' ? 'warn' : status === 'skip' ? undefined : 'good'

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] font-medium">
          {report.summary.fail > 0
            ? `${report.summary.fail} problem(s) found`
            : report.summary.warn > 0
              ? `Nothing broken, ${report.summary.warn} thing(s) worth a look`
              : 'Everything passed'}
          <span style={{ color: 'var(--ink-faint)' }}> — {(report.elapsedMs / 1000).toFixed(1)}s</span>
        </p>
        <button className="btn btn-sm" onClick={() => onCopy(formatSelfTest(report), 'report')}>
          {copied === 'report' ? 'Copied' : 'Copy the whole report'}
        </button>
      </div>

      <div className="mt-2 flex flex-col gap-1.5">
        {report.checks.map((c) => (
          <div key={c.id} className="flex items-start gap-2">
            <Badge tone={tone(c.status)}>{c.status}</Badge>
            <div className="min-w-0">
              <p className="text-[12.5px]">{c.name}</p>
              <p className="text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
                {c.detail}
              </p>
              {c.fix && (
                <p className="text-[11.5px]" style={{ color: 'var(--warn)' }}>
                  {c.fix}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {report.probes.length > 0 && (
        <table className="mt-3 w-full text-[11.5px]">
          <thead>
            <tr style={{ color: 'var(--ink-faint)' }}>
              <th className="py-1 text-left font-medium">Page</th>
              <th className="py-1 text-left font-medium">Got to</th>
              <th className="py-1 text-right font-medium">Fields</th>
              <th className="py-1 text-right font-medium">Answered</th>
            </tr>
          </thead>
          <tbody>
            {report.probes.map((p) => (
              <tr key={p.url} style={{ borderTop: '1px solid var(--line)' }}>
                <td className="max-w-0 truncate py-1.5" title={p.url}>
                  <span style={{ color: p.ok ? undefined : 'var(--bad)' }}>{p.url}</span>
                </td>
                <td className="py-1.5">{p.error ? `${p.reached} — ${p.error.slice(0, 60)}` : p.reached}</td>
                <td className="py-1.5 text-right">{p.fields}</td>
                <td className="py-1.5 text-right">{p.resolved}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
