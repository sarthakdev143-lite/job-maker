/**
 * Learning a selector is only half of it; forgetting one matters as much.
 *
 * A remembered selector that has gone stale is worse than no memory at all: it
 * is tried first, it fails silently, and the site looks broken for ever. So the
 * ageing-out behaviour is tested as carefully as the learning.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  allSiteMemory,
  clearSiteMemory,
  hostKey,
  learnApplyEntry,
  MAX_CONSECUTIVE_MISSES,
  missApplyEntry,
  rememberedApplyEntry,
} from '@/storage/site-memory'

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

const JOB = 'https://careers.example.com/jobs/senior-engineer'

beforeEach(installFakeStorage)

describe('hostKey', () => {
  it('reduces a job URL to the host the memory is keyed by', () => {
    expect(hostKey(JOB)).toBe('careers.example.com')
    expect(hostKey('HTTPS://Careers.Example.COM/x')).toBe('careers.example.com')
  })

  it('returns nothing for something that is not a URL', () => {
    expect(hostKey('not a url')).toBe('')
  })
})

describe('learning', () => {
  it('remembers a selector and offers it back for the same host', async () => {
    await learnApplyEntry(JOB, '#apply', 'Apply now')
    expect(await rememberedApplyEntry('https://careers.example.com/jobs/other')).toBe('#apply')
  })

  it('does not offer it for a different host', async () => {
    await learnApplyEntry(JOB, '#apply', 'Apply now')
    expect(await rememberedApplyEntry('https://jobs.other.com/1')).toBe('')
  })

  it('counts repeat successes rather than starting over', async () => {
    await learnApplyEntry(JOB, '#apply', 'Apply now')
    await learnApplyEntry(JOB, '#apply', 'Apply now')
    const [row] = await allSiteMemory()
    expect(row.applyEntry?.hits).toBe(2)
  })

  it('replaces the memory when the site moves its button', async () => {
    await learnApplyEntry(JOB, '#apply', 'Apply now')
    await learnApplyEntry(JOB, '#apply-v2', 'Apply')
    const [row] = await allSiteMemory()
    expect(row.applyEntry?.selector).toBe('#apply-v2')
    expect(row.applyEntry?.hits).toBe(1)
  })

  it('ignores an empty selector rather than remembering nothing', async () => {
    await learnApplyEntry(JOB, '', 'Apply now')
    expect(await allSiteMemory()).toHaveLength(0)
  })
})

describe('forgetting', () => {
  it('keeps offering a selector while it is only occasionally missing', async () => {
    await learnApplyEntry(JOB, '#apply', 'Apply now')
    await missApplyEntry(JOB)
    expect(await rememberedApplyEntry(JOB)).toBe('#apply')
  })

  it('stops offering it once it has missed too many times running', async () => {
    await learnApplyEntry(JOB, '#apply', 'Apply now')
    for (let i = 0; i < MAX_CONSECUTIVE_MISSES; i++) await missApplyEntry(JOB)
    // Without this, one bad memory is a permanent outage on that site.
    expect(await rememberedApplyEntry(JOB)).toBe('')
  })

  it('forgives the misses as soon as it works again', async () => {
    await learnApplyEntry(JOB, '#apply', 'Apply now')
    await missApplyEntry(JOB)
    await missApplyEntry(JOB)
    await learnApplyEntry(JOB, '#apply', 'Apply now')
    const [row] = await allSiteMemory()
    expect(row.applyEntry?.misses).toBe(0)
  })

  it('does nothing when there is nothing remembered to miss', async () => {
    await expect(missApplyEntry(JOB)).resolves.toBeUndefined()
  })
})

describe('clearing', () => {
  it('empties everything', async () => {
    await learnApplyEntry(JOB, '#apply', 'Apply now')
    await clearSiteMemory()
    expect(await allSiteMemory()).toHaveLength(0)
  })
})

describe('when storage is unavailable', () => {
  it('degrades to no memory rather than failing an application', async () => {
    ;(globalThis as unknown as { chrome: { storage: unknown } }).chrome.storage = undefined
    expect(await rememberedApplyEntry(JOB)).toBe('')
    await expect(learnApplyEntry(JOB, '#apply', 'Apply')).resolves.toBeUndefined()
  })
})
