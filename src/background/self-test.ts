/**
 * The extension checking itself.
 *
 * There are four hundred unit tests in this repository and not one of them
 * caught a single thing that actually went wrong: a host permission Chrome had
 * never granted, an alarm that restarted a run five minutes after the kill
 * switch, a cycle that searched before it applied, a model call with no time
 * limit. Every one of those is an *environment* failure, and a unit test runs
 * in an environment where none of them can exist.
 *
 * So this runs in the real one. It asks the questions a person would have to
 * ask by hand -- is the build the one I just loaded? can Chrome reach the sites?
 * does the model actually return JSON? does a real job page still parse? -- and
 * writes the answers down in a form that can be pasted somewhere useful.
 *
 * Three rules it never breaks:
 *
 *   1. Nothing is submitted. The page probe stops before the first keystroke.
 *   2. Nothing is changed. No settings are written, no jobs are re-queued.
 *   3. It says what it could not check, rather than passing by omission. A
 *      check that silently skips is worse than no check, because it reads as
 *      a green light.
 */

import { BUILD_ID } from '@/shared/build'
import { createLogger } from '@/shared/logger'
import { activity } from '@/shared/activity'
import { llm } from '@/llm/broker'
import { LlmError } from '@/llm/driver'
import { formAgentFiles } from '@/shared/injection'
import { getProfile, getRecipes, profileIsUsable } from '@/storage/settings'
import { jobsRepo } from '@/storage/db'
import { probeJobPage, type PageProbe } from '@/runner/apply-machine'
import { allSiteMemory } from '@/storage/site-memory'
import { getRecipeHealth } from './run-history'
import { isHalted } from './run-state'
import { z } from 'zod'

const log = createLogger('self-test')

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip'

export type SelfTestCheck = {
  id: string
  name: string
  status: CheckStatus
  /** What was found, in the words a person would use. */
  detail: string
  /** What to do about it. Only present when something is wrong. */
  fix?: string
  elapsedMs?: number
}

export type SelfTestReport = {
  startedAt: number
  elapsedMs: number
  build: string
  checks: SelfTestCheck[]
  probes: PageProbe[]
  summary: { pass: number; fail: number; warn: number; skip: number }
}

export type SelfTestOptions = {
  /** Include the live page probe, which opens real tabs. Slower. */
  probePages?: boolean
  /** How many queued jobs to probe. */
  probeCount?: number
  /** Probe this URL instead of picking from the queue. */
  probeUrl?: string
}

/* ------------------------------------------------------------- the checks */

async function checkBuild(): Promise<SelfTestCheck> {
  const manifest = chrome.runtime.getManifest()
  return {
    id: 'build',
    name: 'Which build is loaded',
    status: 'pass',
    // Not a pass/fail on its own -- it is the first thing to read when a fix
    // "did not work", because more often than not the extension was not
    // reloaded and the old code is still running.
    detail: `${manifest.version_name ?? manifest.version} (bundle ${BUILD_ID}). If this is not the build you just made, Chrome is still running the old one.`,
  }
}

async function checkSiteAccess(): Promise<SelfTestCheck> {
  const all = await chrome.permissions.contains({ origins: ['https://*/*'] }).catch(() => false)
  if (all) {
    return { id: 'siteAccess', name: 'Chrome lets it read job sites', status: 'pass', detail: 'Granted for all sites' }
  }
  return {
    id: 'siteAccess',
    name: 'Chrome lets it read job sites',
    status: 'warn',
    detail: 'Only the job boards named in the manifest. Any application on a company-hosted form will fail before it can read the page.',
    fix: 'Settings -> Advanced -> Site access -> Grant access to job sites',
  }
}

async function checkContentScript(): Promise<SelfTestCheck> {
  const files = formAgentFiles()
  if (files.length > 0) {
    return {
      id: 'contentScript',
      name: 'The page agent exists in this build',
      status: 'pass',
      detail: files.join(', '),
    }
  }
  return {
    id: 'contentScript',
    name: 'The page agent exists in this build',
    status: 'fail',
    detail: 'The manifest lists no content script for job pages, so nothing can be injected into any form.',
    fix: 'Rebuild the extension; this is a packaging failure, not a setting.',
  }
}

