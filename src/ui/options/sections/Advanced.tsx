/**
 * Advanced: custom domains, per-domain field overrides, the dry-run bench,
 * and backup.
 *
 * The dry-run bench is the tool to reach for when a site fills badly: it opens
 * a single URL, fills it, leaves the window open and highlights whatever it
 * could not answer. It is how a new site gets diagnosed without sending
 * anything to anyone.
 */

import { useState } from 'react'
import { api, useAction } from '../../shared/api'
import { Field, ListInput, Section, TextArea, TextInput } from '../../shared/components'
import type { Settings } from '@/storage/schemas'

export default function AdvancedSection({
  settings,
  patch,
}: {
  settings: Settings
  patch: (p: Partial<Settings>) => void
}) {
  const { run, busy, error } = useAction()
  const [dryUrl, setDryUrl] = useState('')
  const [dryResult, setDryResult] = useState('')
  const [overrideJson, setOverrideJson] = useState(JSON.stringify(settings.selectorOverrides, null, 2))
  const [overrideStatus, setOverrideStatus] = useState('')
  const [importPayload, setImportPayload] = useState('')
  const [importStatus, setImportStatus] = useState('')

  return (
    <div>
      <Section
        title="Try a single form"
        description="Opens the URL, fills what it can, leaves the window open and outlines anything it could not answer. Never submits."
      >
        <div className="flex gap-2">
          <TextInput value={dryUrl} onChange={setDryUrl} placeholder="https://boards.greenhouse.io/company/jobs/123" />
          <button
            className="btn btn-primary shrink-0"
            disabled={!!busy || !dryUrl.trim()}
            onClick={() =>
              run(async () => {
                const result = await api.dryRunUrl(dryUrl.trim())
                setDryResult(
                  `Found ${result.fields} field(s). Filled ${result.plan.length}. Could not answer ${result.unresolved.length}.\n\n` +
                    result.plan.map((f) => `${f.label || f.selector}\n  = ${f.value}  [${f.source}, ${Math.round(f.confidence * 100)}%]`).join('\n')
                )
              }, 'filling')
            }
          >
            {busy === 'filling' ? 'Filling…' : 'Fill it'}
          </button>
        </div>
        {error && (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--bad)' }}>
            {error}
          </p>
        )}
        {dryResult && (
          <pre
            className="mono mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md px-3 py-2"
            style={{ background: 'var(--bg-soft)' }}
          >
            {dryResult}
          </pre>
        )}
      </Section>

      <Section
        title="Extra domains"
        description="Companies that host their own form. The agent's page script is registered on these at runtime."
      >
        <Field label="Domains" hint="One per line, e.g. careers.example.com. Chrome may ask you to grant access.">
          <ListInput
            value={settings.customApplyDomains}
            onChange={(v) => patch({ customApplyDomains: v })}
            rows={4}
            placeholder={'careers.example.com\njobs.another.io'}
          />
        </Field>
      </Section>

      <Section
        title="Field overrides"
        description="Force a specific input on a specific domain to be treated as a known field. Use when a site labels something confusingly."
      >
        <TextArea value={overrideJson} onChange={setOverrideJson} rows={10} />
        <p className="hint">
          Shape: <code className="mono">{'{ "domain.com": { "firstName": "#fname", "email": "input[name=mail]" } }'}</code>
          — the key is a canonical field name, the value is a CSS selector on that page.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <button
            className="btn btn-sm"
            onClick={() => {
              try {
                patch({ selectorOverrides: JSON.parse(overrideJson) })
                setOverrideStatus('Applied. Save changes to persist.')
              } catch (e) {
                setOverrideStatus(`Not valid JSON: ${(e as Error).message}`)
              }
            }}
          >
            Apply overrides
          </button>
          {overrideStatus && (
            <span className="text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
              {overrideStatus}
            </span>
          )}
        </div>
      </Section>

      <Section title="Backup" description="Settings, profile and searches. The job history and answer bank stay local.">
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-sm"
            disabled={!!busy}
            onClick={() =>
              run(async () => {
                const { payload } = await api.exportData()
                const url = `data:application/json;base64,${btoa(unescape(encodeURIComponent(payload)))}`
                await chrome.downloads.download({
                  url,
                  filename: `autoapply-backup-${new Date().toISOString().slice(0, 10)}.json`,
                  saveAs: true,
                })
              }, 'exporting')
            }
          >
            Export to a file
          </button>
        </div>

        <div className="mt-3">
          <Field label="Restore from a backup" hint="Paste the contents of an exported file.">
            <TextArea value={importPayload} onChange={setImportPayload} rows={6} />
          </Field>
          <button
            className="btn btn-sm mt-2"
            disabled={!!busy || !importPayload.trim()}
            onClick={() =>
              run(async () => {
                const result = (await api.importData(importPayload)) as Record<string, boolean>
                setImportStatus(
                  `Restored: ${Object.entries(result)
                    .filter(([, ok]) => ok)
                    .map(([k]) => k)
                    .join(', ') || 'nothing'}. Reload this page to see it.`
                )
                setImportPayload('')
              }, 'importing')
            }
          >
            Restore
          </button>
          {importStatus && (
            <p className="hint">{importStatus}</p>
          )}
        </div>
      </Section>

      <Section title="Where your data lives">
        <p className="surface-quiet px-3 py-2.5 text-[12px]" style={{ color: 'var(--ink-soft)' }}>
          Everything stays on this machine: your profile and settings in Chrome's extension storage, and jobs,
          applications, generated documents and the audit log in the extension's IndexedDB. None of it is encrypted at
          rest, and anything you type into the profile — including voluntary disclosures — is readable by anyone with
          access to your Chrome profile. The only data that leaves your machine is what the agent sends to your chosen
          model and what it types into the application forms themselves.
        </p>
      </Section>
    </div>
  )
}
