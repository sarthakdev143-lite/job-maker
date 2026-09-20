/**
 * API-key drivers.
 *
 * The DeepSeek web driver is free but fragile. When it breaks -- or when the
 * user would rather pay a cent an application than babysit a browser tab --
 * these take over with no other change to the system.
 *
 * Anthropic's Messages API needs the browser-access header to be callable from
 * an extension; OpenAI-compatible covers DeepSeek's own paid API, Groq,
 * OpenRouter, Ollama, NVIDIA NIM and anything else that speaks
 * /chat/completions.
 */

import type { CompleteRequest, LlmDriver, LlmHealth } from '../driver'
import { LlmError } from '../driver'
import type { LlmConfig } from '@/storage/schemas'
import { fetchWithTimeout } from '@/shared/util'

const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5'
const ANTHROPIC_VERSION = '2023-06-01'

export class AnthropicDriver implements LlmDriver {
  readonly id = 'anthropic-api'
  readonly label = 'Claude API'

  constructor(private config: LlmConfig) {}

  updateConfig(config: LlmConfig): void {
    this.config = config
  }

  async health(): Promise<{ status: LlmHealth; detail: string }> {
    if (!this.config.apiKey.trim()) {
      return { status: 'needs_login', detail: 'No API key set' }
    }
    return { status: 'ok', detail: this.config.model || ANTHROPIC_DEFAULT_MODEL }
  }

  async complete(req: CompleteRequest): Promise<string> {
    const key = this.config.apiKey.trim()
    if (!key) throw new LlmError('No Anthropic API key configured', 'config')

    const body = {
      model: this.config.model || ANTHROPIC_DEFAULT_MODEL,
      max_tokens: 4096,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
    }

    const url = this.config.apiBaseUrl || 'https://api.anthropic.com/v1/messages'
    await ensureHostPermission(url)

    const timeoutMs = req.timeoutMs ?? this.config.requestTimeoutMs

    let res: Response
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
          // Required for direct browser calls; without it the request is CORS-blocked.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        timeoutMs,
        label: 'Anthropic request',
      })
    } catch (e) {
      throw new LlmError(friendlyFetchError(e as Error, url, timeoutMs), 'transport')
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const code = res.status === 401 || res.status === 403 ? 'config' : res.status === 429 ? 'busy' : 'transport'
      throw new LlmError(`Anthropic API ${res.status}: ${detail.slice(0, 300)}`, code)
    }

    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
    const text = (json.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
    if (!text) throw new LlmError('Anthropic returned no text content', 'transport')
    return text
  }
}

export class OpenAiCompatibleDriver implements LlmDriver {
  readonly id: string = 'openai-compatible'
  readonly label: string = 'OpenAI-compatible API'

  constructor(protected config: LlmConfig) {}

  updateConfig(config: LlmConfig): void {
    this.config = config
  }

  protected baseUrl(): string {
    const base = this.config.apiBaseUrl.trim() || 'https://api.deepseek.com'
    return base.replace(/\/+$/, '')
  }

  /** Model used when the user did not name one. */
  protected defaultModel(): string {
    return 'deepseek-chat'
  }

  /**
   * Full /chat/completions URL for any OpenAI-compatible base.
   *
   * Some providers (notably NVIDIA NIM) publish their base URL *with* the
   * version segment already on it (`.../v1`); appending another one produces
   * `/v1/v1/chat/completions` and every call 404s. Bases ending in `/v1` get
   * only `/chat/completions`.
   */
  protected chatCompletionsUrl(): string {
    const base = this.baseUrl()
    return /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`
  }

  protected modelsUrl(): string {
    const base = this.baseUrl()
    return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`
  }

