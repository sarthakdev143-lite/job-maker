/**
 * The driver contract.
 *
 * Everything above this line (scoring, field answering, tailoring) only ever
 * sees `complete()`. Swapping DeepSeek's web UI for an API key is a settings
 * change, not a refactor, which matters because the web driver is the most
 * fragile part of the system and will eventually need replacing.
 */

import type { LlmConfig } from '@/storage/schemas'

export type LlmHealth = 'ok' | 'needs_login' | 'unreachable'

export type CompleteRequest = {
  /** The full prompt. Drivers with a system role split this on the marker. */
  prompt: string
  /** Optional system text; the web driver prepends it to the prompt instead. */
  system?: string
  timeoutMs?: number
  /** Hint that this is a fresh topic, so the web driver opens a new chat. */
  freshContext?: boolean
  /** When true, API drivers should request JSON object mode if the provider supports it. */
  jsonMode?: boolean
}

export interface LlmDriver {
  readonly id: string
  readonly label: string
  /** Cheap check. Must not send a prompt. */
  health(): Promise<{ status: LlmHealth; detail: string }>
  /** Returns the model's raw reply text. Parsing happens in the broker. */
  complete(req: CompleteRequest): Promise<string>
  /** Discard conversational state, if the driver has any. */
  reset?(): Promise<void>
  /** Bring whatever the user needs to fix (a login page) into view. */
  openLogin?(): Promise<void>
  /** Release tabs, windows or sockets. */
  dispose?(): Promise<void>
}

export type DriverFactory = (config: LlmConfig) => LlmDriver

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: 'not_ready' | 'not_logged_in' | 'timeout' | 'busy' | 'dom_changed' | 'transport' | 'config' = 'transport'
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

/** True when retrying the same request has any chance of a different outcome. */
export function isRetryable(e: unknown): boolean {
  if (!(e instanceof LlmError)) return true
  return e.code === 'timeout' || e.code === 'busy' || e.code === 'transport'
}
