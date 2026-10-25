/**
 * Finding the built content scripts in the live manifest.
 *
 * The bundler emits hashed filenames, so nothing may hard-code a path to an
 * injected script -- these lookups are the only thing that works across a dev
 * server and a packed release alike. Which makes them quiet: when the lookup
 * returns an empty list, injection fails with "no content script files in the
 * manifest" and the symptom the user sees is a driver that cannot find its chat
 * box, not a manifest that is missing an entry.
 *
 * The DeepAI cases matter because DeepSeek used to be the only chat site, so
 * every lookup here used to match on the substring "deepseek". That worked
 * until a second site existed and then quietly stopped finding anything.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { chatBridgeFiles, formAgentFiles, originPattern, hasHostAccess } from '@/shared/injection'

type Script = { matches?: string[]; js?: string[]; world?: string }

function withManifest(scripts: Script[]): void {
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ content_scripts: scripts }) },
  })
}

describe('chatBridgeFiles', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('finds the bridge when only the DeepAI entry is declared', () => {
    withManifest([
      { matches: ['https://deepai.org/*'], js: ['assets/chat-bridge.js'] },
      { matches: ['https://boards.greenhouse.io/*'], js: ['assets/form-agent.js'] },
    ])
    expect(chatBridgeFiles()).toEqual(['assets/chat-bridge.js'])
  })

  it('finds the bridge when only the DeepSeek entry is declared', () => {
    withManifest([{ matches: ['https://chat.deepseek.com/*'], js: ['assets/chat-bridge.js'] }])
    expect(chatBridgeFiles()).toEqual(['assets/chat-bridge.js'])
  })

  it('finds it when both sites share one entry, as the manifest does', () => {
    withManifest([
      { matches: ['https://deepai.org/*', 'https://chat.deepseek.com/*'], js: ['assets/chat-bridge.js'] },
    ])
    expect(chatBridgeFiles()).toEqual(['assets/chat-bridge.js'])
  })

  it('returns nothing rather than the wrong script', () => {
    withManifest([{ matches: ['https://boards.greenhouse.io/*'], js: ['assets/form-agent.js'] }])
    expect(chatBridgeFiles()).toEqual([])
  })

  it('is not fooled by the form agent, which matches job sites instead', () => {
    withManifest([
      { matches: ['https://*.indeed.com/*'], js: ['assets/form-agent.js'] },
      { matches: ['https://deepai.org/*'], js: ['assets/chat-bridge.js'] },
    ])
    expect(chatBridgeFiles()).toEqual(['assets/chat-bridge.js'])
    expect(formAgentFiles()).toEqual(['assets/form-agent.js'])
  })

  it('does not mistake the MAIN-world shim for the agent', () => {
    withManifest([
      { matches: ['https://*.greenhouse.io/*'], js: ['assets/form-agent.js'] },
      { matches: ['https://*.greenhouse.io/*'], js: ['assets/shim.js'], world: 'MAIN' },
    ])
    expect(formAgentFiles()).toEqual(['assets/form-agent.js'])
  })

  it('survives a manifest with no content scripts at all', () => {
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({}) } })
    expect(chatBridgeFiles()).toEqual([])
    expect(formAgentFiles()).toEqual([])
  })
})

describe('originPattern', () => {
  it('reduces a full URL to a grantable origin pattern', () => {
    expect(originPattern('https://deepai.org/chat?x=1')).toBe('https://deepai.org/*')
    expect(originPattern('https://jobs.lever.co/abc/apply')).toBe('https://jobs.lever.co/*')
  })
})

describe('hasHostAccess', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports a granted origin', async () => {
    vi.stubGlobal('chrome', { permissions: { contains: async () => true } })
    await expect(hasHostAccess('https://deepai.org/chat')).resolves.toBe(true)
  })

  it('reports a missing grant, which is the one the user can fix', async () => {
    vi.stubGlobal('chrome', { permissions: { contains: async () => false } })
    await expect(hasHostAccess('https://deepai.org/chat')).resolves.toBe(false)
  })

  it('assumes access when the question itself failed', async () => {
    // Inventing a permission problem the user cannot act on is worse than
    // letting the real failure speak for itself.
    vi.stubGlobal('chrome', {
      permissions: {
        contains: async () => {
          throw new Error('API unavailable')
        },
      },
    })
    await expect(hasHostAccess('https://deepai.org/chat')).resolves.toBe(true)
  })
})
