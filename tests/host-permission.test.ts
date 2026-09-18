/**
 * Regression test for the failure that broke every application at once.
 *
 * The extension only declares host permissions for the big ATSes. A real job
 * hunt lands on `careers.company.com`, an Ashby board behind a custom domain, a
 * Workday tenant nobody has seen before -- and on those Chrome runs no declared
 * content script and refuses every programmatic injection. The only symptom was
 * "Could not establish connection. Receiving end does not exist." after
 * twenty-five seconds of silence, repeated once per job for the whole queue,
 * which reads like a broken content script rather than a permission the user
 * can grant in one click.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureContentScript, hasHostAccess, injectFiles, originPattern, PermissionError } from '@/shared/injection'

let grantedOrigins: string[]
let executeScript: ReturnType<typeof vi.fn>
let sendMessage: ReturnType<typeof vi.fn>

function installFakeChrome(): void {
  grantedOrigins = ['https://boards.greenhouse.io/*']
  executeScript = vi.fn(async () => {
    throw new Error('Cannot access contents of the page at "https://careers.example.com/x".')
  })
  sendMessage = vi.fn(async () => {
    throw new Error('Could not establish connection. Receiving end does not exist.')
  })

  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { getManifest: () => ({ content_scripts: [] }) },
    permissions: {
      contains: vi.fn(async ({ origins }: { origins: string[] }) =>
        origins.every((o) => grantedOrigins.includes(o))
      ),
    },
    tabs: {
      get: vi.fn(async () => ({ id: 7, status: 'complete', url: 'https://careers.example.com/jobs/1' })),
      sendMessage,
    },
    scripting: { executeScript },
  }
}

beforeEach(installFakeChrome)
afterEach(() => vi.restoreAllMocks())

describe('originPattern', () => {
  it('reduces a job URL to the pattern Chrome actually grants', () => {
    expect(originPattern('https://jobs.ashbyhq.com/acme/1234?utm=x')).toBe('https://jobs.ashbyhq.com/*')
    expect(originPattern('https://careers.example.com/a/b/c#frag')).toBe('https://careers.example.com/*')
  })
})

describe('hasHostAccess', () => {
  it('is true for a granted origin and false for one that is not', async () => {
    expect(await hasHostAccess('https://boards.greenhouse.io/acme/jobs/1')).toBe(true)
    expect(await hasHostAccess('https://careers.example.com/jobs/1')).toBe(false)
  })

  it('does not block when the question itself cannot be answered', async () => {
    // A runtime with no permissions API, or an unparseable URL, is not evidence
    // of a denial -- inventing one would produce an error the user cannot act
    // on, in place of the real failure.
    ;(globalThis as unknown as { chrome: { permissions: unknown } }).chrome.permissions = undefined
    expect(await hasHostAccess('https://careers.example.com/jobs/1')).toBe(true)
  })

  it('does not claim a denial for a non-http page', async () => {
    expect(await hasHostAccess('chrome://extensions')).toBe(true)
  })
})

describe('injectFiles', () => {
  it("reports why it failed rather than a bare false", async () => {
    // The old signature returned false for a missing permission and for a tab
    // that had navigated away, so the one the user could fix was unreadable.
    const result = await injectFiles(7, ['assets/form-agent.js'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/Cannot access contents/)
  })

  it('reports an empty manifest rather than pretending it injected', async () => {
    const result = await injectFiles(7, [])
    expect(result.ok).toBe(false)
  })
})

describe('ensureContentScript on a site the extension was not granted', () => {
  it('fails immediately with the grant the user has to make', async () => {
    const started = Date.now()
    await expect(
      ensureContentScript(7, ['assets/form-agent.js'], { type: 'form:ping' }, { timeoutMs: 20000 })
    ).rejects.toBeInstanceOf(PermissionError)
    // Waiting out the full timeout taught the user nothing; no injection can
    // ever succeed without the permission, so there is nothing to wait for.
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('names the origin, so the error says which site to grant', async () => {
    const error = (await ensureContentScript(7, ['a.js'], { type: 'form:ping' }, { timeoutMs: 20000 }).catch(
      (e) => e
    )) as PermissionError
    expect(error.origin).toBe('https://careers.example.com/*')
    expect(error.message).toContain('https://careers.example.com/*')
    expect(error.message).toMatch(/Site access/i)
  })

  it('does not waste injection attempts on a page it cannot touch', async () => {
    await ensureContentScript(7, ['a.js'], { type: 'form:ping' }, { timeoutMs: 20000 }).catch(() => {})
    expect(executeScript).not.toHaveBeenCalled()
  })

  it('carries the injection failure into the message when access is not the problem', async () => {
    grantedOrigins = ['https://careers.example.com/*']
    const error = (await ensureContentScript(7, ['a.js'], { type: 'form:ping' }, { timeoutMs: 1200 }).catch(
      (e) => e
    )) as Error
    expect(error).not.toBeInstanceOf(PermissionError)
    expect(error.message).toMatch(/injection failed: Cannot access contents/)
  })
})
