/**
 * The single typed message protocol for the extension.
 *
 * Three senders talk to the service worker: the UI surfaces (side panel,
 * options, popup), the chat-site bridge content script, and the form agent
 * content script. Everything is request/response over chrome.runtime with a
 * discriminated union, so adding a message without handling it is a type error
 * in the worker's router.
 */

import type { ActivityStep } from './activity'
import type { PageOutline } from '@/form/outline'
import type {
  Application,
  FieldDescriptor,
  FilledField,
  Job,
  Profile,
  SearchRecipe,
  Settings,
} from '@/storage/schemas'

/* ------------------------------------------------------- UI -> background */

export type UiRequest =
  | { type: 'ui:getState' }
  | { type: 'ui:getSettings' }
  | { type: 'ui:saveSettings'; settings: Settings }
  | { type: 'ui:getProfile' }
  | { type: 'ui:saveProfile'; profile: Profile }
  | { type: 'ui:parseResume'; text: string; mode: 'fill_empty' | 'replace' }
  | { type: 'ui:suggestRules' }
  | { type: 'ui:setupSearches' }
  | { type: 'ui:getRecipes' }
  | { type: 'ui:saveRecipe'; recipe: SearchRecipe }
  | { type: 'ui:deleteRecipe'; id: string }
  | { type: 'ui:runDiscovery'; recipeId?: string }
  /** Score what discovery found, without applying to any of it. */
  | { type: 'ui:scoreQueue'; limit?: number }
  /** Why the filtered-out pile is the size it is. */
  | { type: 'ui:rejectionSummary' }
  /** Queued jobs sitting on sites the extension has no access to. */
  | { type: 'ui:accessNeeded' }
  /** How much of the form filling is already answered without a model call. */
  | { type: 'ui:bankCoverage' }
  /** What each search source contributed, against what it cost to sift. */
  | { type: 'ui:sourceYield' }
  /** Questions that keep stopping applications, worth answering once. */
  | { type: 'ui:recurringParks' }
  | { type: 'ui:listJobs'; status?: string; limit?: number }
  | { type: 'ui:listApplications'; status?: string; limit?: number }
  | { type: 'ui:getApplication'; id: string }
  | { type: 'ui:queueJob'; jobId: string }
  | { type: 'ui:skipJob'; jobId: string; reason?: string }
  | { type: 'ui:approveApplication'; id: string; edits?: FilledField[] }
  | { type: 'ui:rejectApplication'; id: string }
  | { type: 'ui:retryApplication'; id: string }
  | { type: 'ui:preflight' }
  | { type: 'ui:autopilot' }
  | { type: 'ui:version' }
  | { type: 'ui:startAgent' }
  | { type: 'ui:stopAgent' }
  | { type: 'ui:killSwitch' }
  | { type: 'ui:testLlm'; prompt?: string }
  | { type: 'ui:listModels' }
  | { type: 'ui:cancelModelQueue' }
  /** Page snapshots kept when an application failed; see storage/evidence.ts. */
  | { type: 'ui:listEvidence' }
  | { type: 'ui:clearEvidence' }
  /** Apply controls learned per host; see storage/site-memory.ts. */
  | { type: 'ui:listSiteMemory' }
  | { type: 'ui:clearSiteMemory' }
  /** Run the extension's own diagnostics; see background/self-test.ts. */
  | { type: 'ui:selfTest'; probePages?: boolean; probeCount?: number; probeUrl?: string }
  | { type: 'ui:llmHealth' }
  | { type: 'ui:openLlmLogin' }
  | { type: 'ui:listAnswers'; query?: string }
  | { type: 'ui:saveAnswer'; id?: string; label: string; value: string; pinned?: boolean }
  | { type: 'ui:deleteAnswer'; id: string }
  | { type: 'ui:listLogs'; limit?: number }
  | { type: 'ui:getLastRun' }
  | { type: 'ui:getRunHistory'; limit?: number }
  | { type: 'ui:getRecipeHealth' }
  | { type: 'ui:clearLogs' }
  | { type: 'ui:stats' }
  | { type: 'ui:exportData' }
  | { type: 'ui:importData'; payload: string }
  | { type: 'ui:previewResume'; jobId?: string }
  | { type: 'ui:downloadDoc'; docId: string }
  | { type: 'ui:dryRunUrl'; url: string }