  /**
   * The models this key can actually call.
   *
   * Typing a model name by hand is a trap: providers retire them on their own
   * schedule and the only symptom is a 410 at the moment you try to use it,
   * long after the name was entered and while every guide still recommends it.
   * NVIDIA retired meta/llama-3.1-70b-instruct in August 2026 exactly that way.
   * Asking the endpoint is the only answer that stays correct.
   */
  async listModels(): Promise<string[]> {
    const key = this.config.apiKey.trim()
    if (!key) throw new LlmError('No API key configured', 'config')

    const url = this.modelsUrl()
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    }).catch((e: Error) => {
      throw new LlmError(friendlyFetchError(e, url), 'transport')
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new LlmError(
        `Could not list models (HTTP ${res.status}): ${body.slice(0, 300)}`,
        res.status === 401 || res.status === 403 ? 'config' : 'transport'
      )
    }

    const payload = (await res.json()) as { data?: Array<{ id?: unknown }> }
    return (payload.data ?? [])
      .map((m) => String(m.id ?? ''))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
  }

  async health(): Promise<{ status: LlmHealth; detail: string }> {
    if (!this.config.apiKey.trim()) return { status: 'needs_login', detail: 'No API key set' }
    if (!this.config.model.trim()) return { status: 'needs_login', detail: 'No model name set' }
    return { status: 'ok', detail: `${this.baseUrl()} / ${this.config.model}` }
  }

  async complete(req: CompleteRequest): Promise<string> {
    const key = this.config.apiKey.trim()
    if (!key) throw new LlmError('No API key configured', 'config')

    const messages: Array<{ role: string; content: string }> = []
    if (req.system) messages.push({ role: 'system', content: req.system })
    messages.push({ role: 'user', content: req.prompt })

    const url = this.chatCompletionsUrl()
    await ensureHostPermission(url)

    // Resume parsing ships up to 24k chars; NIM's 405B cold-start can itself
    // take 20-40s. Capping this at 30s turned every large prompt into a
    // timeout. Respect the user's configured timeout (default 180s).
    const timeoutMs = req.timeoutMs ?? this.config.requestTimeoutMs

    const baseBody: Record<string, unknown> = {
      model: this.config.model || this.defaultModel(),
      messages,
      temperature: 0.3,
      max_tokens: 4096,
    }
    // Prefer JSON object mode for structured calls — fixes diffusion/instruct
    // models that return prose. If the provider does not support
    // response_format (some NIM models like gpt-oss return 400), we retry
    // once without it rather than failing the whole resume import.
    const withJsonMode = req.jsonMode ? { ...baseBody, response_format: { type: 'json_object' } } : baseBody
    const withoutJsonMode = baseBody

    let res: Response
    let usedJsonMode = Boolean(req.jsonMode)
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(withJsonMode),
        timeoutMs,
        label: 'Chat completion request',
      })
      if (!res.ok && req.jsonMode && res.status === 400) {
        const peek = await res.clone().text().catch(() => '')
        if (/response_format|json_object/i.test(peek)) {
          // Retry without the hint — the model can still produce JSON via prompt alone.
          res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify(withoutJsonMode),
            timeoutMs,
            label: 'Chat completion request (retry without json_object)',
          })
          usedJsonMode = false
        }
      }
    } catch (e) {
      throw new LlmError(friendlyFetchError(e as Error, url, timeoutMs), 'transport')
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const code =
        res.status === 401 || res.status === 403
          ? 'config'
          : res.status === 429
            ? 'busy'
            : // A retired model is a settings problem, not a transient one. Marking
              // it transport made the broker retry it three times and then fail
              // over, burning a minute per request on a name that will never work.
              res.status === 410
              ? 'config'
              : 'transport'

      // Naming a replacement model here is how this message goes stale: the one
      // it used to recommend, meta/llama-3.1-70b-instruct, was itself retired in
      // August 2026. Point at the live catalogue instead.
      const modelProblem = res.status === 410 || (res.status === 404 && /model/i.test(detail))
      const hint = modelProblem
        ? ` The model "${this.config.model}" is not available on this key — providers retire them on their own schedule. Press "List available models" in Settings → Model to see what this key can actually call, and pick one.`
        : ''

      throw new LlmError(`Chat API ${res.status}: ${detail.slice(0, 300)}${hint}`, code)
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = json.choices?.[0]?.message?.content ?? ''
    if (!text) throw new LlmError('Chat API returned no content', 'transport')
    return text
  }
}

/**
 * NVIDIA NIM, served over its OpenAI-compatible endpoint.
 *
 * Same transport as {@link OpenAiCompatibleDriver}; the differences are the
 * default base URL (NIM publishes it with `/v1` already attached) and no
 * assumed model -- NIM hosts dozens, so the user names one explicitly and
 * health refuses to pass until they do.
 */
export class NimDriver extends OpenAiCompatibleDriver {
  readonly id = 'nvidia-nim'
  readonly label = 'NVIDIA NIM'

  protected baseUrl(): string {
    const base = this.config.apiBaseUrl.trim() || NIM_DEFAULT_BASE_URL
    return base.replace(/\/+$/, '')
  }

  protected defaultModel(): string {
    return ''
  }

  async health(): Promise<{ status: LlmHealth; detail: string }> {
    if (!this.config.apiKey.trim()) return { status: 'needs_login', detail: 'No NIM API key set' }
    if (!this.config.model.trim()) {
      // Deliberately no example: the one that used to be here outlived its own
      // availability. "List available models" asks the key what it can call.
      return {
        status: 'needs_login',
        detail: 'No NIM model set - press "List available models" to see what this key can call',
      }
    }
    return { status: 'ok', detail: `NIM / ${this.config.model}` }
  }
}

/** Default NIM base; overridable in settings for self-hosted NIMs. */
export const NIM_DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1'

function friendlyFetchError(e: Error, url: string, timeoutMs?: number): string {
  const msg = e.message || String(e)
  if (/timed out after/i.test(msg) && timeoutMs) {
    const host = (() => {
      try {
        return new URL(url).hostname
      } catch {
        return url
      }
    })()
    return (
      `${msg} on ${host}. ` +
      `NIM's large models (405B) cold-start in 20-40s and resume parsing sends up to 24k chars — ` +
      `try a smaller model, or raise Settings → Model → Request timeout. ` +
      `Fallback was not ready, so sign in to chat.deepseek.com or fix the NIM key for automatic failover.`
    )
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    const host = (() => {
      try {
        return new URL(url).hostname
      } catch {
        return url
      }
    })()
    return (
      `Failed to fetch ${host}: ${msg}. ` +
      `If you just updated the extension, reload it at chrome://extensions and try again ` +
      `(new host permissions only apply after reload). ` +
      `Also check the Base URL, that the key is for ${host}, and that you have network access.`
    )
  }
  return msg
}

async function ensureHostPermission(url: string): Promise<void> {
  try {
    const perms = (globalThis as unknown as { chrome?: typeof chrome }).chrome?.permissions
    if (!perms?.contains || !perms?.request) return
    const origin = new URL(url).origin + '/*'
    const has = await perms.contains({ origins: [origin] })
    if (!has) {
      await perms.request({ origins: [origin] }).catch(() => {})
    }
  } catch {
    // Best effort: fetch will surface a clearer error if permission is missing.
  }
}
