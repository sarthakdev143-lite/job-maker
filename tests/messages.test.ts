/**
 * "A listener indicated an asynchronous response by returning true, but the
 * message channel closed before a response was received."
 *
 * That is Chrome's own wording for a service worker torn down mid-request --
 * normally because the request outlived the ~30s MV3 idle window and got
 * evicted along with the message port. It surfaces to `chrome.runtime.
 * sendMessage` as a rejection, not as a `{ok:false}` reply, so `sendToWorker`
 * has to catch it specifically and explain it rather than showing Chrome's
 * internal wording verbatim.
 */

import { describe, expect, it } from 'vitest'
import { explainWorkerError } from '@/shared/messages'

describe('explainWorkerError', () => {
  it('explains a stale worker build', () => {
    expect(explainWorkerError('Unhandled request: {"type":"ui:foo"} (background worker build 1)')).toMatch(
      /reload/i
    )
  })

  it('explains a message channel torn down mid-request, rather than repeating Chrome wording', () => {
    const chromeWording =
      'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'
    const explained = explainWorkerError(chromeWording)
    expect(explained).toMatch(/restarted before it finished/i)
    expect(explained).toMatch(/log/i)
  })

  it('explains a port closed early and a lost connection the same way', () => {
    expect(explainWorkerError('The message port closed before a response was received.')).toMatch(
      /restarted before it finished/i
    )
    expect(explainWorkerError('Could not establish connection. Receiving end does not exist.')).toMatch(
      /restarted before it finished/i
    )
  })

  it('passes an ordinary application error straight through', () => {
    expect(explainWorkerError('Job has no application URL')).toBe('Job has no application URL')
  })
})