/* ------------------------------------ background -> chat-site content script */

/**
 * Sent by the bridge while a reply streams in, purely so the UI can prove it is
 * alive.
 *
 * Named for the channel, not the vendor: the bridge serves DeepAI and DeepSeek
 * alike, and a `ds:` prefix outlived the assumption that DeepSeek was the only
 * site.
 */
export type ChatProgress = {
  type: 'chat:progress'
  requestId: string
  chars: number
  generating: boolean
}

export type ChatRequest =
  | { type: 'chat:ping' }
  | { type: 'chat:status' }
  | { type: 'chat:newChat' }
  | { type: 'chat:send'; requestId: string; prompt: string; timeoutMs: number }

export type ChatBridgeErrorCode =
  | 'not_ready'
  | 'not_logged_in'
  | 'timeout'
  | 'busy'
  | 'dom_changed'
  | 'exhausted'

export type ChatResponse =
  | { ok: true; type: 'chat:pong'; ready: boolean; loggedIn: boolean; site: string }
  | { ok: true; type: 'chat:status'; ready: boolean; loggedIn: boolean; busy: boolean; detail: string; site: string }
  | { ok: true; type: 'chat:newChat' }
  | { ok: true; type: 'chat:reply'; requestId: string; text: string }
  | { ok: false; error: string; code?: ChatBridgeErrorCode }

/* ---------------------------------------- background -> form content script */

export type FormRequest =
  | { type: 'form:ping' }
  | { type: 'form:detect' }
  | { type: 'form:harvest' }
  | { type: 'form:fill'; plan: FilledField[]; pacing: { min: number; max: number } }
  | { type: 'form:uploadFile'; selector: string; fileName: string; mimeType: string; dataUrl: string }
  | { type: 'form:submit'; selector?: string }
  | { type: 'form:verifySubmission' }
  | { type: 'form:advanceStep' }
  | { type: 'form:snapshot' }
  /** A model-readable description of the rendered page; see form/outline.ts. */
  | { type: 'form:outline' }
  /** Click one specific control, used for a target the model picked. */
  | { type: 'form:click'; selector: string }
  | { type: 'form:highlight'; selectors: string[] }

export type FormDetectResult = {
  vendor: string
  isApplicationForm: boolean
  /** True when pressing the entry button submits outright; see DetectResult. */
  entrySubmitsImmediately?: boolean
  jobTitle: string
  company: string
  confidence: number
  multiStep: boolean
  detail: string
  /**
   * This page is the one that sends the application.
   *
   * The runner used to advance blindly and hope it landed on the final screen,
   * which on a five-step wizard it usually did not: it bailed out somewhere in
   * the middle, called submit there, and was correctly refused. Asking the page
   * itself removes the guesswork.
   */
  readyToSubmit: boolean
}

export type FormFillResult = {
  filled: FilledField[]
  failed: FilledField[]
}

export type FormSubmitResult = {
  clicked: boolean
  selector: string
  detail: string
}

export type FormVerifyResult = {
  submitted: boolean
  signal: string
  detail: string
}

export type FormResponse =
  | { ok: true; type: 'form:pong'; href: string }
  | { ok: true; type: 'form:detect'; result: FormDetectResult }
  | { ok: true; type: 'form:harvest'; fields: FieldDescriptor[]; vendor: string; multiStep: boolean }
  | { ok: true; type: 'form:fill'; result: FormFillResult }
  | { ok: true; type: 'form:uploadFile'; success: boolean; detail: string }
  | { ok: true; type: 'form:submit'; result: FormSubmitResult }
  | { ok: true; type: 'form:verifySubmission'; result: FormVerifyResult }
  | { ok: true; type: 'form:advanceStep'; advanced: boolean; detail: string }
  | { ok: true; type: 'form:snapshot'; html: string; text: string }
  | { ok: true; type: 'form:outline'; outline: PageOutline }
  | { ok: true; type: 'form:click'; clicked: boolean; detail: string }
  | { ok: true; type: 'form:highlight' }
  | { ok: false; error: string }

/* ------------------------------------------------ background -> UI (events) */

