/**
 * The answer bank.
 *
 * This is the memory that makes the agent cheaper over time: every question it
 * has answered, keyed by normalized text. Editing an entry here changes what it
 * will say next time, everywhere -- which makes this page the fastest way to
 * correct a recurring wrong answer.
 */

import { useState } from 'react'
import { api, useAction, useAsync } from '../../shared/api'
import { Badge, Empty, Field, Section, Spinner, TextInput } from '../../shared/components'
import { formatRelative } from '@/shared/util'

/** Plain English for a resolver tier, since the stored names are internal. */
const TIER_NAMES: Record<string, string> = {
  user: 'your own field mapping',
  adapter: 'the site adapter',
  profile: 'your profile',
  answer_bank: 'this answer bank',
  llm: 'a model call',
  guess: 'a guess',
  default: 'a generated document',
}

/**
 * The questions that keep stopping applications.
 *
 * A parked field is the agent declining to invent an answer, which is right.
 * The same question parking on every application is a different thing, and it
 * is invisible unless someone reads twenty timelines: a live Greenhouse form
 * parked on "Are you legally authorized to work in the country in which this
 * role is located?" every time, because the profile listed no authorized
 * countries. Answering it once here fixes it everywhere, so the question is
 * shown beside the box that answers it.
 */
function Parked({ onTeach }: { onTeach: (label: string) => void }) {
  const { data, loading } = useAsync(() => api.recurringParks(), [])

  if (loading && !data) return <Spinner label="Reading what got left blank" />
  if (!data || data.length === 0) {
    return (
      <Empty
        title="Nothing keeps getting stuck"
        hint="Questions the agent would not answer on its own show up here, with the answer box already pointed at them."
      />
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {data.map((row) => (
        <div key={row.label} className="surface flex items-start gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[12.5px] font-medium">{row.label}</span>
              {row.required && <Badge tone="accent">required</Badge>}
            </div>
            <p className="hint">
              stopped {row.count} application{row.count === 1 ? '' : 's'} · last seen on {row.example.title} at{' '}
              {row.example.company}
            </p>
            {row.options.length > 0 && <p className="hint truncate">choices: {row.options.join(' · ')}</p>}
          </div>
          <button className="btn btn-sm shrink-0" onClick={() => onTeach(row.label)}>
            Answer it
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * How much of the filling is free.
 *
 * The bank only pays for itself if questions from different sites collapse onto
 * the same key. When they do not, every application quietly costs a model call
 * per page and nothing says so -- which is what this is for.
 */
function Coverage() {
  const { data, loading } = useAsync(() => api.bankCoverage(), [])

  if (loading && !data) return <Spinner label="Reading the last few applications" />
  if (!data || data.fields === 0) {
    return (
      <Empty
        title="Nothing filled yet"
        hint="After the first application this shows which answers came free and which cost a model call."
      />
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px]">
        <strong>{Math.round(data.freeShare * 100)}%</strong> of {data.fields} field
        {data.fields === 1 ? '' : 's'} across {data.applications} application
        {data.applications === 1 ? '' : 's'} were answered without asking the model.
      </p>
      <div className="flex flex-col gap-1">
        {data.bySource.map((row) => (
          <div key={row.source} className="flex items-center gap-2">
            <span className="w-[170px] shrink-0 text-[12px]">{TIER_NAMES[row.source] ?? row.source}</span>
            <div className="h-2 flex-1 rounded bg-black/10">
              <div
                className={`h-2 rounded ${row.source === 'llm' || row.source === 'guess' ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.max(row.share * 100, 1)}%` }}
              />
            </div>
            <span className="w-[64px] shrink-0 text-right text-[12px] tabular-nums">
              {row.count} · {Math.round(row.share * 100)}%
            </span>
          </div>
        ))}
      </div>
      <p className="hint">
        {data.entries} entr{data.entries === 1 ? 'y' : 'ies'} stored, {data.unusedEntries} never reused.
      </p>
      {data.topEntries.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="hint">Carrying the most weight — a wrong value here is wrong everywhere:</p>
          {data.topEntries.slice(0, 5).map((e) => (
            <p key={e.label} className="hint truncate">
              ×{e.usageCount} · {e.label} → {e.value}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

export default function AnswersSection() {
  const [query, setQuery] = useState('')
  const { data: answers, loading, reload } = useAsync(() => api.listAnswers(query), [query])
  const { run, busy } = useAction()

  const [newLabel, setNewLabel] = useState('')
  const [newValue, setNewValue] = useState('')

  const add = () => {
    if (!newLabel.trim() || !newValue.trim()) return
    void run(async () => {
      await api.saveAnswer(newLabel, newValue, true)
      setNewLabel('')
      setNewValue('')
      reload()
    }, 'saving')
  }

  return (
    <div>
      <Section
        title="How much it already knows"
        description="Every field answered from the first four rows is free; the last two cost a model call."
      >
        <Coverage />
      </Section>

      <Section
        title="Questions that keep getting stuck"
        description="Each of these stopped at least one application. Answering one here answers it on every form that asks it."
      >
        <Parked onTeach={setNewLabel} />
      </Section>

      <Section
        title="Teach it an answer"
        description="Anything you add here is used verbatim whenever a form asks something close enough."
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Question as a form would phrase it">
            <TextInput
              value={newLabel}
              onChange={setNewLabel}
              placeholder="Why do you want to work here?"
            />
          </Field>
          <Field label="Your answer">
            <TextInput value={newValue} onChange={setNewValue} />
          </Field>
        </div>
        <button className="btn btn-primary btn-sm mt-2" disabled={!!busy || !newLabel.trim() || !newValue.trim()} onClick={add}>
          Save answer
        </button>
      </Section>

      <Section
        title="What it has learned"
        description="Grows on its own: every answer that survived a submitted application is remembered."
        actions={
          <div className="w-[220px]">
            <TextInput value={query} onChange={setQuery} placeholder="Search questions…" />
          </div>
        }
      >
        {loading && !answers && <Spinner label="Loading answers" />}

        {answers?.length === 0 && (
          <Empty
            title={query ? 'No matching answers' : 'Nothing learned yet'}
            hint={query ? undefined : 'Save your profile to seed the obvious ones, then let the agent fill in the rest.'}
          />
        )}

        <div className="flex flex-col gap-1.5">
          {answers?.map((entry) => (
            <div key={entry.id} className="surface flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium">{entry.label}</span>
                  {entry.pinned && <Badge tone="accent">pinned</Badge>}
                  <Badge>{entry.source}</Badge>
                  {entry.scope && <Badge>{entry.scope}</Badge>}
                </div>
                <TextInput
                  value={entry.value}
                  onChange={(v) =>
                    run(async () => {
                      await api.saveAnswer(entry.label, v, entry.pinned)
                    }, 'saving')
                  }
                />
                <p className="hint">
                  used {entry.usageCount} time{entry.usageCount === 1 ? '' : 's'} · last {formatRelative(entry.lastUsed)}
                </p>
              </div>
              <button
                className="btn btn-danger btn-sm shrink-0"
                disabled={!!busy}
                onClick={() => run(async () => { await api.deleteAnswer(entry.id); reload() }, 'deleting')}
              >
                Forget
              </button>
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}
