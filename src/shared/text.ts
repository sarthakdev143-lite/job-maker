/**
 * Text normalization and matching.
 *
 * The answer bank lives or dies on `normalizeQuestion`: the same question asked
 * by two ATS vendors ("Are you legally authorized to work in the US?" vs
 * "Are you legally authorised to work in the United States?*") has to collapse
 * to the same key, or the bank never hits and every application pays for an
 * LLM call.
 */

import type { Seniority, WorkMode } from '@/storage/schemas'

const PUNCT = /[‘’“”''""`´]/g

/** Words that carry no meaning in a form question and only add noise. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'do', 'does', 'did', 'you', 'your', 'please',
  'we', 'our', 'us', 'this', 'that', 'to', 'of', 'in', 'on', 'for', 'and',
  'or', 'be', 'will', 'would', 'have', 'has', 'any', 'if', 'at', 'as', 'by',
  'with', 'from', 'it', 'may', 'can', 'could', 'should', 'required', 'optional',
])

/** Spelling and phrasing variants that mean the same thing to us. */
const SYNONYMS: Record<string, string> = {
  authorised: 'authorized',
  authorisation: 'authorization',
  organisation: 'organization',
  organisations: 'organizations',
  favourite: 'favorite',
  centre: 'center',
  programme: 'program',
  cv: 'resume',
  resumes: 'resume',
  'e-mail': 'email',
  mail: 'email',
  mobile: 'phone',
  telephone: 'phone',
  cellphone: 'phone',
  cell: 'phone',
  firstname: 'first name',
  lastname: 'last name',
  surname: 'last name',
  familyname: 'last name',
  givenname: 'first name',
  ctc: 'compensation',
  salary: 'compensation',
  remuneration: 'compensation',
  pay: 'compensation',
  usa: 'united states',
  us: 'united states',
  uk: 'united kingdom',
  yrs: 'years',
  yr: 'year',
  exp: 'experience',
  linkedin: 'linkedin',
  github: 'github',
}

export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/** Lowercase, de-punctuate, collapse whitespace. Used everywhere. */
export function normalizeText(input: string): string {
  return stripDiacritics(String(input ?? ''))
    .replace(PUNCT, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Canonical key for a form question. Drops the required marker, trailing
 * punctuation, parentheticals like "(optional)", stop words and spelling
 * variants, then sorts nothing -- word order is kept because "current company"
 * and "company current" are not usefully different, but token-set scoring
 * handles ordering later.
 */
export function normalizeQuestion(input: string): string {
  let s = normalizeText(input)
  s = s.replace(/\(([^)]*)\)/g, ' $1 ') // unwrap parentheticals, keep contents
  s = s.replace(/\b(required|optional|mandatory)\b/g, ' ')
  s = s.replace(/[*:?.,!;]/g, ' ')
  s = s.replace(/[^a-z0-9+#/\- ]/g, ' ')
  const tokens = s
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => SYNONYMS[t] ?? t)
    .join(' ')
    .split(/\s+/)
    .filter((t) => t && !STOP_WORDS.has(t))
  return tokens.join(' ').trim()
}

export function tokenSet(s: string): Set<string> {
  return new Set(normalizeQuestion(s).split(' ').filter(Boolean))
}

/**
 * Token-set similarity in [0,1]. Deliberately not Levenshtein: form questions
 * differ by inserted words far more often than by typos, and Jaccard over
 * tokens handles that better while staying cheap.
 */
export function similarity(a: string, b: string): number {
  const A = tokenSet(a)
  const B = tokenSet(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  const union = A.size + B.size - inter
  const jaccard = inter / union
  // Containment bonus: "first name" inside "legal first name" should score high.
  const containment = inter / Math.min(A.size, B.size)
  return Math.max(jaccard, containment * 0.92)
}

export function bestMatch<T>(
  query: string,
  items: T[],
  toText: (item: T) => string,
  threshold = 0.72
): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null
  for (const item of items) {
    const score = similarity(query, toText(item))
    if (score >= threshold && (!best || score > best.score)) best = { item, score }
  }
  return best
}

/* --------------------------------------------------------------- job text */

const SENIORITY_PATTERNS: Array<[Seniority, RegExp]> = [
  ['intern', /\b(intern|internship|trainee|apprentice)\b/],
  ['director', /\b(director|vp|vice president|head of|chief)\b/],
  ['manager', /\b(manager|engineering manager|em)\b/],
  ['lead', /\b(lead|tech lead|team lead|principal)\b/],
  ['staff', /\b(staff|architect)\b/],
  ['senior', /\b(senior|sr\.?|iii|iv)\b/],
  ['junior', /\b(junior|jr\.?|entry[- ]level|graduate|fresher|associate i\b|\bi\b)\b/],
  ['mid', /\b(mid[- ]level|ii)\b/],
]

export function detectSeniority(title: string, description = ''): Seniority {
  const t = normalizeText(title)
  for (const [level, re] of SENIORITY_PATTERNS) if (re.test(t)) return level
  const d = normalizeText(description).slice(0, 1200)
  const yearsMatch = d.match(/(\d+)\+?\s*(?:-\s*\d+\s*)?years?/)
  if (yearsMatch) {
    const y = Number(yearsMatch[1])
    if (y <= 1) return 'junior'
    if (y <= 4) return 'mid'
    if (y <= 8) return 'senior'
    return 'staff'
  }
  return 'unknown'
}

/**
 * Is this role remote, hybrid or in an office?
 *
 * Evidence in order of how much it is worth. The posting's location field and
 * its title are deliberate statements about where the job is. The description
 * is not: a company that calls itself "a distributed team" in its culture
 * paragraph made every one of its San Francisco roles look remote, which is how
 * a remote-only search filled up with jobs in California.
 *
 * So the description only carries the day when it says something unambiguous
 * about *this role* -- "fully remote", "remote position", "work from home" --
 * rather than merely containing the word somewhere.
 */
const HYBRID = /\bhybrid\b/
const REMOTE_ANY = /\b(remote|work from home|wfh|anywhere|distributed)\b/
const REMOTE_EXPLICIT =
  /\b((fully|100%|completely|entirely|permanently)\s+remote|remote[- ](position|role|job|opportunity|based)|work from home|this (role|position) is remote)\b/
const ONSITE = /\b(on[- ]?site|in[- ]office|in person)\b/

export function detectWorkMode(description: string, location = '', title = ''): WorkMode {
  const loc = normalizeText(location)
  if (loc) {
    if (HYBRID.test(loc)) return 'hybrid'
    if (REMOTE_ANY.test(loc)) return 'remote'
  }

  const head = normalizeText(title)
  if (head) {
    if (HYBRID.test(head)) return 'hybrid'
    if (REMOTE_ANY.test(head)) return 'remote'
  }

  const body = normalizeText(description)
  if (HYBRID.test(body)) return 'hybrid'
  if (REMOTE_EXPLICIT.test(body)) return 'remote'

  // A named place, and nothing said this role escapes it.
  if (loc && /[a-z]/.test(loc)) return 'onsite'

  if (ONSITE.test(body)) return 'onsite'
  if (REMOTE_ANY.test(body)) return 'remote'
  return 'unknown'
}

const CURRENCY_MULTIPLIER: Record<string, number> = {
  k: 1e3,
  lpa: 1e5,
  lakh: 1e5,
  lac: 1e5,
  l: 1e5,
  cr: 1e7,
  crore: 1e7,
  m: 1e6,
  mn: 1e6,
}

/**
 * Best-effort salary extraction. Returns annualized numbers in the posting's
 * own currency; comparison against a floor only happens when the currency
 * matches the user's, because converting would be guesswork.
 */
export function parseSalary(text: string): { min: number | null; max: number | null; currency: string } {
  const t = normalizeText(text).replace(/,/g, '')
  if (!t) return { min: null, max: null, currency: '' }

  let currency = ''
  if (/[$]|usd|dollars?/.test(t)) currency = 'USD'
  else if (/[₹]|inr|rs\.?\b|rupees?/.test(t)) currency = 'INR'
  else if (/[£]|gbp|pounds?/.test(t)) currency = 'GBP'
  else if (/[€]|eur|euros?/.test(t)) currency = 'EUR'

  const re = /(\d+(?:\.\d+)?)\s*(k|lpa|lakhs?|lacs?|l|crores?|cr|mn|m)?/g
  const raw: Array<{ value: number; mult: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) {
    const n = Number(m[1])
    if (!Number.isFinite(n)) continue
    const unit = (m[2] || '').replace(/s$/, '')
    raw.push({ value: n, mult: unit ? CURRENCY_MULTIPLIER[unit] ?? 1 : 1 })
    if (raw.length >= 6) break
  }

  // A range states its unit once, at the end: "25-35 LPA" means both numbers
  // are lakhs. Without this, the lower bound is read as twenty-five rupees and
  // discarded, and a salary floor is then compared against the wrong number.
  const statedMultiplier = raw.find((r) => r.mult > 1)?.mult ?? 1
  const found = raw
    .map((r) => r.value * (r.mult > 1 ? r.mult : statedMultiplier))
    // Ignore obvious non-salary numbers (years, counts, tiny values).
    .filter((v) => v >= 1000)
    .slice(0, 4)

  if (found.length === 0) return { min: null, max: null, currency }
  const sorted = found.sort((a, b) => a - b)
  return {
    min: sorted[0] ?? null,
    max: sorted.length > 1 ? sorted[sorted.length - 1] ?? null : null,
    currency,
  }
}

/** Parse relative posting dates as seen on job boards ("3 days ago", "today"). */
export function parsePostedDate(text: string, base = Date.now()): number | null {
  const t = normalizeText(text)
  if (!t) return null
  if (/just posted|today|few hours|hours? ago|new\b/.test(t)) return base
  if (/yesterday/.test(t)) return base - 86400000
  const m = t.match(/(\d+)\+?\s*(minute|hour|day|week|month)s?\s*ago/)
  if (m) {
    const n = Number(m[1])
    const unit = m[2]
    const ms =
      unit === 'minute' ? 60000 : unit === 'hour' ? 3600000 : unit === 'day' ? 86400000 : unit === 'week' ? 604800000 : 2592000000
    return base - n * ms
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

/** Collapse a scraped description to something worth sending to a model. */
export function condenseDescription(text: string, maxChars = 6000): string {
  const cleaned = String(text ?? '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  if (cleaned.length <= maxChars) return cleaned
  // Keep the head (role summary) and the tail (requirements) -- the middle of a
  // long posting is usually boilerplate about the company.
  const head = cleaned.slice(0, Math.floor(maxChars * 0.65))
  const tail = cleaned.slice(-Math.floor(maxChars * 0.3))
  return `${head}\n\n[...]\n\n${tail}`
}

/** Simple templating for user-editable prompt and filename patterns. */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return String(template ?? '').replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key]
    return v === undefined || v === null ? '' : String(v)
  })
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 120)
}
