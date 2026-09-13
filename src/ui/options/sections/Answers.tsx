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
