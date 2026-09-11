/**
 * API-key drivers.
 *
 * The DeepSeek web driver is free but fragile. When it breaks -- or when the
 * user would rather pay a cent an application than babysit a browser tab --
 * these take over with no other change to the system.
 *
 * Anthropic's Messages API needs the browser-access header to be callable from
 * an extension; OpenAI-compatible covers DeepSeek's own paid API, Groq,
 * OpenRouter, Ollama and anything else that speaks /chat/completions.
 */

import type { CompleteRequest, LlmDriver, LlmHealth } from '../driver'
import { LlmError } from '../driver'
import type { LlmConfig } from '@/storage/schemas'
import { withTimeout } from '@/shared/util'

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

    const res = await withTimeout(
      fetch(this.config.apiBaseUrl || 'https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
          // Required for direct browser calls; without it the request is CORS-blocked.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      }),
      req.timeoutMs ?? this.config.requestTimeoutMs,
      'Anthropic request'
    )

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
  readonly id = 'openai-compatible'
  readonly label = 'OpenAI-compatible API'

  constructor(private config: LlmConfig) {}

  updateConfig(config: LlmConfig): void {
    this.config = config
  }

  private baseUrl(): string {
    const base = this.config.apiBaseUrl.trim() || 'https://api.deepseek.com'
    return base.replace(/\/+$/, '')
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

    const res = await withTimeout(
      fetch(`${this.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: this.config.model || 'deepseek-chat',
          messages,
          temperature: 0.3,
          max_tokens: 4096,
        }),
      }),
      req.timeoutMs ?? this.config.requestTimeoutMs,
      'Chat completion request'
    )

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const code = res.status === 401 || res.status === 403 ? 'config' : res.status === 429 ? 'busy' : 'transport'
      throw new LlmError(`Chat API ${res.status}: ${detail.slice(0, 300)}`, code)
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = json.choices?.[0]?.message?.content ?? ''
    if (!text) throw new LlmError('Chat API returned no content', 'transport')
    return text
  }
}
