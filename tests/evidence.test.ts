/**
 * Evidence is a debugging aid that holds page content from sites the user was
 * signed in to, so its limits are part of its contract: bounded in number,
 * bounded in age, and never able to fail an application by existing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { allEvidence, clearEvidence, formatEvidence, MAX_AGE_MS, MAX_ENTRIES, recordEvidence } from '@/storage/evidence'
import type { PageOutline } from '@/form/outline'

function installFakeStorage(): void {
  let store: Record<string, unknown> = {}
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          store = { ...store, ...items }
        }),
        remove: vi.fn(async (key: string) => {
          const { [key]: _drop, ...rest } = store
          store = rest
        }),
      },
    },
  }
}

function outline(overrides: Partial<PageOutline> = {}): PageOutline {
  return {
    url: 'https://careers.example.com/jobs/1',
    title: 'Senior Engineer',
    headings: ['Senior Engineer'],
    elements: [
      { ref: 1, role: 'button', text: 'Save job', selector: '#save' },
      { ref: 2, role: 'button', text: 'Sign in to apply', selector: '#signin', disabled: true },
    ],
    text: 'You must sign in to apply for this role.',
    truncated: false,
    ...overrides,
  }
}

const entry = {
  jobId: 'job-1',
  applicationId: 'app-1',
  stage: 'detect',
  reason: 'no application form found on this page',
}

beforeEach(installFakeStorage)

describe('recordEvidence', () => {
  it('keeps what was on the page, not just the reason', async () => {
    await recordEvidence({ ...entry, outline: outline() })
    const [kept] = await allEvidence()
    expect(kept.reason).toContain('no application form')
    // The whole point: the controls that WERE there are what tells a stale
    // selector from a login wall from an expired listing.
    expect(kept.controls.map((c) => c.text)).toEqual(['Save job', 'Sign in to apply'])
    expect(kept.controls[1].disabled).toBe(true)
  })

  it('records nothing when the page could not be read', async () => {
    await recordEvidence({ ...entry, outline: null })
    expect(await allEvidence()).toHaveLength(0)
  })

  it('keeps the newest first', async () => {
    await recordEvidence({ ...entry, reason: 'first', outline: outline() })
    await recordEvidence({ ...entry, reason: 'second', outline: outline() })
    expect((await allEvidence())[0].reason).toBe('second')
  })

  it('is bounded, so a bad night cannot fill the user storage', async () => {
    for (let i = 0; i < MAX_ENTRIES + 10; i++) {
      await recordEvidence({ ...entry, reason: `failure ${i}`, outline: outline() })
    }
    expect(await allEvidence()).toHaveLength(MAX_ENTRIES)
  })

  it('drops entries older than the retention window', async () => {
    await recordEvidence({ ...entry, reason: 'old', outline: outline() })

    const stale = (await allEvidence()).map((e) => ({ ...e, at: Date.now() - MAX_AGE_MS - 1000 }))
    await chrome.storage.local.set({ 'evidence:failures': stale })

    await recordEvidence({ ...entry, reason: 'new', outline: outline() })
    const kept = await allEvidence()
    expect(kept).toHaveLength(1)
    expect(kept[0].reason).toBe('new')
  })

  it('never throws, because evidence is not worth failing an application over', async () => {
    ;(globalThis as unknown as { chrome: { storage: unknown } }).chrome.storage = undefined
    await expect(recordEvidence({ ...entry, outline: outline() })).resolves.toBeUndefined()
  })
})

describe('formatEvidence', () => {
  it('produces something a person can paste into a bug report', async () => {
    await recordEvidence({ ...entry, outline: outline() })
    const text = formatEvidence((await allEvidence())[0])

    // Everything needed to write the selector that fixes it.
    expect(text).toContain('Stage: detect')
    expect(text).toContain('https://careers.example.com/jobs/1')
    expect(text).toContain('"Save job"  ->  #save')
    expect(text).toContain('(disabled)')
    expect(text).toContain('You must sign in to apply')
  })
})

describe('clearEvidence', () => {
  it('removes everything', async () => {
    await recordEvidence({ ...entry, outline: outline() })
    await clearEvidence()
    expect(await allEvidence()).toHaveLength(0)
  })
})
