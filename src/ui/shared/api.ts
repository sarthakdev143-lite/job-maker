/**
 * Typed client for the service worker, plus the hooks every surface uses.
 *
 * The worker is the only source of truth; no UI surface reads storage directly.
 * That keeps the panel, the options page and the popup consistent with each
 * other and with whatever the agent is doing at the time.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { sendToWorker } from '@/shared/messages'
import type { PreflightCheck } from '@/background/orchestrator'
import type { SetupResult } from '@/discovery/setup'
import type { AgentState, BroadcastEvent, UiRequest } from '@/shared/messages'
import type {
  AnswerBankEntry,
  Application,
  FilledField,
  Job,
  LogEvent,
  Profile,
  SearchRecipe,
  Settings,
  SuggestedRules,
} from '@/storage/schemas'

export const api = {
  getState: () => sendToWorker<AgentState>({ type: 'ui:getState' }),
  getSettings: () => sendToWorker<Settings>({ type: 'ui:getSettings' }),
  saveSettings: (settings: Settings) => sendToWorker<Settings>({ type: 'ui:saveSettings', settings }),
  getProfile: () => sendToWorker<Profile>({ type: 'ui:getProfile' }),
  saveProfile: (profile: Profile) => sendToWorker<Profile>({ type: 'ui:saveProfile', profile }),
  parseResume: (text: string, mode: 'fill_empty' | 'replace') =>
    sendToWorker<ResumeImportResult>({ type: 'ui:parseResume', text, mode }),
  suggestRules: () => sendToWorker<SuggestedRules>({ type: 'ui:suggestRules' }),
  setupSearches: () => sendToWorker<SetupResult>({ type: 'ui:setupSearches' }),
  getRecipes: () => sendToWorker<SearchRecipe[]>({ type: 'ui:getRecipes' }),
  saveRecipe: (recipe: SearchRecipe) => sendToWorker<SearchRecipe[]>({ type: 'ui:saveRecipe', recipe }),
  deleteRecipe: (id: string) => sendToWorker<SearchRecipe[]>({ type: 'ui:deleteRecipe', id }),
  runDiscovery: (recipeId?: string) => sendToWorker<unknown>({ type: 'ui:runDiscovery', recipeId }),
  listJobs: (status?: string, limit?: number) => sendToWorker<Job[]>({ type: 'ui:listJobs', status, limit }),
  listApplications: (status?: string, limit?: number) =>
    sendToWorker<Application[]>({ type: 'ui:listApplications', status, limit }),
  getApplication: (id: string) => sendToWorker<Application | null>({ type: 'ui:getApplication', id }),
  queueJob: (jobId: string) => sendToWorker<Job | null>({ type: 'ui:queueJob', jobId }),
  skipJob: (jobId: string, reason?: string) => sendToWorker<Job | null>({ type: 'ui:skipJob', jobId, reason }),
  approve: (id: string, edits?: FilledField[]) => sendToWorker<unknown>({ type: 'ui:approveApplication', id, edits }),
  reject: (id: string) => sendToWorker<unknown>({ type: 'ui:rejectApplication', id }),
  retry: (id: string) => sendToWorker<unknown>({ type: 'ui:retryApplication', id }),
  preflight: () => sendToWorker<PreflightCheck[]>({ type: 'ui:preflight' }),
  start: () => sendToWorker<AgentState>({ type: 'ui:startAgent' }),
  stop: () => sendToWorker<AgentState>({ type: 'ui:stopAgent' }),
  kill: () => sendToWorker<AgentState>({ type: 'ui:killSwitch' }),
  testLlm: (prompt?: string) => sendToWorker<{ reply: string }>({ type: 'ui:testLlm', prompt }),
  llmHealth: () => sendToWorker<{ status: string; detail: string }>({ type: 'ui:llmHealth' }),
  openLlmLogin: () => sendToWorker<unknown>({ type: 'ui:openLlmLogin' }),
  listAnswers: (query?: string) => sendToWorker<AnswerBankEntry[]>({ type: 'ui:listAnswers', query }),
  saveAnswer: (label: string, value: string, pinned?: boolean) =>
    sendToWorker<AnswerBankEntry | null>({ type: 'ui:saveAnswer', label, value, pinned }),
  deleteAnswer: (id: string) => sendToWorker<unknown>({ type: 'ui:deleteAnswer', id }),
  listLogs: (limit?: number) => sendToWorker<LogEvent[]>({ type: 'ui:listLogs', limit }),
  clearLogs: () => sendToWorker<unknown>({ type: 'ui:clearLogs' }),
  stats: () => sendToWorker<Stats>({ type: 'ui:stats' }),
  exportData: () => sendToWorker<{ payload: string }>({ type: 'ui:exportData' }),
  importData: (payload: string) => sendToWorker<unknown>({ type: 'ui:importData', payload }),
  previewResume: () => sendToWorker<{ dataUrl: string; sizeBytes: number }>({ type: 'ui:previewResume' }),
  downloadDoc: (docId: string) => sendToWorker<{ dataUrl: string; fileName: string }>({ type: 'ui:downloadDoc', docId }),
  dryRunUrl: (url: string) =>
    sendToWorker<{ fields: number; plan: FilledField[]; unresolved: unknown[] }>({ type: 'ui:dryRunUrl', url }),
  raw: <T>(msg: UiRequest) => sendToWorker<T>(msg),
}

export type ResumeImportResult = {
  profile: Profile
  changes: string[]
  skipped: string[]
  gaps: string[]
  roles: number
  seeded: number
}

export type { PreflightCheck, SetupResult }

/** Open the settings page at a particular section. */
export function openSettings(section?: string): void {
  const base = chrome.runtime.getURL('src/ui/options/index.html')
  void chrome.tabs.create({ url: section ? `${base}#${section}` : base })
}

