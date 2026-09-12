/**
 * Resume tailoring and cover letters.
 *
 * The model is only ever allowed to re-emphasise what the profile already says.
 * Employers, titles and dates are never taken from the model at all -- the PDF
 * renderer reads those straight from the profile -- so the only surface where a
 * fabrication could reach a recruiter is bullet text and the cover letter body.
 *
 * `screenFabrications` guards that surface. Its rule is narrow and mechanical:
 * a tailored bullet may not introduce a number that does not appear in the
 * original bullets for that role. Invented metrics are the fabrication that
 * actually happens, they are the most damaging one in an interview, and they
 * are the one a machine can reliably detect.
 */

import { llm } from '@/llm/broker'
import { jobForPrompt, profileForPrompt } from '@/form/resolver'
import { renderCoverLetterPdf, renderResumePdf } from './pdf'
import { docsRepo } from '@/storage/db'
import {
  CoverLetterSchema,
  TailoredResumeSchema,
  type DocumentConfig,
  type Job,
  type Profile,
  type Settings,
  type StoredDoc,
  type TailoredResume,
} from '@/storage/schemas'
import { renderTemplate, sanitizeFileName } from '@/shared/text'
import { createLogger } from '@/shared/logger'
import { uid } from '@/shared/util'

const log = createLogger('documents')

/* -------------------------------------------------------- fabrication guard */

/** Every number in a string, normalized so "1,200" and "1200" compare equal. */
function numbersIn(text: string): string[] {
  return (String(text ?? '').match(/\d[\d,.]*\s*%?/g) ?? []).map((n) =>
    n.replace(/[,\s]/g, '').replace(/\.$/, '').toLowerCase()
  )
}

export type FabricationReport = {
  clean: boolean
  rejectedBullets: Array<{ roleId: string; bullet: string; reason: string }>
}

/**
 * Drop tailored bullets that invent figures. A rejected bullet falls back to
 * the original text rather than being removed, so the resume never gets shorter
 * because the model misbehaved.
 */
export function screenFabrications(
  tailored: TailoredResume,
  profile: Profile
): { tailored: TailoredResume; report: FabricationReport } {
  const rejected: FabricationReport['rejectedBullets'] = []
  const profileNumbers = new Set(numbersIn(profile.masterResumeText))

  const roles = tailored.roles.map((role) => {
    const source = profile.experience.find((e) => e.id === role.id)
    if (!source) {
      // A role id we never sent is itself a fabrication; drop it entirely.
      rejected.push({ roleId: role.id, bullet: '(entire role)', reason: 'unknown role id' })
      return { id: role.id, bullets: [] }
    }

    const allowed = new Set([...numbersIn(source.bullets.join(' ')), ...profileNumbers])
    const kept: string[] = []

    for (const bullet of role.bullets) {
      const invented = numbersIn(bullet).filter((n) => !allowed.has(n))
      if (invented.length > 0) {
        rejected.push({
          roleId: role.id,
          bullet,
          reason: `introduces figure(s) not in the profile: ${invented.join(', ')}`,
        })
        continue
      }
      kept.push(bullet)
    }

    // If screening emptied a role, keep the originals rather than a blank role.
    return { id: role.id, bullets: kept.length > 0 ? kept : source.bullets }
  })

  return {
    tailored: { ...tailored, roles },
    report: { clean: rejected.length === 0, rejectedBullets: rejected },
  }
}

/* ---------------------------------------------------------------- tailor */

export async function tailorResume(
  profile: Profile,
  job: Job,
  settings: Settings
): Promise<{ tailored: TailoredResume; report: FabricationReport }> {
  const roles = profile.experience
    .map((role) =>
      [
        `id: ${role.id}`,
        `role: ${role.title} at ${role.company}`,
        `dates: ${role.startDate} to ${role.current ? 'present' : role.endDate}`,
        'bullets:',
        ...role.bullets.map((b) => `  - ${b}`),
      ].join('\n')
    )
    .join('\n\n')

  const prompt = renderTemplate(settings.prompts.tailorResume, {
    profile: profileForPrompt(profile),
    job: jobForPrompt(job),
    roles,
    maxBullets: settings.documents.maxBulletsPerRole,
  })

  const raw = await llm.completeStructured(
    { prompt, schema: TailoredResumeSchema, freshContext: true },
    `tailor resume for ${job.company}`
  )

  if (!settings.documents.rejectFabrications) {
    return { tailored: raw, report: { clean: true, rejectedBullets: [] } }
  }

  const screened = screenFabrications(raw, profile)
  if (!screened.report.clean) {
    log.warn(`Rejected ${screened.report.rejectedBullets.length} tailored bullet(s) with invented figures`, {
      rejected: screened.report.rejectedBullets.slice(0, 4),
    })
  }
  return screened
}

