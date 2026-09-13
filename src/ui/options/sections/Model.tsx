/**
 * Model settings.
 *
 * Also the repair bench for the DeepSeek bridge: when their UI changes, the
 * selector overrides here let the user fix it without rebuilding the
 * extension, which matters because that break is a question of when rather
 * than if.
 */

import { useState } from 'react'
import { api, useAction, useAsync } from '../../shared/api'
import { Badge, Field, NumberInput, Section, Select, TextArea, TextInput, Toggle } from '../../shared/components'
import type { LlmConfig, Settings } from '@/storage/schemas'

const DEFAULT_SELECTOR_JSON = `{
  "composer": ["textarea#chat-input", "textarea[placeholder]"],
  "sendButton": ["div[role=\\"button\\"][aria-disabled=\\"false\\"]"],
  "stopButton": ["div[class*=\\"stop\\"]"],
  "assistantMessage": [".ds-markdown", "[class*=\\"markdown\\"]"],
  "newChatButton": ["div[class*=\\"new-chat\\"]", "a[href=\\"/\\"]"],
  "loginIndicator": ["input[type=\\"password\\"]"]
}`

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
  const [selectorJson, setSelectorJson] = useState('')
  const [selectorStatus, setSelectorStatus] = useState('')

  const loadSelectors = async () => {
    const bag = await chrome.storage.local.get('deepseekSelectors')
    setSelectorJson(JSON.stringify(bag.deepseekSelectors ?? JSON.parse(DEFAULT_SELECTOR_JSON), null, 2))
  }

  const saveSelectors = async () => {
    try {
      const parsed = JSON.parse(selectorJson)
      await chrome.storage.local.set({ deepseekSelectors: parsed })
      setSelectorStatus('Saved. Reload the DeepSeek tab for it to take effect.')
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
              options={[
                { value: 'deepseek-web', label: 'DeepSeek web chat (free, no API key)' },
                { value: 'anthropic-api', label: 'Claude API (API key)' },
                { value: 'openai-compatible', label: 'OpenAI-compatible API (DeepSeek paid, Groq, Ollama…)' },
              ]}
            />
          </Field>
        </div>

        {llm.driver === 'deepseek-web' && (
          <div className="surface-quiet mt-3 px-3 py-2.5">
            <p className="text-[12px]">
              The agent drives a logged-in chat.deepseek.com tab in a minimised window. It costs nothing and needs no
              key, but it handles one prompt at a time and depends on DeepSeek's page structure — expect to repair the
              selectors below occasionally, and switch to an API key if you would rather not.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button className="btn btn-sm" disabled={!!busy} onClick={() => run(async () => { await api.openLlmLogin() }, 'opening')}>
                Open DeepSeek tab
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

        {llm.driver !== 'deepseek-web' && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="API key" wide hint="Stored unencrypted in local extension storage on this machine.">
              <TextInput type="password" value={llm.apiKey} onChange={(v) => set({ apiKey: v })} />
            </Field>
            <Field label="Model">
              <TextInput
                value={llm.model}
                onChange={(v) => set({ model: v })}
                placeholder={llm.driver === 'anthropic-api' ? 'claude-sonnet-5' : 'deepseek-chat'}
              />
            </Field>
            <Field label="Base URL" hint="Leave blank for the provider default.">
              <TextInput value={llm.apiBaseUrl} onChange={(v) => set({ apiBaseUrl: v })} />
            </Field>
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
        </div>

        {llm.driver === 'deepseek-web' && (
          <Toggle
            checked={llm.keepWindowMinimized}
            onChange={(v) => set({ keepWindowMinimized: v })}
            label="Keep the worker window minimised"
            description="Turn off to watch the conversation happen, which is the fastest way to diagnose a broken bridge."
          />
        )}
      </Section>

      <Section title="Connection test" description="Sends one real prompt and shows the raw reply.">
        <button
          className="btn btn-primary btn-sm"
          disabled={!!busy}
          onClick={() =>
            run(async () => {
              const res = await api.testLlm()
              setTestReply(res.reply)
            }, 'testing')
          }
        >
          {busy === 'testing' ? 'Asking…' : 'Run test'}
        </button>
        {error && (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--bad)' }}>
            {error}
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

      {llm.driver === 'deepseek-web' && (
        <Section
          title="Bridge selectors"
          description="The only place in the extension that knows DeepSeek's DOM. If the bridge stops working, fix it here."
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
            <button className="btn btn-ghost btn-sm" onClick={() => setSelectorJson(DEFAULT_SELECTOR_JSON)}>
              Reset to defaults
            </button>
            {selectorStatus && (
              <span className="text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
                {selectorStatus}
              </span>
            )}
          </div>
          <p className="hint">
            Each key takes a list of CSS selectors, tried in order. The first one that matches a visible element wins.
          </p>
        </Section>
      )}
    </div>
  )
}
