/** Small, dependency-free helpers shared by the worker, content scripts and UI. */

export function uid(prefix = ''): string {
  const rand = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  return prefix ? `${prefix}_${rand}` : rand
}

export function now(): number {
  return Date.now()
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Randomized delay. Every pause the agent takes on a real site goes through
 * this rather than a constant, so its timing does not look metronomic.
 */
export function jitter(min: number, max: number): number {
  if (max <= min) return Math.max(0, min)
  return Math.floor(min + Math.random() * (max - min))
}

export async function pause(range: { min: number; max: number }): Promise<void> {
  await sleep(jitter(range.min, range.max))
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

export function dayKey(ts: number = Date.now()): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Stable non-cryptographic hash; used for job dedupe keys. */
export function hashString(input: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

/** Retry with exponential backoff. Rethrows the final error. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries?: number; baseMs?: number; onRetry?: (e: unknown, attempt: number) => void } = {}
): Promise<T> {
  const retries = opts.retries ?? 2
  const baseMs = opts.baseMs ?? 1000
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      lastError = err
      opts.onRetry?.(err, attempt)
      if (attempt === retries) break
      await sleep(baseMs * Math.pow(2, attempt) + jitter(0, 400))
    }
  }
  throw lastError
}

/** Reject after `ms`, so a hung tab can never wedge the run queue forever. */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

/** Fetch that actually aborts the request on timeout, so a hung API does not wedge the queue for minutes. */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit & { timeoutMs: number; label?: string }
): Promise<Response> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), init.timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(`${init.label ?? 'request'} timed out after ${init.timeoutMs}ms`)
    }
    throw e
  } finally {
    clearTimeout(t)
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return 'never'
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

export function groupBy<T, K extends string | number>(
  items: T[],
  key: (item: T) => K
): Record<K, T[]> {
  const out = {} as Record<K, T[]>
  for (const item of items) {
    const k = key(item)
    ;(out[k] ||= []).push(item)
  }
  return out
}
