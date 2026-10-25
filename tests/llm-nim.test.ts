/**
 * NVIDIA NIM as first priority, the free DeepAI web driver as second.
 *
 * NIM speaks OpenAI-compatible /chat/completions, but publishes its base URL
 * with `/v1` already attached -- appending another one 404s every call. And
 * the broker must fail over to the web driver on transient API failures while
 * failing fast on a bad key, or the priority order is decoration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NimDriver, OpenAiCompatibleDriver } from '@/llm/drivers/api'
import { LlmError } from '@/llm/driver'
import { LlmConfigSchema, type LlmConfig } from '@/storage/schemas'

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return LlmConfigSchema.parse({
    driver: 'nvidia-nim',
    apiKey: 'nvapi-test-key',
    model: 'meta/llama-3.1-405b-instruct',
    requestTimeoutMs: 5000,
    maxRetries: 0,
    ...overrides,
  })
}

type FetchMock = ReturnType<typeof vi.fn>

function okReply(text: string) {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ choices: [{ message: { content: text } }] }),
  }
}

function errReply(status: number, body = 'nope') {
  return {
    ok: false,
    status,
    text: async () => body,
    json: async () => ({}),
  }
}

let fetchMock: FetchMock

beforeEach(() => {
  fetchMock = vi.fn(async () => okReply('{"ok": true}'))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('NIM endpoint', () => {
  it('calls /chat/completions exactly once under the default base', async () => {
    await new NimDriver(config()).complete({ prompt: 'hi' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('https://integrate.api.nvidia.com/v1/chat/completions')
  })

  it('does not double the /v1 when the base already carries it', async () => {
    const driver = new OpenAiCompatibleDriver(config({ apiBaseUrl: 'https://integrate.api.nvidia.com/v1/' }))
    await driver.complete({ prompt: 'hi' })
    expect(fetchMock.mock.calls[0]![0]).toBe('https://integrate.api.nvidia.com/v1/chat/completions')
  })

  it('still appends /v1 for bases without it', async () => {
    const driver = new OpenAiCompatibleDriver(config({ apiBaseUrl: 'https://api.deepseek.com' }))
    await driver.complete({ prompt: 'hi' })
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.deepseek.com/v1/chat/completions')
  })

  it('sends the key as a Bearer token and the configured model', async () => {
    await new NimDriver(config()).complete({ prompt: 'hi', system: 'sys' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer nvapi-test-key')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('meta/llama-3.1-405b-instruct')
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('maps 401 to a permanent config error and 429 to retryable busy', async () => {
    fetchMock.mockResolvedValueOnce(errReply(401, 'invalid key'))
    await expect(new NimDriver(config()).complete({ prompt: 'hi' })).rejects.toMatchObject({
      name: 'LlmError',
      code: 'config',
    })
    fetchMock.mockResolvedValueOnce(errReply(429, 'slow down'))
    await expect(new NimDriver(config()).complete({ prompt: 'hi' })).rejects.toMatchObject({ code: 'busy' })
  })
})

describe('NIM health', () => {
  it('refuses until a key and a model are both set', async () => {
    expect((await new NimDriver(config({ apiKey: '' })).health()).status).toBe('needs_login')
    expect((await new NimDriver(config({ model: '' })).health()).status).toBe('needs_login')
    expect((await new NimDriver(config()).health()).status).toBe('ok')
  })
})

describe('broker failover order', () => {
  function installFakeChrome(llm: Partial<LlmConfig>): void {
    ;(globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string) =>
            key === 'settings' ? { settings: { llm } } : {},
          set: async () => undefined,
        },
        session: { get: async () => ({}), set: async () => undefined },
      },
      // No tabs API: the web fallback cannot open anything here, which is the
      // point -- the combined error must still name both drivers.
    }
  }

  it('fails over to the web driver when the API fails transiently', async () => {
    installFakeChrome({
      driver: 'nvidia-nim',
      apiKey: 'nvapi-test-key',
      model: 'meta/llama-3.1-405b-instruct',
      requestTimeoutMs: 1000,
      maxRetries: 0,
    })
    fetchMock.mockRejectedValueOnce(new Error('socket hangup'))

    const { llm } = await import('@/llm/broker')
    await llm.invalidate()
    const err = await llm.completeText({ prompt: 'hi' }, 'failover-test').then(
      () => null,
      (e: Error) => e
    )
    expect(err).toBeInstanceOf(LlmError)
    expect((err as Error).message).toMatch(/NVIDIA NIM/)
    expect((err as Error).message).toMatch(/DeepAI \(web\)/)
  })

  it('fails fast on a bad key without touching the fallback', async () => {
    installFakeChrome({
      driver: 'nvidia-nim',
      apiKey: 'bad-key',
      model: 'meta/llama-3.1-405b-instruct',
      requestTimeoutMs: 1000,
      maxRetries: 0,
    })
    fetchMock.mockResolvedValueOnce(errReply(401, 'invalid api key'))

    const { llm } = await import('@/llm/broker')
    await llm.invalidate()
    const err = await llm.completeText({ prompt: 'hi' }, 'bad-key-test').then(
      () => null,
      (e: Error) => e
    )
    expect(err).toBeInstanceOf(LlmError)
    expect((err as unknown as LlmError).code).toBe('config')
    expect((err as Error).message).not.toMatch(/DeepAI \(web\)/)
  })
})
