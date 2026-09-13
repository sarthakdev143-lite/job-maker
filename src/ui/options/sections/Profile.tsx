/**
 * Profile.
 *
 * The single source of truth for everything the agent says about the user. The
 * resume tailoring prompt is forbidden from inventing anything not on this
 * page, so a thin profile produces a thin resume -- which is the honest
 * outcome, and the page says so rather than quietly padding.
 */

import { Field, ListInput, NumberInput, Section, TextArea, TextInput, Toggle } from '../../shared/components'
import ResumeImport from './ResumeImport'
import { api, download, useAction } from '../../shared/api'
import { uid } from '@/shared/util'
import type { Education, Experience, Profile } from '@/storage/schemas'

export default function ProfileSection({
  profile,
  patch,
  replaceProfile,
}: {
  profile: Profile
  patch: (p: Partial<Profile>) => void
  replaceProfile: (p: Profile) => void
}) {
  const { run, busy } = useAction()

  const addRole = () => {
    const role: Experience = {
      id: uid('role'),
      company: '',
      title: '',
      location: '',
      startDate: '',
      endDate: '',
      current: profile.experience.length === 0,
      bullets: [],
      tech: [],
    }
    patch({ experience: [...profile.experience, role] })
  }

  const updateRole = (id: string, p: Partial<Experience>) =>
    patch({ experience: profile.experience.map((r) => (r.id === id ? { ...r, ...p } : r)) })

  const removeRole = (id: string) => patch({ experience: profile.experience.filter((r) => r.id !== id) })

  const addEducation = () => {
    const ed: Education = { id: uid('edu'), school: '', degree: '', field: '', startDate: '', endDate: '', gpa: '' }
    patch({ education: [...profile.education, ed] })
  }

  const updateEducation = (id: string, p: Partial<Education>) =>
    patch({ education: profile.education.map((e) => (e.id === id ? { ...e, ...p } : e)) })

  return (
    <div>
      <ResumeImport profile={profile} onImported={replaceProfile} />

      <Section
        title="Identity"
        description="What every application form asks for first. Imported from your resume above, where it said so."
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <TextInput value={profile.firstName} onChange={(v) => patch({ firstName: v })} />
          </Field>
          <Field label="Last name">
            <TextInput value={profile.lastName} onChange={(v) => patch({ lastName: v })} />
          </Field>
          <Field label="Preferred name" hint="Used when a form asks what you go by.">
            <TextInput value={profile.preferredName} onChange={(v) => patch({ preferredName: v })} />
          </Field>
          <Field label="Email">
            <TextInput type="email" value={profile.email} onChange={(v) => patch({ email: v })} />
          </Field>
          <Field label="Country code">
            <TextInput value={profile.phoneCountryCode} onChange={(v) => patch({ phoneCountryCode: v })} />
          </Field>
          <Field label="Phone">
            <TextInput value={profile.phone} onChange={(v) => patch({ phone: v })} />
          </Field>
          <Field label="Address" wide>
            <TextInput value={profile.addressLine1} onChange={(v) => patch({ addressLine1: v })} />
          </Field>
          <Field label="City">
            <TextInput value={profile.city} onChange={(v) => patch({ city: v })} />
          </Field>
          <Field label="State or province">
            <TextInput value={profile.state} onChange={(v) => patch({ state: v })} />
          </Field>
          <Field label="Postal code">
            <TextInput value={profile.postalCode} onChange={(v) => patch({ postalCode: v })} />
          </Field>
          <Field label="Country">
            <TextInput value={profile.country} onChange={(v) => patch({ country: v })} />
          </Field>
        </div>
      </Section>

      <Section title="Positioning" description="How you describe yourself at the top of a resume.">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Headline" wide hint="One line, e.g. Backend engineer, distributed systems.">
            <TextInput value={profile.headline} onChange={(v) => patch({ headline: v })} />
          </Field>
          <Field label="Summary" wide hint="Two or three sentences. Tailoring rewrites this per role.">
            <TextArea value={profile.summary} onChange={(v) => patch({ summary: v })} rows={3} mono={false} />
          </Field>
          <Field label="Current title">
            <TextInput value={profile.currentTitle} onChange={(v) => patch({ currentTitle: v })} />
          </Field>
          <Field label="Current company">
            <TextInput value={profile.currentCompany} onChange={(v) => patch({ currentCompany: v })} />
          </Field>
          <Field label="Years of experience">
            <NumberInput value={profile.yearsExperience} onChange={(v) => patch({ yearsExperience: v })} min={0} max={60} />
          </Field>
        </div>
      </Section>

      <Section title="Links">
        <div className="grid grid-cols-2 gap-3">
          <Field label="LinkedIn">
            <TextInput value={profile.linkedin} onChange={(v) => patch({ linkedin: v })} placeholder="https://linkedin.com/in/…" />
          </Field>
          <Field label="GitHub">
            <TextInput value={profile.github} onChange={(v) => patch({ github: v })} placeholder="https://github.com/…" />
          </Field>
          <Field label="Portfolio or website" wide>
            <TextInput value={profile.portfolio} onChange={(v) => patch({ portfolio: v })} />
          </Field>
        </div>
      </Section>

      <Section
        title="Work authorization"
        description="Answered once here, then filled on every form without a model call."
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Authorized to work in" wide hint="One country per line. Used to answer eligibility questions.">
            <ListInput
              value={profile.workAuthorization.authorizedInCountries}
              onChange={(v) =>
                patch({ workAuthorization: { ...profile.workAuthorization, authorizedInCountries: v } })
              }
              placeholder={'India\nUnited States'}
            />
          </Field>
          <Field label="Notice period (days)">
            <NumberInput
              value={profile.workAuthorization.noticePeriodDays}
              onChange={(v) => patch({ workAuthorization: { ...profile.workAuthorization, noticePeriodDays: v } })}
              min={0}
              max={365}
            />
          </Field>
          <Field label="Available from" hint="YYYY-MM-DD, if you have a fixed date.">
            <TextInput
              value={profile.workAuthorization.availableFrom}
              onChange={(v) => patch({ workAuthorization: { ...profile.workAuthorization, availableFrom: v } })}
            />
          </Field>
        </div>
        <div className="mt-1">
          <Toggle
            checked={profile.workAuthorization.requiresSponsorship}
            onChange={(v) => patch({ workAuthorization: { ...profile.workAuthorization, requiresSponsorship: v } })}
            label="I need visa sponsorship"
            description="Answered verbatim on sponsorship questions. Getting this wrong wastes everyone's time."
          />
          <Toggle
            checked={profile.workAuthorization.willingToRelocate}
            onChange={(v) => patch({ workAuthorization: { ...profile.workAuthorization, willingToRelocate: v } })}
            label="I am willing to relocate"
          />
        </div>
      </Section>

      <Section title="Compensation" description="Only used when a form asks. Left blank, those fields go to review.">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Currency">
            <TextInput
              value={profile.compensation.currency}
              onChange={(v) => patch({ compensation: { ...profile.compensation, currency: v } })}
            />
          </Field>
          <Field label="Current compensation">
            <TextInput
              value={profile.compensation.currentCtc}
              onChange={(v) => patch({ compensation: { ...profile.compensation, currentCtc: v } })}
            />
          </Field>
          <Field label="Expected compensation">
            <TextInput
              value={profile.compensation.expectedCtc}
              onChange={(v) => patch({ compensation: { ...profile.compensation, expectedCtc: v } })}
            />
          </Field>
          <Field label="Minimum acceptable">
            <TextInput
              value={profile.compensation.minimumAcceptable}
              onChange={(v) => patch({ compensation: { ...profile.compensation, minimumAcceptable: v } })}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Experience"
        description="The only material tailoring may draw on. Bullets get re-emphasised per job, never invented."
        actions={
          <button className="btn btn-sm" onClick={addRole}>
            Add a role
          </button>
        }
      >
        <div className="flex flex-col gap-3">
          {profile.experience.length === 0 && (
            <p className="surface-quiet px-3 py-4 text-center text-[12px]" style={{ color: 'var(--ink-faint)' }}>
              No roles yet. Add at least one, or paste a full resume below.
            </p>
          )}
          {profile.experience.map((role) => (
            <div key={role.id} className="surface px-3 py-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Title">
                  <TextInput value={role.title} onChange={(v) => updateRole(role.id, { title: v })} />
                </Field>
                <Field label="Company">
                  <TextInput value={role.company} onChange={(v) => updateRole(role.id, { company: v })} />
                </Field>
                <Field label="Location">
                  <TextInput value={role.location} onChange={(v) => updateRole(role.id, { location: v })} />
                </Field>
                <Field label="Start (YYYY-MM)">
                  <TextInput value={role.startDate} onChange={(v) => updateRole(role.id, { startDate: v })} />
                </Field>
                <Field label="End (YYYY-MM)">
                  <TextInput
                    value={role.endDate}
                    onChange={(v) => updateRole(role.id, { endDate: v })}
                    disabled={role.current}
                  />
                </Field>
                <div className="flex items-end pb-1">
                  <Toggle
                    checked={role.current}
                    onChange={(v) => updateRole(role.id, { current: v })}
                    label="Current role"
                  />
                </div>
                <Field label="Bullets" wide hint="One per line. These are what tailoring rewrites.">
                  <ListInput
                    value={role.bullets}
                    onChange={(v) => updateRole(role.id, { bullets: v })}
                    rows={4}
                    placeholder="Cut p99 checkout latency from 1.8s to 400ms by…"
                  />
                </Field>
              </div>
              <div className="mt-2 flex justify-end">
                <button className="btn btn-danger btn-sm" onClick={() => removeRole(role.id)}>
                  Remove role
                </button>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Education"
        actions={
          <button className="btn btn-sm" onClick={addEducation}>
            Add
          </button>
        }
      >
        <div className="flex flex-col gap-3">
          {profile.education.map((ed) => (
            <div key={ed.id} className="surface grid grid-cols-2 gap-3 px-3 py-3">
              <Field label="School">
                <TextInput value={ed.school} onChange={(v) => updateEducation(ed.id, { school: v })} />
              </Field>
              <Field label="Degree">
                <TextInput value={ed.degree} onChange={(v) => updateEducation(ed.id, { degree: v })} />
              </Field>
              <Field label="Field of study">
                <TextInput value={ed.field} onChange={(v) => updateEducation(ed.id, { field: v })} />
              </Field>
              <Field label="Graduated (YYYY-MM)">
                <TextInput value={ed.endDate} onChange={(v) => updateEducation(ed.id, { endDate: v })} />
              </Field>
              <div className="col-span-2 flex justify-end">
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => patch({ education: profile.education.filter((e) => e.id !== ed.id) })}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Skills and extras">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Skills" hint="One per line. Tailoring reorders these, never adds to them.">
            <ListInput value={profile.skills} onChange={(v) => patch({ skills: v })} rows={5} />
          </Field>
          <Field label="Languages">
            <ListInput value={profile.languages} onChange={(v) => patch({ languages: v })} rows={5} />
          </Field>
          <Field label="Certifications" wide>
            <ListInput value={profile.certifications} onChange={(v) => patch({ certifications: v })} rows={3} />
          </Field>
          <Field
            label="Master resume text"
            wide
            hint="Paste your full resume. Used as context for unusual questions and to sanity-check figures."
          >
            <TextArea value={profile.masterResumeText} onChange={(v) => patch({ masterResumeText: v })} rows={10} />
          </Field>
          <Field
            label="Extra context"
            wide
            hint="Anything a form might ask that is not on your resume: why you are looking, visa details, availability."
          >
            <TextArea value={profile.extraContext} onChange={(v) => patch({ extraContext: v })} rows={5} />
          </Field>
        </div>
        <div className="mt-3">
          <button
            className="btn btn-sm"
            disabled={!!busy}
            onClick={() =>
              run(async () => {
                const preview = await api.previewResume()
                await download(preview.dataUrl, `${profile.firstName || 'resume'}_preview.pdf`)
              }, 'rendering')
            }
          >
            {busy ? 'Rendering…' : 'Preview resume PDF'}
          </button>
          <span className="ml-2 text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
            Renders exactly what employers receive, untailored. Save your profile first.
          </span>
        </div>
      </Section>

      <Section
        title="Voluntary disclosures"
        description="Optional demographic questions. Off by default, and the agent declines them politely."
      >
        <Toggle
          checked={profile.voluntary.answerEeoQuestions}
          onChange={(v) => patch({ voluntary: { ...profile.voluntary, answerEeoQuestions: v } })}
          label="Answer EEO questions with the values below"
          description="When off, the agent selects the decline-to-answer option wherever one exists."
        />
        {profile.voluntary.answerEeoQuestions && (
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Field label="Gender">
              <TextInput
                value={profile.voluntary.gender}
                onChange={(v) => patch({ voluntary: { ...profile.voluntary, gender: v } })}
              />
            </Field>
            <Field label="Race or ethnicity">
              <TextInput
                value={profile.voluntary.race}
                onChange={(v) => patch({ voluntary: { ...profile.voluntary, race: v } })}
              />
            </Field>
            <Field label="Hispanic or Latino">
              <TextInput
                value={profile.voluntary.hispanicLatino}
                onChange={(v) => patch({ voluntary: { ...profile.voluntary, hispanicLatino: v } })}
              />
            </Field>
          </div>
        )}
      </Section>
    </div>
  )
}