async function checkAlarms(): Promise<SelfTestCheck> {
  const alarms = await chrome.alarms.getAll().catch(() => [])
  const names = alarms.map((a) => a.name)
  const hasCycle = names.some((n) => n.includes('cycle'))

  if (!hasCycle) {
    return {
      id: 'alarms',
      name: 'The scheduled wake-up is registered',
      status: 'warn',
      detail: 'No cycle alarm. The agent will only run while a page holds the service worker awake, and will not resume after Chrome evicts it.',
      fix: 'Reload the extension, which re-registers it.',
    }
  }
  return {
    id: 'alarms',
    name: 'The scheduled wake-up is registered',
    status: 'pass',
    detail: `${alarms.length} alarm(s): ${names.join(', ')}`,
  }
}

async function checkStorage(): Promise<SelfTestCheck> {
  const probeKey = 'selftest:probe'
  try {
    const value = Date.now()
    await chrome.storage.local.set({ [probeKey]: value })
    const back = await chrome.storage.local.get(probeKey)
    await chrome.storage.local.remove(probeKey)
    if (back?.[probeKey] !== value) throw new Error('read back a different value')

    const used = await chrome.storage.local.getBytesInUse?.(null).catch(() => 0)
    return {
      id: 'storage',
      name: 'Storage can be written and read back',
      status: 'pass',
      detail: used ? `${(used / 1024 / 1024).toFixed(1)} MB in use` : 'round-trip ok',
    }
  } catch (e) {
    return {
      id: 'storage',
      name: 'Storage can be written and read back',
      status: 'fail',
      detail: (e as Error).message,
      fix: 'Chrome is refusing to store data. Check the profile is not out of disk, and that site data is not blocked.',
    }
  }
}

async function checkHalted(): Promise<SelfTestCheck> {
  const halted = await isHalted()
  if (!halted) {
    return { id: 'halted', name: 'Not held down by the kill switch', status: 'pass', detail: 'Free to run' }
  }
  return {
    id: 'halted',
    name: 'Not held down by the kill switch',
    status: 'warn',
    // A deliberately sticky flag, so a user who forgot they pressed Stop sees
    // why nothing is happening instead of concluding the agent is broken.
    detail: 'Stop was pressed and Start has not been pressed since. Scheduled runs will not start.',
    fix: 'Press Start in the side panel.',
  }
}

async function checkProfile(): Promise<SelfTestCheck> {
  const profile = await getProfile()
  const usable = profileIsUsable(profile)
  if (usable.ok) {
    return {
      id: 'profile',
      name: 'The profile is complete enough to apply',
      status: 'pass',
      detail: `${profile.firstName} ${profile.lastName}`.trim() || 'filled in',
    }
  }
  return {
    id: 'profile',
    name: 'The profile is complete enough to apply',
    status: 'fail',
    detail: `Missing ${usable.missing.join(', ')}`,
    fix: 'Settings -> Profile',
  }
}

async function checkSearches(): Promise<SelfTestCheck> {
  const recipes = await getRecipes()
  const on = recipes.filter((r) => r.enabled)
  const queued = await jobsRepo.byStatus('queued', 200)

  if (on.length === 0 && queued.length === 0) {
    return {
      id: 'searches',
      name: 'There is work to do',
      status: 'fail',
      detail: 'No searches switched on and nothing queued.',
      fix: 'Settings -> Searches -> Set up searches',
    }
  }
  return {
    id: 'searches',
    name: 'There is work to do',
    status: 'pass',
    detail: `${on.length} search(es) on, ${queued.length} job(s) queued`,
  }
}

/**
 * The model check that matters: does it hold the JSON contract?
 *
 * Every real call in this extension is `completeStructured`. A model that
 * answers prose is not slow or degraded here, it is unusable -- it produces
 * empty profiles and empty answers with no error at all, which is exactly what
 * an empty resume parse looked like. Reachability alone proves nothing, so this
 * asks for a structured answer and checks the shape that comes back.
 */
