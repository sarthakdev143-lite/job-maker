/**
 * The LLM broker.
 *
 * One queue, one request in flight, whichever driver is configured. Callers ask
 * for a validated object and get one or an exception -- they never see raw
 * model text, never handle retries, and never have to know that the default
 * driver is a browser tab that can only do one thing at a time.
 */

import { DeepSeekWebDriver } from './drivers/deepseek-web'
import { AnthropicDriver, OpenAiCompatibleDriver } from './drivers/api'
import { LlmError, isRetryable, type CompleteRequest, type LlmDriver, type LlmHealth } from './driver'
import { JSON_CONTRACT } from '@/storage/defaults'
import { StructuredParseError, parseStructured, retryInstruction } from './structured'
import { getSettings } from '@/storage/settings'
import { createLogger } from '@/shared/logger'
import { errorMessage, sleep } from '@/shared/util'
import type { LlmConfig } from '@/storage/schemas'
import type { TypeOf, ZodTypeAny } from 'zod'

const log = createLogger('llm')

type QueueTask<T> = {
  run: () => Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
  label: string
}

class LlmBroker {
  private driver: LlmDriver | null = null
  private driverId = ''
  private queue: Array<QueueTask<unknown>> = []
  private draining = false
  private lastHealth: { status: LlmHealth; detail: string; at: number } | null = null

  /* ---------------------------------------------------------------- driver */

  private buildDriver(config: LlmConfig): LlmDriver {
    switch (config.driver) {
      case 'anthropic-api':
        return new AnthropicDriver(config)
      case 'openai-compatible':
        return new OpenAiCompatibleDriver(config)
      case 'deepseek-web':
      default:
        return new DeepSeekWebDriver(config)
    }
  }

  private async getDriver(): Promise<LlmDriver> {
    const { llm } = await getSettings()
    if (!this.driver || this.driverId !== llm.driver) {
      await this.driver?.dispose?.()
      this.driver = this.buildDriver(llm)
      this.driverId = llm.driver
      log.info(`LLM driver set to ${this.driver.label}`)
    } else {
      // Pick up edited timeouts and keys without rebuilding the driver.
      ;(this.driver as { updateConfig?: (c: LlmConfig) => void }).updateConfig?.(llm)
    }
    return this.driver
  }

  /** Force a rebuild after a settings change. */
  async invalidate(): Promise<void> {
    await this.driver?.dispose?.()
    this.driver = null
    this.driverId = ''
    this.lastHealth = null
  }

  /* ----------------------------------------------------------------- queue */

  private enqueue<T>(label: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ label, run, resolve, reject } as QueueTask<unknown>)
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()
        if (!task) break
        try {
          const value = await task.run()
          task.resolve(value)
        } catch (e) {
          task.reject(e)
        }
        // A breath between prompts keeps the chat UI from dropping the next one.
        await sleep(400)
      }
    } finally {
      this.draining = false
    }
  }

  get queueDepth(): number {
    return this.queue.length
  }

  /* ---------------------------------------------------------------- health */

  async health(force = false): Promise<{ status: LlmHealth; detail: string }> {
    const fresh = this.lastHealth && Date.now() - this.lastHealth.at < 30000
    if (fresh && !force) return { status: this.lastHealth!.status, detail: this.lastHealth!.detail }
    try {
      const driver = await this.getDriver()
      const result = await driver.health()
      this.lastHealth = { ...result, at: Date.now() }
      return result
    } catch (e) {
      const result = { status: 'unreachable' as const, detail: errorMessage(e) }
      this.lastHealth = { ...result, at: Date.now() }
      return result
    }
  }

  async openLogin(): Promise<void> {
    const driver = await this.getDriver()
    await driver.openLogin?.()
  }

  async reset(): Promise<void> {
    const driver = await this.getDriver()
    await driver.reset?.()
  }

  /* -------------------------------------------------------------- requests */

  /** Raw text completion. Used by the options-page test button. */
  async completeText(req: CompleteRequest, label = 'text'): Promise<string> {
    return this.enqueue(label, async () => {
      const driver = await this.getDriver()
      const { llm } = await getSettings()
      return this.attempt(driver, req, llm.maxRetries, label)
    })
  }

  /**
   * Completion validated against a schema. On a parse or validation failure the
   * model is asked again with the specific error, which fixes the common cases
   * (prose around the block, a missing field) without a human in the loop.
   */
  async completeStructured<S extends ZodTypeAny>(
    req: CompleteRequest & { schema: S },
    label = 'structured'
  ): Promise<TypeOf<S>> {
    return this.enqueue(label, async () => {
      const driver = await this.getDriver()
      const { llm } = await getSettings()
      const prompt = `${req.prompt}\n\n${JSON_CONTRACT}`

      let lastParseError: StructuredParseError | null = null

      for (let attempt = 0; attempt <= 1; attempt++) {
        const promptForAttempt =
          attempt === 0 || !lastParseError
            ? prompt
            : `${prompt}\n\n${retryInstruction(lastParseError)}`

        const text = await this.attempt(
          driver,
          { ...req, prompt: promptForAttempt },
          llm.maxRetries,
          `${label}#${attempt}`
        )

        try {
          return parseStructured(text, req.schema)
        } catch (e) {
          if (!(e instanceof StructuredParseError)) throw e
          lastParseError = e
          log.warn(`${label}: model reply failed validation, retrying`, {
            error: e.message,
            raw: e.raw.slice(0, 400),
          })
        }
      }

      throw new LlmError(
        `Model never returned valid JSON for ${label}: ${lastParseError?.message ?? 'unknown'}`,
        'transport'
      )
    })
  }

  /** Transport-level retry, distinct from the schema retry above. */
  private async attempt(
    driver: LlmDriver,
    req: CompleteRequest,
    retries: number,
    label: string
  ): Promise<string> {
    let lastError: unknown
    for (let i = 0; i <= retries; i++) {
      try {
        const started = Date.now()
        const text = await driver.complete(req)
        log.debug(`${label} completed in ${Date.now() - started}ms`, { chars: text.length })
        return text
      } catch (e) {
        lastError = e
        this.lastHealth = null
        if (e instanceof LlmError && !isRetryable(e)) {
          log.error(`${label} failed permanently: ${e.message}`)
          throw e
        }
        if (i === retries) break
        const backoff = 2000 * Math.pow(2, i)
        log.warn(`${label} failed (${errorMessage(e)}); retrying in ${backoff}ms`)
        await sleep(backoff)
        // A wedged chat tab usually recovers with a fresh conversation.
        if (e instanceof LlmError && (e.code === 'timeout' || e.code === 'busy')) {
          await driver.reset?.().catch(() => {})
        }
      }
    }
    throw lastError instanceof Error ? lastError : new LlmError(String(lastError), 'transport')
  }
}

export const llm = new LlmBroker()
