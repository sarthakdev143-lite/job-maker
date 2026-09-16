/**
 * Telling a Cloudflare challenge that is still settling from one that has stopped.
 *
 * This is a regression test for a bug that made Indeed discovery useless. The
 * first version treated "Just a moment..." -- Cloudflare's transient
 * interstitial, which clears itself in a few seconds -- as a hard block. The
 * caller closed the window immediately, moved to the next of forty-eight search
 * URLs, and did the same again. The user watched windows open and close in a
 * loop while nothing was ever discovered, and the hammering is itself what
 * escalated a soft check into a real one.
 *
 * The rule: only a challenge a person must act on counts as 'hard'. Anything
 * still in progress is 'transient' and must be waited out.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { classifyBlockPage } from '@/discovery/sources/indeed'

/** classifyBlockPage reads the ambient document, as it does when injected. */
function render(html: string): void {
  document.body.innerHTML = html
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('classifyBlockPage', () => {
  it('treats the "Just a moment" interstitial as transient, not a block', () => {
    render('<h1>Just a moment...</h1><p>Checking your browser before accessing indeed.com</p>')
    expect(classifyBlockPage()).toBe('transient')
  })

  it('treats a running challenge form as transient', () => {
    render('<div id="challenge-running">Verifying...</div>')
    expect(classifyBlockPage()).toBe('transient')
  })

  it('treats an interactive human check as hard', () => {
    render('<h1>Verify you are human</h1>')
    expect(classifyBlockPage()).toBe('hard')
  })

  it.each([
    'Please verify you are human',
    'Are you a robot?',
    'We have detected unusual traffic from your network',
    'Access denied',
  ])('treats %j as hard', (text) => {
    render(`<p>${text}</p>`)
    expect(classifyBlockPage()).toBe('hard')
  })

  it('treats an embedded Cloudflare challenge frame as hard', () => {
    render('<iframe src="https://challenges.cloudflare.com/turnstile"></iframe>')
    expect(classifyBlockPage()).toBe('hard')
  })

  it('reports a normal results page as clear', () => {
    render('<div class="job_seen_beacon"><h2>Senior Engineer</h2></div>')
    expect(classifyBlockPage()).toBe('none')
  })

  it('reports the newer card layout as clear', () => {
    render('<div class="cardOutline"><h2>Backend Engineer</h2></div>')
    expect(classifyBlockPage()).toBe('none')
  })

  it('treats a genuinely empty result set as clear, not as a block', () => {
    // "No jobs today" is a normal outcome and must not read as a challenge,
    // or the agent would back off for an hour over an ordinary empty search.
    render('<main><p>No jobs found matching your search.</p></main>')
    expect(classifyBlockPage()).toBe('none')
  })

  it('prefers the hard verdict when a page carries both signals', () => {
    // A challenge page that also mentions checking your browser must not be
    // mistaken for one that is about to clear.
    render('<p>Checking your browser</p><p>Verify you are human</p>')
    expect(classifyBlockPage()).toBe('hard')
  })
})