const ContractSchema = z.object({
  answer: z.string().default(''),
  count: z.number().default(0),
})

/**
 * Did the last search actually produce anything to apply to?
 *
 * The failure this exists for is silent by construction: every board answers,
 * the log fills with "Greenhouse board X: 40 posting(s)", and the queue stays
 * empty because something downstream is discarding all of it. That happened for
 * a whole night's run -- keywords arriving from the model as phrases were being
 * matched against titles as literal substrings, so 2,600 fetched postings
 * became zero candidates and the agent looked like it had found a dead market.
 *
 * Fetching plenty and keeping none is the signature, so that is what this
 * looks for.
 */
async function checkSearchYield(): Promise<SelfTestCheck> {
  const health = await getRecipeHealth()
  const runs = Object.values(health).filter((h) => h.lastRunAt)

  if (runs.length === 0) {
    return {
      id: 'search-yield',
      name: 'The searches find jobs worth looking at',
      status: 'skip',
      detail: 'No search has run yet',
    }
  }

  const fetched = runs.reduce((n, h) => n + h.lastFetched, 0)
  const stored = runs.reduce((n, h) => n + h.lastStored, 0)
  const failing = runs.filter((h) => h.lastError).length

  if (fetched === 0) {
    return {
      id: 'search-yield',
      name: 'The searches find jobs worth looking at',
      status: failing > 0 ? 'fail' : 'warn',
      detail:
        failing > 0
          ? `${failing} search(es) errored and nothing was fetched`
          : 'The last run fetched nothing at all. Check the boards in Settings -> Searches.',
    }
  }

  if (stored === 0) {
    return {
      id: 'search-yield',
      name: 'The searches find jobs worth looking at',
      status: 'fail',
      detail:
        `Fetched ${fetched} posting(s) and kept none. That is a filter discarding everything ` +
        'rather than an empty market: check Jobs -> Filtered out, which counts the reasons.',
    }
  }

  return {
    id: 'search-yield',
    name: 'The searches find jobs worth looking at',
    status: 'pass',
    detail: `Last run: ${fetched} fetched, ${stored} kept`,
  }
}

async function checkModelContract(): Promise<SelfTestCheck> {
  const startedAt = Date.now()
  try {
    const result = await llm.completeStructured(
      {
        prompt:
          'Reply with the word "ready" and the number 3.\n' +
          'Use exactly these keys: answer (the word), count (the number).',
        schema: ContractSchema,
        freshContext: true,
        timeoutMs: 60000,
      },
      'self-test: JSON contract'
    )
    const elapsedMs = Date.now() - startedAt

    if (!result.answer && !result.count) {
      // Every field in the schema has a default, so an empty object validates.
      // This is the exact shape of the bug that made resumes parse to nothing.
      return {
        id: 'modelContract',
        name: 'The model returns usable JSON',
        status: 'fail',
        detail: `Answered in ${(elapsedMs / 1000).toFixed(1)}s but every field came back empty, which means it did not return the object at all.`,
        fix: 'Settings -> Model. Pick an instruction-tuned model; base and diffusion checkpoints cannot hold this contract.',
        elapsedMs,
      }
    }

    return {
      id: 'modelContract',
      name: 'The model returns usable JSON',
      status: elapsedMs > 30000 ? 'warn' : 'pass',
      detail:
        elapsedMs > 30000
          ? `Answered correctly, but took ${(elapsedMs / 1000).toFixed(1)}s. At that speed one application can take many minutes.`
          : `Answered correctly in ${(elapsedMs / 1000).toFixed(1)}s`,
      elapsedMs,
    }
  } catch (e) {
    return {
      id: 'modelContract',
      name: 'The model returns usable JSON',
      status: 'fail',
      detail: (e as Error).message,
      // The advice has to match the cause. An expired browser session and a
      // wrong model id both surface here, and sending someone to check their
      // model id when what actually happened is that their chat session lapsed
      // overnight costs them the time it takes to rule that out.
      fix: fixForModelFailure(e),
      elapsedMs: Date.now() - startedAt,
    }
  }
}

