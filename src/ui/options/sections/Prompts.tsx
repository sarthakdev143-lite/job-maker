/**
 * Prompt editor.
 *
 * The four prompts are the agent's actual behaviour, so they are editable and
 * the placeholders are documented next to each one. An empty prompt falls back
 * to the shipped default rather than sending nothing, which makes "reset" as
 * simple as clearing the box.
 */

import { useState } from 'react'
import { Section, TextArea } from '../../shared/components'
import { DEFAULT_PROMPTS } from '@/storage/defaults'
import type { PromptTemplates, Settings } from '@/storage/schemas'

const PROMPTS: Array<{
  key: keyof PromptTemplates
  title: string
  description: string
  placeholders: string[]
}> = [
  {
    key: 'score',
    title: 'Scoring a posting',
    description: 'Decides whether a job is worth applying to and why. Runs once per posting that survives the hard filters.',
    placeholders: ['{profile}', '{rules}', '{weights}', '{title}', '{company}', '{location}', '{salary}', '{description}'],
  },
  {
    key: 'answerFields',
    title: 'Answering form fields',
    description:
      'Handles questions that the profile, the adapters and the answer bank could not. One call per page, covering every unresolved field at once.',
    placeholders: ['{profile}', '{job}', '{fields}', '{answerBank}'],
  },
  {
    key: 'tailorResume',
    title: 'Tailoring the resume',
    description: 'Re-emphasises existing bullets for one posting. Not allowed to add experience.',
    placeholders: ['{profile}', '{job}', '{roles}', '{maxBullets}'],
  },
  {
    key: 'coverLetter',
    title: 'Writing the cover letter',
    description: 'Produces the body only; the template adds the letterhead, greeting and sign-off.',
    placeholders: ['{profile}', '{job}', '{tone}', '{company}', '{title}'],
  },
  {
    key: 'parseResume',
    title: 'Reading a resume into the profile',
    description:
      'Transcribes an uploaded resume into structured fields. Tightening the rules here is the fastest way to fix a bad import.',
    placeholders: ['{resume}'],
  },
  {
    key: 'suggestRules',
    title: 'Suggesting search rules',
    description: 'Drafts title keywords, exclusions and seniority levels from the profile.',
    placeholders: ['{profile}'],
  },
]

export default function PromptsSection({
  settings,
  patch,
}: {
  settings: Settings
  patch: (p: Partial<Settings>) => void
}) {
  const [open, setOpen] = useState<keyof PromptTemplates>('score')
  const set = (key: keyof PromptTemplates, value: string) =>
    patch({ prompts: { ...settings.prompts, [key]: value } })

  return (
    <div>
      <p className="surface-quiet mb-4 px-3 py-2.5 text-[12px]" style={{ color: 'var(--ink-soft)' }}>
        Every request also gets a JSON output contract appended automatically, and a reply that fails to parse is
        retried once with the specific error. You do not need to restate the output format — but do keep the shape
        described at the end of each prompt accurate, because that is what the validator checks against.
      </p>

      {PROMPTS.map((prompt) => {
        const value = settings.prompts[prompt.key]
        const isDefault = value === DEFAULT_PROMPTS[prompt.key]
        return (
          <Section
            key={prompt.key}
            title={prompt.title}
            description={prompt.description}
            actions={
              <>
                <button className="btn btn-ghost btn-sm" onClick={() => setOpen(open === prompt.key ? ('' as never) : prompt.key)}>
                  {open === prompt.key ? 'Collapse' : 'Edit'}
                </button>
                <button
                  className="btn btn-sm"
                  disabled={isDefault}
                  onClick={() => set(prompt.key, DEFAULT_PROMPTS[prompt.key])}
                >
                  {isDefault ? 'Default' : 'Reset'}
                </button>
              </>
            }
          >
            {open === prompt.key && (
              <>
                <div className="mb-2 flex flex-wrap gap-1">
                  {prompt.placeholders.map((p) => (
                    <code
                      key={p}
                      className="mono rounded px-1.5 py-0.5"
                      style={{ background: 'var(--bg-soft)', color: 'var(--accent)' }}
                    >
                      {p}
                    </code>
                  ))}
                </div>
                <TextArea value={value} onChange={(v) => set(prompt.key, v)} rows={18} />
              </>
            )}
          </Section>
        )
      })}
    </div>
  )
}
