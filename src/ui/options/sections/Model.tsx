/**
 * Model settings.
 *
 * Also the repair bench for the chat bridge: when a site's UI changes, the
 * selector overrides here let the user fix it without rebuilding the extension,
 * which matters because that break is a question of when rather than if.
 *
 * The default selector JSON is generated from the site's own profile rather than
 * pasted in beside it. A hand-maintained copy is a second list that drifts, and
 * when it drifts the repair bench shows the user selectors the bridge does not
 * use -- which is worse than no repair bench at all.
 */

import { useState } from 'react'
import { api, useAction, useAsync, useWorkerEvents } from '../../shared/api'
import { Badge, Field, NumberInput, Section, Select, TextArea, TextInput, Toggle } from '../../shared/components'
import { assessModel } from '@/llm/model-advice'
import { isWebDriver, siteById, DEEPAI, type ChatSite } from '@/llm/chat-sites'
import type { LlmConfig, Settings } from '@/storage/schemas'

type DriverOption = { value: LlmConfig['driver']; label: string }

/**
 * Typed explicitly rather than inferred.
 *
 * `<Select>` takes its value type from the options it is handed, and spreading
 * two plain arrays widens the literals to `string` -- at which point every
 * driver id in the app silently stops type-checking against the schema.
 */
const WEB_DRIVER_OPTIONS: DriverOption[] = [
  { value: 'deepai-web', label: 'DeepAI web chat (free, no API key)' },
  { value: 'deepseek-web', label: 'DeepSeek web chat (free, no API key)' },
]

const API_DRIVER_OPTIONS: DriverOption[] = [
  { value: 'nvidia-nim', label: 'NVIDIA NIM (API key, recommended)' },
  { value: 'anthropic-api', label: 'Claude API (API key)' },
  { value: 'openai-compatible', label: 'OpenAI-compatible API (DeepSeek paid, Groq, Ollama…)' },
]

/** The site whose selectors the repair bench is currently editing. */
function siteFor(driver: string): ChatSite {
  return siteById(driver) ?? DEEPAI
}

function defaultSelectorJson(site: ChatSite): string {
  return JSON.stringify(site.selectors, null, 2)
}


