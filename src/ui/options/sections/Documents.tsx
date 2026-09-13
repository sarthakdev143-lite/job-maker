/** Resume and cover letter generation. */

import { Field, NumberInput, Section, Select, TextInput, Toggle } from '../../shared/components'
import type { DocumentConfig, Settings } from '@/storage/schemas'

export default function DocumentsSection({
  settings,
  patch,
}: {
  settings: Settings
  patch: (p: Partial<Settings>) => void
}) {
  const d = settings.documents
  const set = (p: Partial<DocumentConfig>) => patch({ documents: { ...d, ...p } })

  return (
    <div>
      <Section
        title="Tailoring"
        description="Rewrites emphasis for each posting. Employers, titles and dates always come from your profile and are never model output."
      >
        <Toggle
          checked={d.tailorResume}
          onChange={(v) => set({ tailorResume: v })}
          label="Tailor the resume per job"
          description="Re-emphasises and reorders your existing bullets. Costs one model call per application."
        />
        <Toggle
          checked={d.generateCoverLetter}
          onChange={(v) => set({ generateCoverLetter: v })}
          label="Write a cover letter per job"
        />
        <Toggle
          checked={d.rejectFabrications}
          onChange={(v) => set({ rejectFabrications: v })}
          label="Reject bullets that invent figures"
          description="A tailored bullet may not introduce a number absent from your profile. Leave this on: an invented metric is the fabrication that actually happens, and it falls apart in an interview."
        />

        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="Maximum bullets per role">
            <NumberInput value={d.maxBulletsPerRole} onChange={(v) => set({ maxBulletsPerRole: v })} min={1} max={12} />
          </Field>
          <Field label="Template">
            <Select
              value={d.resumeTemplate}
              onChange={(v) => set({ resumeTemplate: v })}
              options={[
                { value: 'classic', label: 'Classic — single column, ATS-safe' },
                { value: 'compact', label: 'Compact — tighter spacing' },
              ]}
            />
          </Field>
          <Field label="Cover letter tone" wide hint="Fed to the prompt verbatim.">
            <TextInput value={d.coverLetterTone} onChange={(v) => set({ coverLetterTone: v })} />
          </Field>
        </div>
      </Section>

      <Section
        title="File names"
        description="Placeholders: {firstName} {lastName} {company} {title}. Recruiters see these, so keep them plain."
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Resume file name">
            <TextInput value={d.resumeFileNamePattern} onChange={(v) => set({ resumeFileNamePattern: v })} />
          </Field>
          <Field label="Cover letter file name">
            <TextInput value={d.coverFileNamePattern} onChange={(v) => set({ coverFileNamePattern: v })} />
          </Field>
        </div>
      </Section>

      <Section title="Why the layout is plain">
        <p className="surface-quiet px-3 py-2.5 text-[12px]" style={{ color: 'var(--ink-soft)' }}>
          The generated PDF is one column of real text with standard section headings and no tables or graphics. That
          is what applicant tracking systems parse reliably. A handsome two-column resume that parses into scrambled
          fields scores worse than a dull one that parses cleanly, so the template does not offer the option.
        </p>
      </Section>
    </div>
  )
}