/** Where to send someone, given why the model would not answer. */
function fixForModelFailure(e: unknown): string {
  const code = e instanceof LlmError ? e.code : ''
  switch (code) {
    case 'not_logged_in':
      return 'Open the provider in a tab and sign in again. Browser sessions lapse on their own, and nothing else here is wrong.'
    case 'not_ready':
      return 'The provider tab is open but not answering yet. Give it a moment and run this again.'
    case 'timeout':
      return 'The model did not answer in time. A smaller or faster model in Settings -> Model will make every application quicker.'
    case 'config':
      return 'Settings -> Model. No model is configured yet.'
    default:
      return 'Settings -> Model. Check the key, the model id, and that the model is instruction-tuned.'
  }
}

async function checkLearned(): Promise<SelfTestCheck> {
  const sites = (await allSiteMemory()).filter((s) => s.applyEntry)
  const rotting = sites.filter((s) => (s.applyEntry?.misses ?? 0) > 0)

  if (sites.length === 0) {
    return {
      id: 'learned',
      name: 'What it has taught itself',
      status: 'skip',
      detail: 'Nothing learned yet. This fills in once the built-in selectors miss and the model finds a control instead.',
    }
  }
  return {
    id: 'learned',
    name: 'What it has taught itself',
    status: rotting.length > 0 ? 'warn' : 'pass',
    detail:
      rotting.length > 0
        ? `${sites.length} site(s) learned, ${rotting.length} now missing: ${rotting.map((s) => s.host).join(', ')}`
        : `${sites.length} site(s) learned and still working`,
  }
}

/* -------------------------------------------------------------- the probe */

/**
 * Open real job pages and walk them without touching anything.
 *
 * The expensive check and the only one that can fail for a reason nobody has
 * thought of yet. Everything above tests a condition somebody already knew to
 * look for; this one just tries it and reports what happened.
 */
async function runProbes(options: SelfTestOptions): Promise<PageProbe[]> {
  if (options.probeUrl) return [await probeJobPage(options.probeUrl)]

  const count = Math.max(1, Math.min(options.probeCount ?? 3, 10))
  const queued = await jobsRepo.byStatus('queued', count * 3)
  const urls = queued
    .map((j) => j.applyUrl || j.url)
    .filter(Boolean)
    .slice(0, count)

  const probes: PageProbe[] = []
  for (const [index, url] of urls.entries()) {
    activity.relabel(`Self-test: reading page ${index + 1} of ${urls.length}`)
    probes.push(await probeJobPage(url))
  }
  return probes
}

/* ------------------------------------------------------------- the runner */