export type Stats = {
  counts: Record<string, number>
  storage: Record<string, number>
  answers: number
  submittedTotal: number
  averageScore: number
  llmQueueDepth: number
}

/* ----------------------------------------------------------------- hooks */

/** Subscribe to worker broadcasts. Returns a monotonically increasing tick. */
export function useWorkerEvents(kinds: Array<BroadcastEvent['type']>): {
  tick: number
  state: AgentState | null
  logLine: { level: string; scope: string; message: string; at: number } | null
} {
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<AgentState | null>(null)
  const [logLine, setLogLine] = useState<{ level: string; scope: string; message: string; at: number } | null>(null)
  const wanted = useRef(kinds)
  wanted.current = kinds

  useEffect(() => {
    const listener = (msg: BroadcastEvent) => {
      if (!msg || typeof msg !== 'object' || !String(msg.type ?? '').startsWith('evt:')) return
      if (!wanted.current.includes(msg.type)) return
      if (msg.type === 'evt:state') setState(msg.state)
      if (msg.type === 'evt:log') setLogLine({ level: msg.level, scope: msg.scope, message: msg.message, at: msg.at })
      setTick((t) => t + 1)
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  return { tick, state, logLine }
}

/** Load-once-with-refresh. `deps` re-runs the loader like useEffect would. */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[] = []
): { data: T | null; error: string; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loaderRef.current().then(
      (value) => {
        if (cancelled) return
        setData(value)
        setError('')
        setLoading(false)
      },
      (e: Error) => {
        if (cancelled) return
        setError(e.message)
        setLoading(false)
      }
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  return { data, error, loading, reload: useCallback(() => setNonce((n) => n + 1), []) }
}

/** Run an action, tracking pending state and surfacing the error message. */
export function useAction(): {
  run: (fn: () => Promise<unknown>, label?: string) => Promise<void>
  busy: string
  error: string
  clearError: () => void
} {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const run = useCallback(async (fn: () => Promise<unknown>, label = 'working') => {
    setBusy(label)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }, [])

  return { run, busy, error, clearError: useCallback(() => setError(''), []) }
}

/** Save a data URL to disk through the downloads API. */
export async function download(dataUrl: string, fileName: string): Promise<void> {
  await chrome.downloads.download({ url: dataUrl, filename: fileName, saveAs: true })
}

/* ------------------------------------------------------------ live state */

/**
 * A ticking clock for elapsed-time displays.
 *
 * The worker only pushes state when something changes; a step that is legitimately
 * taking forty seconds would otherwise render as a frozen "0s". Ticking locally
 * keeps the number moving without any traffic.
 */
export function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/**
 * The agent's state, kept live.
 *
 * Combines pushed updates with polling, because the two answer different
 * questions: a push says what changed, and a successful poll proves the service
 * worker is still alive at all. A failed poll is itself the signal that the
 * agent is genuinely stuck rather than merely busy.
 */
export function useLiveState(): { state: AgentState | null; reachable: boolean; reload: () => void } {
  const [state, setState] = useState<AgentState | null>(null)
  const [reachable, setReachable] = useState(true)
  const [nonce, setNonce] = useState(0)

  const fetchState = useCallback(async () => {
    try {
      setState(await api.getState())
      setReachable(true)
    } catch {
      setReachable(false)
    }
  }, [])

  useEffect(() => {
    const listener = (msg: BroadcastEvent) => {
      if (msg?.type === 'evt:state') {
        setState(msg.state)
        setReachable(true)
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  useEffect(() => {
    void fetchState()
  }, [fetchState, nonce])

  // Poll briskly while it is working, sparingly when it is not.
  const running = state?.running ?? false
  useEffect(() => {
    const id = setInterval(fetchState, running ? 2000 : 8000)
    return () => clearInterval(id)
  }, [fetchState, running])

  return { state, reachable, reload: useCallback(() => setNonce((n) => n + 1), []) }
}