export type AgentPhase =
  | 'idle'
  | 'discovering'
  | 'scoring'
  | 'applying'
  | 'paused'
  | 'stopped'
  | 'error'

export type AgentState = {
  running: boolean
  phase: AgentPhase
  currentJobId: string
  /** Mirror of `step.label`, kept for surfaces that only need one line. */
  currentStep: string
  /** The live picture: what it is doing, since when, and what is blocking. */
  step: ActivityStep
  llmHealth: 'ok' | 'needs_login' | 'unreachable' | 'unknown'
  appliedToday: number
  dailyCap: number
  queueDepth: number
  reviewDepth: number
  lastError: string
  startedAt: number | null
  updatedAt: number
}

export type BroadcastEvent =
  | { type: 'evt:state'; state: AgentState }
  | { type: 'evt:log'; level: 'debug' | 'info' | 'warn' | 'error'; scope: string; message: string; at: number }
  | { type: 'evt:activity'; label: string; detail: string; at: number }
  | { type: 'evt:jobs' }
  | { type: 'evt:applications' }

/* ------------------------------------------------------------- envelope */

export type AnyRequest = UiRequest | ChatRequest | FormRequest

export type Ok<T> = { ok: true; data: T }
export type Err = { ok: false; error: string }
export type Result<T> = Ok<T> | Err

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data }
}

export function err(error: string): Err {
  return { ok: false, error }
}

/** Typed wrapper around chrome.runtime.sendMessage for UI surfaces. */
/**
 * Ceiling on how long any UI call waits for the worker.
 *
 * Generous, because a real model request legitimately runs for minutes and
 * cutting one off early would be worse than waiting. The point is only that a
 * worker which died without answering cannot leave a button reading "Asking..."
 * for the rest of the session -- chrome.runtime.sendMessage does not always
 * reject when its port dies, and an un-settled promise is indistinguishable
 * from a frozen extension.
 */
const WORKER_REPLY_TIMEOUT_MS = 10 * 60 * 1000

export async function sendToWorker<T = unknown>(msg: UiRequest): Promise<T> {
  let res: Result<T> | undefined
  try {
    res = (await Promise.race([
      chrome.runtime.sendMessage(msg) as Promise<Result<T> | undefined>,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `The background worker did not answer "${msg.type}" within 10 minutes. ` +
                  'Open chrome://extensions and press Reload on this extension. ' +
                  'If a model request was running, check Settings -> Model and lower the request timeout.'
              )
            ),
          WORKER_REPLY_TIMEOUT_MS
        )
      ),
    ])) as Result<T> | undefined
  } catch (e) {
    throw new Error(explainWorkerError((e as Error).message))
  }
  if (!res) throw new Error('No response from background worker')
  if (!res.ok) throw new Error(explainWorkerError(res.error))
  return res.data
}

/**
 * Chrome can serve a freshly built panel while still running the previously
 * registered background worker, which answers new messages with "Unhandled
 * request" -- a message that reads like a bug in the extension when it is
 * really just a missed reload. Say what to do instead.
 */
export function explainWorkerError(error: string): string {
  if (/^Unhandled request/.test(error)) {
    return (
      'The background worker is running an older build of the extension. ' +
      'Open chrome://extensions and press Reload on this extension, then reopen this panel.'
    )
  }
  // Chrome tore down the service worker mid-request -- normally because the
  // request ran long enough to be evicted, or the panel/tab that sent it was
  // closed first. The worker itself is not broken; whatever it was doing may
  // have completed anyway (check the log), but this specific reply was lost.
  if (/message channel closed|message port closed|Could not establish connection/i.test(error)) {
    return (
      'The background worker restarted before it finished replying (this can happen on a slow model ' +
      'request). Check the Log tab to see whether it actually completed, then try again.'
    )
  }
  return error
}

/** Typed wrapper around chrome.tabs.sendMessage for worker -> content script. */
export async function sendToTab<R>(tabId: number, msg: FormRequest | ChatRequest, frameId?: number): Promise<R> {
  const options = frameId === undefined ? undefined : { frameId }
  const res = (await chrome.tabs.sendMessage(tabId, msg, options as chrome.tabs.MessageSendOptions)) as R | undefined
  if (res === undefined) throw new Error('No response from content script')
  return res
}