export async function writeCoverLetter(
  profile: Profile,
  job: Job,
  settings: Settings
): Promise<string> {
  const prompt = renderTemplate(settings.prompts.coverLetter, {
    profile: profileForPrompt(profile),
    job: jobForPrompt(job),
    tone: settings.documents.coverLetterTone,
    company: job.company,
    title: job.title,
  })

  const result = await llm.completeStructured(
    { prompt, schema: CoverLetterSchema, freshContext: true },
    `cover letter for ${job.company}`
  )
  return result.body.trim()
}

/* ------------------------------------------------------------- generation */

export type GeneratedDocs = {
  resumeDocId: string
  resumeFileName: string
  coverDocId: string
  coverFileName: string
  coverLetterText: string
  fabricationReport: FabricationReport | null
}

function fileName(pattern: string, profile: Profile, job: Job, fallback: string): string {
  const rendered = renderTemplate(pattern, {
    firstName: profile.firstName || 'Candidate',
    lastName: profile.lastName || '',
    company: job.company || 'Company',
    title: job.title || 'Role',
  })
  const cleaned = sanitizeFileName(rendered.replace(/_+/g, '_').replace(/^_|_$/g, ''))
  return cleaned.endsWith('.pdf') ? cleaned : `${cleaned || fallback}.pdf`
}

async function store(kind: StoredDoc['kind'], name: string, jobId: string, blob: Blob): Promise<string> {
  const id = uid('doc')
  await docsRepo.put(
    { id, kind, fileName: name, mimeType: 'application/pdf', jobId, createdAt: Date.now(), sizeBytes: blob.size },
    blob
  )
  return id
}

/**
 * Produce the documents for one application.
 *
 * Tailoring failures are not fatal: an untailored resume built from the profile
 * is still a perfectly good resume, and submitting it beats parking the
 * application because the chat tab hiccuped.
 */
export async function generateDocuments(
  profile: Profile,
  job: Job,
  settings: Settings,
  options: { needResume: boolean; needCoverLetter: boolean }
): Promise<GeneratedDocs> {
  const config: DocumentConfig = settings.documents
  const out: GeneratedDocs = {
    resumeDocId: '',
    resumeFileName: '',
    coverDocId: '',
    coverFileName: '',
    coverLetterText: '',
    fabricationReport: null,
  }

  if (options.needResume) {
    let tailored: TailoredResume | null = null
    if (config.tailorResume) {
      try {
        const result = await tailorResume(profile, job, settings)
        tailored = result.tailored
        out.fabricationReport = result.report
      } catch (e) {
        log.warn('Tailoring failed; falling back to the untailored resume', { error: (e as Error).message })
      }
    }
    const blob = await renderResumePdf(profile, tailored)
    out.resumeFileName = fileName(config.resumeFileNamePattern, profile, job, 'Resume')
    out.resumeDocId = await store('resume', out.resumeFileName, job.id, blob)
    log.info(`Resume rendered (${Math.round(blob.size / 1024)} KB)${tailored ? ', tailored' : ''}`)
  }

  if (options.needCoverLetter && config.generateCoverLetter) {
    try {
      out.coverLetterText = await writeCoverLetter(profile, job, settings)
      const blob = await renderCoverLetterPdf(profile, out.coverLetterText, {
        company: job.company,
        title: job.title,
      })
      out.coverFileName = fileName(config.coverFileNamePattern, profile, job, 'Cover_Letter')
      out.coverDocId = await store('cover_letter', out.coverFileName, job.id, blob)
      log.info('Cover letter generated')
    } catch (e) {
      log.warn('Cover letter generation failed; continuing without one', { error: (e as Error).message })
    }
  }

  return out
}
