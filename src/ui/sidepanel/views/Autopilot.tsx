/**
 * The one-button path to an agent that is actually applying.
 *
 * Everything behind this button could be done by hand across four settings
 * screens, which is exactly why it exists: each of those screens was somewhere
 * to get stuck. It verifies company boards, builds searches from them, switches
 * off sources that cannot be submitted through, sets thresholds that clear, and
 * starts the run.
 *
 * It says plainly that it will submit without asking, because it will.
 */

import { useState } from 'react'
import { api, useAction, type AutopilotResult } from '../../shared/api'

export default function Autopilot({ onDone }: { onDone: () => void }) {
  const { run, busy, error } = useAction()
  const [result, setResult] = useState<AutopilotResult | null>(null)

  const go = () =>
    run(async () => {
      setResult(null)
      const outcome = await api.autopilot()
      setResult(outcome)
      onDone()
    }, 'autopilot')

  const working = busy === 'autopilot'

  if (result) {
    return (
      <div className="mb-3 rounded-md px-3 py-2.5" style={{ background: 'var(--good-soft)' }}>
        <p className="text-[12.5px] font-medium" style={{ color: 'var(--good)' }}>
          Running. It will keep applying on its own.
        </p>
        <ul className="mt-1.5 flex flex-col gap-0.5 text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>
          <li>
            {result.boardsLive} of {result.boardsChecked} company boards are live and being watched
          </li>
          {result.searches.map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>
            Submitting anything scoring {result.settings.minMatchScore} or above, up to {result.settings.dailyCap} a day
          </li>
          {result.removed.length > 0 && <li>Switched off (cannot submit there): {result.removed.join(', ')}</li>}
          {result.problems.map((p) => (
            <li key={p} style={{ color: 'var(--warn)' }}>
              {p}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <div className="mb-3 surface px-3 py-3" style={{ borderColor: 'var(--accent)' }}>
      <p className="text-[13px] font-semibold">Apply for me</p>
      <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>
        Verifies company boards, builds your searches, and runs unattended — submitting real applications without
        asking each time. Roughly a minute to set up.
      </p>

      <button className="btn btn-primary mt-2 w-full" disabled={working} onClick={go}>
        {working ? 'Setting up and starting…' : 'Start applying'}
      </button>

      {working && (
        <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
          Checking boards and asking the model what suits you. Watch the status above.
        </p>
      )}

      {error && (
        <p className="mt-2 text-[11.5px]" style={{ color: 'var(--bad)' }}>
          {error}
        </p>
      )}
    </div>
  )
}
