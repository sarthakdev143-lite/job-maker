/**
 * Granting the extension access to the sites it applies on.
 *
 * Chrome gives an extension nothing it did not declare. The manifest lists the
 * big ATSes, but a real job hunt lands on `careers.company.com`, an Ashby board
 * behind a custom domain, a Workday tenant nobody has seen before. On those the
 * page script never runs, every programmatic injection is refused, and the only
 * symptom is "Could not establish connection. Receiving end does not exist." on
 * every application in the queue.
 *
 * `optional_host_permissions` has always been in the manifest; what was missing
 * was anything that asked for it. `chrome.permissions.request` only works from
 * a real user gesture on an extension page, which is exactly this button.
 */

import { useCallback, useEffect, useState } from 'react'
import { Section } from '../../shared/components'

const ALL_SITES = { origins: ['https://*/*'] } as const

export default function SiteAccessSection() {
  const [granted, setGranted] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const refresh = useCallback(async () => {
    try {
      setGranted(await chrome.permissions.contains({ origins: [...ALL_SITES.origins] }))
    } catch {
      setGranted(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Also on focus, because the grant can be revoked from chrome://extensions
    // in another tab and a stale "all job sites" badge is worse than none.
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const request = () => {
    setBusy(true)
    setNote('')
    // Deliberately not awaited through a helper: the call has to happen inside
    // the click handler's synchronous run or Chrome discards the gesture and
    // rejects with "may only be called from a user gesture".
    chrome.permissions.request({ origins: [...ALL_SITES.origins] }, (ok) => {
      setBusy(false)
      setNote(
        ok
          ? 'Granted. Applications on company-hosted forms will work from the next run.'
          : 'Declined. The agent stays limited to the built-in job boards.'
      )
      void refresh()
    })
  }

  return (
    <Section
      title="Site access"
      description="Which sites the agent is allowed to read and fill. Without this it can only apply on the boards baked into the extension."
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="rounded-full px-2 py-0.5 text-[11.5px] font-medium"
          style={{
            background: granted ? 'var(--good-soft)' : 'var(--warn-soft)',
            color: granted ? 'var(--good)' : 'var(--warn)',
          }}
        >
          {granted === null ? 'unknown' : granted ? 'all job sites' : 'built-in boards only'}
        </span>
        {!granted && (
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={request}>
            {busy ? 'Waiting for Chrome…' : 'Grant access to job sites'}
          </button>
        )}
        {granted && (
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              chrome.permissions.remove({ origins: [...ALL_SITES.origins] }, () => {
                setBusy(false)
                setNote('Revoked.')
                void refresh()
              })
            }}
          >
            Revoke
          </button>
        )}
      </div>

      {note && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--ink-soft)' }}>
          {note}
        </p>
      )}

      {!granted && (
        <p className="hint mt-2">
          Chrome will show its own confirmation. Applications that fail with{' '}
          <em>no access to …</em> are this, not a broken form — the extension is refused before it
          can read the page at all.
        </p>
      )}
    </Section>
  )
}