export async function runSelfTest(options: SelfTestOptions = {}): Promise<SelfTestReport> {
  const startedAt = Date.now()
  activity.begin('thinking', 'Self-test: checking the basics', 120_000)
  log.info('Self-test starting')

  const checks: SelfTestCheck[] = []

  // Cheap and local first, so a fundamental problem is reported before the
  // slow checks spend a minute confirming the consequences of it.
  for (const check of [
    checkBuild,
    checkContentScript,
    checkSiteAccess,
    checkAlarms,
    checkStorage,
    checkHalted,
    checkProfile,
    checkSearches,
    checkLearned,
  ]) {
    try {
      checks.push(await check())
    } catch (e) {
      checks.push({
        id: check.name,
        name: check.name,
        status: 'fail',
        detail: `The check itself failed: ${(e as Error).message}`,
      })
    }
  }

  checks.push(await checkSearchYield())

  activity.relabel('Self-test: asking the model for JSON')
  checks.push(await checkModelContract())

  let probes: PageProbe[] = []
  if (options.probePages) {
    activity.relabel('Self-test: reading real job pages')
    try {
      probes = await runProbes(options)
    } catch (e) {
      checks.push({
        id: 'probe',
        name: 'Real job pages still parse',
        status: 'fail',
        detail: `Could not probe any page: ${(e as Error).message}`,
      })
    }

    if (probes.length > 0) {
      const failed = probes.filter((p) => !p.ok)
      checks.push({
        id: 'probe',
        name: 'Real job pages still parse',
        status: failed.length === 0 ? 'pass' : failed.length === probes.length ? 'fail' : 'warn',
        detail:
          failed.length === 0
            ? `${probes.length} page(s) read, all of them usable`
            : `${failed.length} of ${probes.length} page(s) could not be read. See the pages below for what was actually on them.`,
        fix: failed.length > 0 ? 'Copy this report; the page outlines say which selector is missing.' : undefined,
      })
    }
  }

  const summary = {
    pass: checks.filter((c) => c.status === 'pass').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    skip: checks.filter((c) => c.status === 'skip').length,
  }

  const report: SelfTestReport = {
    startedAt,
    elapsedMs: Date.now() - startedAt,
    build: chrome.runtime.getManifest().version_name ?? chrome.runtime.getManifest().version,
    checks,
    probes,
    summary,
  }

  activity.end(
    summary.fail > 0
      ? `Self-test: ${summary.fail} problem(s) found`
      : summary.warn > 0
        ? `Self-test: ${summary.warn} thing(s) worth a look`
        : 'Self-test: everything passed'
  )
  log.info(`Self-test done in ${(report.elapsedMs / 1000).toFixed(1)}s: ${summary.fail} fail, ${summary.warn} warn`)
  return report
}

/* ------------------------------------------------------------ the writeup */

/**
 * The report as text, written to be pasted somewhere.
 *
 * This is the actual deliverable. The point of the whole module is that a user
 * who hits a problem can press one button, copy one block, and hand over
 * something complete enough to act on -- instead of describing symptoms across
 * a dozen messages while the thing that broke is no longer on screen.
 */
export function formatSelfTest(report: SelfTestReport): string {
  const mark: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' }
  const lines: string[] = [
    'AUTOAPPLY SELF-TEST',
    `Build: ${report.build}`,
    `Run at: ${new Date(report.startedAt).toISOString()} (took ${(report.elapsedMs / 1000).toFixed(1)}s)`,
    `Result: ${report.summary.fail} failed, ${report.summary.warn} warnings, ${report.summary.pass} passed, ${report.summary.skip} skipped`,
    '',
    '--- CHECKS ---',
  ]

  for (const c of report.checks) {
    lines.push(`[${mark[c.status]}] ${c.name}`)
    lines.push(`        ${c.detail}`)
    if (c.fix) lines.push(`        FIX: ${c.fix}`)
  }

  if (report.probes.length > 0) {
    lines.push('', '--- PAGES READ ---')
    for (const p of report.probes) {
      lines.push(`[${p.ok ? 'OK' : 'PROBLEM'}] ${p.url}`)
      lines.push(
        `        reached: ${p.reached} | vendor: ${p.vendor || 'unknown'} | form: ${p.isApplicationForm}` +
          ` | apply button found: ${p.applyEntryFound} | fields: ${p.fields}` +
          ` | answered: ${p.resolved} | unanswered: ${p.unresolved} | ${(p.elapsedMs / 1000).toFixed(1)}s`
      )
      if (p.error) lines.push(`        error: ${p.error}`)

      // The outline is the part that makes a failure fixable rather than just
      // reportable: it says what WAS on the page when the selector missed.
      if (p.outline) {
        lines.push(`        page title: ${p.outline.title}`)
        if (p.outline.headings.length > 0) lines.push(`        headings: ${p.outline.headings.join(' | ')}`)
        lines.push('        controls on screen:')
        for (const el of p.outline.elements.slice(0, 40)) {
          lines.push(`          ${el.role}${el.disabled ? ' (disabled)' : ''} "${el.text || '(no label)'}" -> ${el.selector}`)
        }
        if (p.outline.elements.length > 40) {
          lines.push(`          ... and ${p.outline.elements.length - 40} more`)
        }
      }
    }
  }

  return lines.join('\n')
}