export default function ModelSection({
  settings,
  patch,
}: {
  settings: Settings
  patch: (p: Partial<Settings>) => void
}) {
  const llm = settings.llm
  const set = (p: Partial<LlmConfig>) => patch({ llm: { ...llm, ...p } })

  const { data: health, reload: reloadHealth } = useAsync(() => api.llmHealth(), [llm.driver])
  const { run, busy, error } = useAction()
  const [testReply, setTestReply] = useState('')
  const [jsonVerdict, setJsonVerdict] = useState<{ ok: boolean; detail: string } | null>(null)
  const [models, setModels] = useState<string[] | null>(null)
  const [cancelNote, setCancelNote] = useState('')
  // Proof of life while a request runs; without it a slow call looks like a hang.
  const { activity } = useWorkerEvents(['evt:activity'])
  const [selectorJson, setSelectorJson] = useState('')
  const [selectorStatus, setSelectorStatus] = useState('')

  // Judged as the user types, so the mistake is caught where it is made rather
  // than three screens later as an empty profile.
  const modelVerdict = assessModel(llm.driver, llm.model)

  // The repair bench follows whichever web driver is selected: each site has its
  // own selectors and its own storage key, so editing the wrong one fixed
  // nothing and looked like it had.
  const site = siteFor(llm.driver)
  const isWeb = isWebDriver(llm.driver)
  const siteName = site.label.replace(' (web)', '')

  const loadSelectors = async () => {
    const bag = await chrome.storage.local.get(site.storageKey)
    const stored = bag[site.storageKey]
    setSelectorJson(JSON.stringify(stored ?? JSON.parse(defaultSelectorJson(site)), null, 2))
  }

  const saveSelectors = async () => {
    try {
      const parsed = JSON.parse(selectorJson)
      await chrome.storage.local.set({ [site.storageKey]: parsed })
      setSelectorStatus(`Saved. Reload the ${siteName} tab for it to take effect.`)
    } catch (e) {
      setSelectorStatus(`Not valid JSON: ${(e as Error).message}`)
    }
  }

  return (
    <div>
      <Section
        title="Engine"
        description="Where the agent's reasoning comes from: scoring postings, answering unusual questions, and tailoring documents."
        actions={
          <Badge tone={health?.status === 'ok' ? 'good' : health?.status === 'needs_login' ? 'warn' : 'bad'}>
            {health?.status ?? 'checking'}
          </Badge>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Driver" wide>
            <Select
              value={llm.driver}
              onChange={(v) => set({ driver: v })}
              options={[...WEB_DRIVER_OPTIONS, ...API_DRIVER_OPTIONS]}
            />
          </Field>
        </div>

        {isWeb && (
          <div className="surface-quiet mt-3 px-3 py-2.5">
            <p className="text-[12px]">
              The agent drives a <span className="mono">{new URL(site.chatUrl).hostname}</span> tab in a minimised
              window. It costs nothing and needs no key
              {site.authRequired ? '' : ', and works signed out'}, but it handles one prompt at a time and depends on
              that page's structure — expect to repair the selectors below occasionally, and switch to an API key if
              you would rather not.
            </p>
            <p className="mt-2 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
              Automating a consumer chat UI is not something these sites support, so a heavy run can get an account
              rate-limited or suspended — and free tiers run out of credits. Prompts are paced apart to keep the load
              light. If you want real volume, use an API driver above; that is the supported path, it is cheap, and it
              runs faster than this one.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button className="btn btn-sm" disabled={!!busy} onClick={() => run(async () => { await api.openLlmLogin() }, 'opening')}>
                Open {siteName} tab
              </button>
              <button className="btn btn-sm" disabled={!!busy} onClick={() => run(async () => { await reloadHealth() }, 'checking')}>
                Re-check
              </button>
            </div>
            {health?.detail && (
              <p className="mono mt-2" style={{ color: 'var(--ink-faint)' }}>
                {health.detail}
              </p>
            )}
          </div>
        )}

        {!isWeb && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="API key" wide hint="Stored unencrypted in local extension storage on this machine.">
              <TextInput type="password" value={llm.apiKey} onChange={(v) => set({ apiKey: v })} />
            </Field>
            <Field label="Model">
              <TextInput
                value={llm.model}
                onChange={(v) => set({ model: v })}
                placeholder={
                  llm.driver === 'anthropic-api'
                    ? 'claude-sonnet-5'
                    : llm.driver === 'nvidia-nim'
                      ? 'use "List available models" below'
                      : 'deepseek-chat'
                }
              />
              <div className="mt-1 flex items-center gap-2">
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={!!busy || !llm.apiKey.trim()}
                  title={llm.apiKey.trim() ? '' : 'Add an API key first'}
                  onClick={() =>
                    run(async () => {
                      const res = await api.listModels()
                      setModels(res.models ?? [])
                    }, 'models')
                  }
                >
                  {busy === 'models' ? 'Asking the provider…' : 'List available models'}
                </button>
                {models && (
                  <span className="text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                    {models.length} available
                  </span>
                )}
              </div>
              {models && models.length > 0 && (
                <select
                  className="mt-1 h-9 w-full rounded-md border px-2 text-[13px]"
                  style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}
                  value={models.includes(llm.model) ? llm.model : ''}
                  onChange={(e) => e.target.value && set({ model: e.target.value })}
                >
                  <option value="">
                    {models.includes(llm.model) ? 'Pick a model…' : `${llm.model || 'none'} — not in this list`}
                  </option>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {assessModel(llm.driver, m)?.level === 'ok' ? m : `${m}  — may not return JSON`}
                    </option>
                  ))}
                </select>
              )}
              {models && models.length === 0 && (
                <p className="mt-1 text-[12px]" style={{ color: 'var(--bad)' }}>
                  The provider returned no models for this key.
                </p>
              )}
              {modelVerdict && modelVerdict.level !== 'ok' && (
                <p
                  className="mt-1 text-[12px]"
                  style={{ color: modelVerdict.level === 'bad' ? 'var(--bad)' : 'var(--warn, var(--ink-faint))' }}
                  role={modelVerdict.level === 'bad' ? 'alert' : undefined}
                >
                  {modelVerdict.message}
                </p>
              )}
            </Field>
            <Field
              label="Base URL"
              hint={
                llm.driver === 'nvidia-nim'
                  ? 'Leave blank for integrate.api.nvidia.com. Only change this for a self-hosted NIM.'
                  : 'Leave blank for the provider default.'
              }
            >
              <TextInput value={llm.apiBaseUrl} onChange={(v) => set({ apiBaseUrl: v })} />
            </Field>
          </div>
        )}

        {llm.driver === 'nvidia-nim' && (
          <div className="surface-quiet mt-3 px-3 py-2.5">
            <p className="text-[12px]">
              Uses your NVIDIA NIM key over its OpenAI-compatible endpoint. Any instruct model works; larger ones
              follow the answer format more reliably. If NIM is unreachable mid-run, the agent fails over to the
              DeepAI web tab for that request rather than parking the application — keep that tab signed in as a
              safety net. A wrong key fails fast with a clear error instead of silently falling back.
            </p>
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="Request timeout (ms)">
            <NumberInput value={llm.requestTimeoutMs} onChange={(v) => set({ requestTimeoutMs: v })} min={30000} step={10000} />
          </Field>
          <Field label="Transport retries">
            <NumberInput value={llm.maxRetries} onChange={(v) => set({ maxRetries: v })} min={0} max={5} />
          </Field>
          <Field
            label="Start a new chat every N requests"
            hint="Only for the web driver. Keeps the conversation short so replies stay fast and on-format."
          >
            <NumberInput value={llm.newChatEveryNRequests} onChange={(v) => set({ newChatEveryNRequests: v })} min={0} max={50} />
          </Field>
          <Field
            label="Minimum gap between prompts (ms)"
            hint="Only for the web driver. Keeps the load on the chat UI modest so the account stays in good standing."
          >
            <NumberInput value={llm.minRequestGapMs} onChange={(v) => set({ minRequestGapMs: v })} min={0} max={60000} step={1000} />
          </Field>
        </div>

        {isWeb && (
          <Toggle
            checked={llm.keepWindowMinimized}
            onChange={(v) => set({ keepWindowMinimized: v })}
            label="Keep the worker window minimised"
            description="Turn off to watch the conversation happen, which is the fastest way to diagnose a broken bridge."
          />
        )}
      </Section>

      <Section
        title="Connection test"
        description="Sends one real prompt and checks the reply is parseable JSON — which is what every part of the agent depends on, not merely that the model replied."
      >
        <button
          className="btn btn-primary btn-sm"
          disabled={!!busy}
          onClick={() =>
            run(async () => {
              setCancelNote('')
              const res = await api.testLlm()
              setTestReply(res.reply)
              setJsonVerdict({
                ok: res.jsonOk,
                detail:
                  `${res.jsonDetail} (answered in ${(res.elapsedMs / 1000).toFixed(1)}s` +
                  `${res.queuedBehind > 0 ? `, after waiting behind ${res.queuedBehind} earlier request(s)` : ''})`,
              })
            }, 'testing')
          }
        >
          {busy === 'testing' ? 'Asking… (up to 45s)' : 'Run test'}
        </button>
        <button
          className="btn btn-ghost btn-sm ml-2"
          onClick={() =>
            run(async () => {
              const res = await api.cancelModelQueue()
              setCancelNote(
                res.dropped > 0
                  ? `Dropped ${res.dropped} queued request(s).`
                  : 'Nothing was queued; the driver was reset.'
              )
            }, 'cancelling')
          }
        >
          {busy === 'cancelling' ? 'Cancelling…' : 'Cancel queued requests'}
        </button>
        {busy && activity?.detail && (
          <p className="mono mt-2 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
            {activity.detail}
          </p>
        )}
        {cancelNote && (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
            {cancelNote}
          </p>
        )}
        {error && (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--bad)' }}>
            {error}
          </p>
        )}
        {jsonVerdict && (
          <p
            className="mt-2 text-[12px]"
            style={{ color: jsonVerdict.ok ? 'var(--good, var(--ink))' : 'var(--bad)' }}
            role={jsonVerdict.ok ? undefined : 'alert'}
          >
            {jsonVerdict.ok ? '✓ ' : '✗ '}
            {jsonVerdict.detail}
          </p>
        )}
        {testReply && (
          <pre
            className="mono mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md px-3 py-2"
            style={{ background: 'var(--bg-soft)' }}
          >
            {testReply}
          </pre>
        )}
      </Section>

      {isWeb && (
        <Section
          title="Bridge selectors"
          description={`The only place in the extension that knows the ${siteName} page structure. If the bridge stops working, fix it here.`}
          actions={
            <button className="btn btn-sm" onClick={() => void loadSelectors()}>
              Load current
            </button>
          }
        >
          <TextArea value={selectorJson} onChange={setSelectorJson} rows={12} />
          <div className="mt-2 flex items-center gap-2">
            <button className="btn btn-sm" onClick={() => void saveSelectors()} disabled={!selectorJson.trim()}>
              Save selectors
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelectorJson(defaultSelectorJson(site))}>
              Reset to defaults
            </button>
            {selectorStatus && (
              <span className="text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
                {selectorStatus}
              </span>
            )}
          </div>
          <p className="hint">
            Each key takes a list of CSS selectors, tried in order. The first one that matches a visible element wins. `streaming` is what marks a reply as still being written, and `failedTurn` catches a turn the site itself rejected.
          </p>
        </Section>
      )}
    </div>
  )
}
