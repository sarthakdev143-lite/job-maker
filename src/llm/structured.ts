/**
 * Turning chat prose into validated objects.
 *
 * A model driven through a chat UI will occasionally wrap JSON in prose, emit
 * smart quotes, leave a trailing comma, or answer in two code blocks. None of
 * that should reach the form filler, so every response goes through extract ->
 * repair -> JSON.parse -> zod. If it still fails, the caller retries once with
 * the validation error appended to the prompt, and then gives up loudly.
 */

import type { TypeOf, ZodTypeAny } from 'zod'

export class StructuredParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message)
    this.name = 'StructuredParseError'
  }
}

/**
 * Pull the most plausible JSON payload out of a chat reply. Prefers a fenced
 * ```json block, then any fenced block, then the outermost balanced braces.
 */
export function extractJsonCandidate(text: string): string | null {
  const raw = String(text ?? '').trim()
  if (!raw) return null

  const fencedJson = [...raw.matchAll(/```json\s*([\s\S]*?)```/gi)]
  if (fencedJson.length > 0) {
    // Last block wins: a model that corrects itself puts the good one last.
    return (fencedJson[fencedJson.length - 1]?.[1] ?? '').trim()
  }

  const fencedAny = [...raw.matchAll(/```\s*([\s\S]*?)```/g)]
  for (let i = fencedAny.length - 1; i >= 0; i--) {
    const body = (fencedAny[i]?.[1] ?? '').trim()
    if (body.startsWith('{') || body.startsWith('[')) return body
  }

  const balanced = extractBalanced(raw)
  if (balanced) return balanced

  if (raw.startsWith('{') || raw.startsWith('[')) return raw
  return null
}

/** Scan for the first balanced {...} or [...] run, respecting string literals. */
function extractBalanced(text: string): string | null {
  const openIdx = Math.min(
    ...[text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0).concat([Number.MAX_SAFE_INTEGER])
  )
  if (openIdx === Number.MAX_SAFE_INTEGER) return null

  const open = text[openIdx]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(openIdx, i + 1)
    }
  }
  return null
}

/**
 * Fix the handful of things chat models actually get wrong. Deliberately
 * conservative: each repair is a targeted rewrite, not a general JSON5 parse,
 * because silently reinterpreting a malformed payload is worse than failing.
 */
export function repairJson(input: string): string {
  let s = input.trim()

  // Strip a stray leading label like "json" left over from a mangled fence.
  s = s.replace(/^json\s*/i, '')

  // Smart quotes around keys and values.
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")

  // Trailing commas before a closer.
  s = s.replace(/,(\s*[}\]])/g, '$1')

  // Unquoted keys: {score: 1} -> {"score": 1}
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')

  // Single-quoted string values -> double quoted, when they contain no quotes.
  s = s.replace(/:\s*'([^'"\n]*)'/g, ': "$1"')

  // Literal newlines inside string values break JSON.parse; escape them.
  s = escapeNewlinesInStrings(s)

  // Python-isms.
  s = s.replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false')

  // NaN / Infinity are not valid JSON.
  s = s.replace(/:\s*(NaN|Infinity|-Infinity)\s*([,}])/g, ': null$2')

  return s
}

function escapeNewlinesInStrings(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false
        out += ch
        continue
      }
      if (ch === '\\') {
        escaped = true
        out += ch
        continue
      }
      if (ch === '"') {
        inString = false
        out += ch
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') continue
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') inString = true
    out += ch
  }
  return out
}

export function parseLoose(text: string): unknown {
  const candidate = extractJsonCandidate(text)
  if (candidate === null) throw new StructuredParseError('No JSON found in model reply', text)
  try {
    return JSON.parse(candidate)
  } catch {
    const repaired = repairJson(candidate)
    try {
      return JSON.parse(repaired)
    } catch (e) {
      throw new StructuredParseError(
        `Could not parse model reply as JSON: ${(e as Error).message}`,
        text
      )
    }
  }
}

/** Parse and validate. Throws StructuredParseError with the raw text attached. */
export function parseStructured<S extends ZodTypeAny>(text: string, schema: S): TypeOf<S> {
  const value = parseLoose(text)
  const result = schema.safeParse(value)
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new StructuredParseError(`Model reply failed validation: ${issues}`, text)
  }
  return result.data
}

/** Feedback appended to a retry prompt after a parse or validation failure. */
export function retryInstruction(error: StructuredParseError): string {
  return [
    'Your previous reply could not be used.',
    `Problem: ${error.message}`,
    'Reply again with ONLY one fenced json code block containing valid JSON matching the requested shape. No prose.',
  ].join('\n')
}
