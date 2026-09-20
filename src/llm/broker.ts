/**
 * The LLM broker.
 *
 * One queue, one request in flight, whichever driver is configured. Callers ask
 * for a validated object and get one or an exception -- they never see raw
 * model text, never handle retries, and never have to know that the default
 * driver is a browser tab that can only do one thing at a time.
 */

import { DeepSeekWebDriver } from './drivers/deepseek-web'
import { AnthropicDriver, NimDriver, OpenAiCompatibleDriver } from './drivers/api'
import { LlmError, isRetryable, type CompleteRequest, type LlmDriver, type LlmHealth } from './driver'
import { JSON_CONTRACT } from '@/storage/defaults'
import { StructuredParseError, parseStructured, retryInstruction } from './structured'
import { getSettings } from '@/storage/settings'
import { createLogger } from '@/shared/logger'
import { errorMessage, sleep } from '@/shared/util'
import { activity } from '@/shared/activity'
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
  /**
   * Second priority behind any API driver: the free web driver.
   *
   * Built lazily and keyed on the primary driver id, so switching providers
   * never leaves a stale fallback behind. Permanent primary errors (a bad key)
   * fail fast and never reach it -- it only sees transient failures a retry
   * might survive.
   */
  private fallback: LlmDriver | null = null
  private fallbackFor = ''
  private queue: Array<QueueTask<unknown>> = []
  private draining = false
  private lastHealth: { status: LlmHealth; detail: string; at: number } | null = null

  /* ---------------------------------------------------------------- driver */

  private buildDriver(config: LlmConfig): LlmDriver {
    switch (config.driver) {
      case 'anthropic-api':
        return new AnthropicDriver(config)
      case 'nvidia-nim':
        return new NimDriver(config)
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
    await this.fallback?.dispose?.().catch(() => {})
    this.fallback = null
    this.fallbackFor = ''
    this.lastHealth = null
  }

  /**
   * The web driver behind an API primary, or null when the web driver *is* the
   * primary. Constructing it touches nothing -- no tab opens until the first
   * failover -- so keeping one warm costs nothing on a healthy night.
   */
  private async getFallbackDriver(primary: LlmDriver, config: LlmConfig): Promise<LlmDriver | null> {
    if (primary.id === 'deepseek-web') return null
    if (!this.fallback || this.fallbackFor !== config.driver) {
      await this.fallback?.dispose?.().catch(() => {})
      this.fallback = new DeepSeekWebDriver(config)
      this.fallbackFor = config.driver
      log.info(`LLM fallback set to ${this.fallback.label}`)
    } else {
      ;(this.fallback as { updateConfig?: (c: LlmConfig) => void }).updateConfig?.(config)
    }
    return this.fallback
  }

  /* ----------------------------------------------------------------- queue */

  private enqueue<T>(label: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ label, run, resolve, reject } as QueueTask<unknown>)
      if (this.queue.length > 1) activity.note(`queued behind ${this.queue.length - 1} other model request(s)`)
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

  /**
   * Model ids this key can call, or null for a driver with no catalogue.
   *
   * Not queued behind the request lock: it is a cheap metadata call and the
   * user is sitting in front of the settings page waiting for it.
   */
  async listModels(): Promise<string[] | null> {
    const driver = await this.getDriver()
    const lister = driver as { listModels?: () => Promise<string[]> }
    if (typeof lister.listModels !== 'function') return null
    return lister.listModels()
  }

  async openLogin(): Promise<void> {
    const driver = await this.getDriver()
    if (driver.openLogin) {
      await driver.openLogin()
      return
    }
    // API primaries have no login page; prepare the fallback instead, since a
    // signed-in tab is what the night falls back on.
    const { llm } = await getSettings()
    const fallback = await this.getFallbackDriver(driver, llm)
    await fallback?.openLogin?.()
  }

  async reset(): Promise<void> {
    const driver = await this.getDriver()
    await driver.reset?.()
    await this.fallback?.reset?.().catch(() => {})
  }

  /* -------------------------------------------------------------- requests */

  /** Raw text completion. Used by the options-page test button. */
  async completeText(
    req: CompleteRequest,
    label = 'text',
    opts: { retries?: number; useFallback?: boolean } = {}
  ): Promise<string> {
    return this.enqueue(label, async () => {
      const driver = await this.getDriver()
      const { llm } = await getSettings()
      const fallback = opts.useFallback === false ? null : await this.getFallbackDriver(driver, llm)
      const retries = opts.retries ?? llm.maxRetries
      return this.attempt(driver, req, retries, label, fallback)
    })
  }

  /**
   * Abandon everything waiting, and forget the current driver.
   *
   * One queue serves the whole extension, so a request grinding through its
   * retry budget blocks every later one behind it -- press "Run test" while a
   * resume import is still failing and the test does not even start for
   * minutes, which reads as two separate things being broken. This is the way
   * out of that without reloading the extension.
   */
  async abortQueue(): Promise<number> {
    const dropped = this.queue.length
    const waiting = this.queue.splice(0, this.queue.length)
    for (const task of waiting) {
      task.reject(new LlmError(`Cancelled: ${task.label} was dropped from the queue`, 'transport'))
    }
    await this.invalidate()
    log.warn(`Model queue cleared: ${dropped} request(s) dropped`)
    return dropped
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
      const fallback = await this.getFallbackDriver(driver, llm)
      const prompt = `${req.prompt}\n\n${JSON_CONTRACT}`

      let lastParseError: StructuredParseError | null = null

      for (let attempt = 0; attempt <= 1; attempt++) {
        const promptForAttempt =
          attempt === 0 || !lastParseError
            ? prompt
            : `${prompt}\n\n${retryInstruction(lastParseError)}`

        const text = await this.attempt(
          driver,
          { ...req, prompt: promptForAttempt, jsonMode: true },
          llm.maxRetries,
          `${label}#${attempt}`,
          fallback
        )

        try {
          return parseStructured(text, req.schema)
        } catch (e) {
          if (!(e instanceof StructuredParseError)) throw e
          lastParseError = e
          const isNoJson = /No JSON found/i.test(e.message)
          log.warn(`${label}: model reply failed validation, retrying`, {
            error: e.message,
            raw: e.raw.slice(0, 400),
          })
          // Diffusion/instruct models sometimes need an extra nudge. If the
          // first attempt produced no JSON at all, the retryInstruction alone
          // is not enough — the JSON_CONTRACT will be re-sent on the next loop.
          if (isNoJson && attempt === 0) continue
        }
      }

      // Transport retries exhausted and still no valid JSON. If we have a
      // fallback (DeepSeek web), try it once — Llama/Mixtral often succeed
      // where diffusion models return prose.
      if (fallback && lastParseError && /No JSON found|failed validation/i.test(lastParseError.message)) {
        try {
          const fbHealth = await fallback.health()
          if (fbHealth.status === 'ok') {
            log.warn(`${label}: ${driver.label} returned no JSON; trying fallback ${fallback.label}`)
            activity.note(`${driver.label} returned no JSON; retrying via ${fallback.label}`)
            const fbText = await fallback.complete({ prompt: `${req.prompt}\n\n${JSON_CONTRACT}\n\n${retryInstruction(lastParseError)}`, jsonMode: true })
            return parseStructured(fbText, req.schema)
          }
        } catch (fbError) {
          // Fall through to the final error below — include both causes.
          log.warn(`${label}: fallback also failed`, { error: (fbError as Error).message })
        }
      }

      throw new LlmError(
        `Model never returned valid JSON for ${label}: ${lastParseError?.message ?? 'unknown'}. ` +
          `Diffusion and base models are not tuned for strict JSON. In Settings → Model, press ` +
          `"List available models" and pick one with "instruct" in its name.`,
        'transport'
      )
    })
  }

  /** Transport-level retry, distinct from the schema retry above. */
  private async attempt(
    driver: LlmDriver,
    req: CompleteRequest,
    retries: number,
    label: string,
    fallback: LlmDriver | null = null
  ): Promise<string> {
    let lastError: unknown
    for (let i = 0; i <= retries; i++) {
      try {
        const started = Date.now()
        activity.note(`asking the model: ${label}`)
        const text = await driver.complete(req)
        const seconds = ((Date.now() - started) / 1000).toFixed(1)
        activity.note(`model answered in ${seconds}s (${text.length} characters)`)
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
    // The primary exhausted its retries on a transient failure. Fail over to
    // second priority for this request rather than parking the application --
    // a bad key never reaches here (it throws above), so this is an outage or
    // rate limit, exactly what a fallback is for.
    if (fallback) {
      // No point waiting 3 minutes for a fallback that is not signed in.
      try {
        const fbHealth = await fallback.health()
        if (fbHealth.status !== 'ok') {
          log.warn(`${label}: ${driver.label} failed (${errorMessage(lastError)}); fallback ${fallback.label} not ready (${fbHealth.detail})`)
          throw new LlmError(
            `${driver.label} failed (${errorMessage(lastError)}); fallback ${fallback.label} not ready: ${fbHealth.detail}. ` +
              `Fix the NIM key/model or sign in to chat.deepseek.com for fallback.`,
            'transport'
          )
        }
      } catch (e) {
        if (e instanceof LlmError) throw e
        // Health check itself failed — proceed to try fallback anyway.
      }
      log.warn(`${label}: ${driver.label} failed (${errorMessage(lastError)}); failing over to ${fallback.label}`)
      activity.note(`${driver.label} failed; retrying via ${fallback.label}`)
      try {
        return await fallback.complete(req)
      } catch (e) {
        throw new LlmError(
          `${label}: ${driver.label} failed (${errorMessage(lastError)}); ` +
            `${fallback.label} fallback also failed (${errorMessage(e)})`,
          e instanceof LlmError ? e.code : 'transport'
        )
      }
    }
    throw lastError instanceof Error ? lastError : new LlmError(String(lastError), 'transport')
  }
}

export const llm = new LlmBroker()
