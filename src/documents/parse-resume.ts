/**
 * Reading a resume into the profile.
 *
 * Typing thirty fields by hand when the extension already has a model attached
 * is busywork. This takes the raw text of a resume and returns the same
 * structure the profile uses, so the whole page can be filled in one step.
 *
 * Two rules shape the design. The parser may only report what the document
 * actually says -- an inferred job title or a guessed phone number is worse
 * than a blank field, because a blank field is obvious and a wrong one is not.
 * And the merge never silently overwrites something the user typed themselves
 * unless they ask for exactly that.
 */

import { llm } from '@/llm/broker'
import {
  ParsedResumeSchema,
  ProfileSchema,
  type ParsedResume,
  type Profile,
  type Settings,
} from '@/storage/schemas'
import { renderTemplate } from '@/shared/text'
import { createLogger } from '@/shared/logger'
import { uid } from '@/shared/util'

const log = createLogger('resume')

/** Longer than this and the model starts losing the tail of the document. */
const MAX_RESUME_CHARS = 24000

export type MergeMode = 'fill_empty' | 'replace'

export type ImportResult = {
  profile: Profile
  parsed: ParsedResume
  /** Human-readable summary of what changed, for the confirmation step. */
  changes: string[]
  skipped: string[]
}

/**
 * Did the model actually read the document, or hand back a shell?
 *
 * Every field in ParsedResumeSchema carries a `.default()`. That is right for a
 * resume which genuinely omits a GPA, but it also means a reply of `{}` -- or
 * one whose keys we do not recognise -- validates perfectly and arrives here as
 * a fully-empty object. `mergeIntoProfile` then skips every empty field and the
 * import reports success having changed nothing, so a failed extraction looked
 * identical to a resume with no content in it. That silence is the actual
 * problem: the user is told it worked and the profile stays blank.
 *
 * A real resume always yields at least a name, a contact detail, a role, a
 * qualification or a skill. None of those means the document was not read.
 *
 * The prompt ends with a shape example containing one blank role, and weaker
 * models sometimes echo it verbatim, so a role with neither company nor title
 * does not count as content either.
 */
export function isHollowParse(parsed: ParsedResume): boolean {
  const named = Boolean(parsed.firstName.trim() || parsed.lastName.trim())
  const contactable = Boolean(parsed.email.trim() || parsed.phone.trim())
  const realRoles = parsed.experience.filter((r) => r.company.trim() || r.title.trim())
  const realEducation = parsed.education.filter((e) => e.school.trim() || e.degree.trim())

  return (
    !named &&
    !contactable &&
    realRoles.length === 0 &&
    realEducation.length === 0 &&
    parsed.skills.length === 0 &&
    !parsed.summary.trim() &&
    !parsed.headline.trim()
  )
}

export async function parseResumeText(text: string, settings: Settings): Promise<ParsedResume> {
  const cleaned = normalizeResumeText(text)
  if (cleaned.length < 80) {
    throw new Error('That does not look like a resume - too little text was found in it.')
  }

  const prompt = renderTemplate(settings.prompts.parseResume, {
    resume: cleaned.slice(0, MAX_RESUME_CHARS),
  })

  const parsed = await llm.completeStructured(
    { prompt, schema: ParsedResumeSchema, freshContext: true },
    'parse resume'
  )

  if (isHollowParse(parsed)) {
    // Reporting the character count separates "the PDF did not read" from "the
    // PDF read fine and the model returned nothing" -- two completely different
    // things to go and fix.
    log.error('Resume parse came back empty', {
      extractedChars: cleaned.length,
      driver: settings.llm.driver,
      model: settings.llm.model,
    })
    throw new Error(
      `The model returned nothing for this resume. ${cleaned.length.toLocaleString()} characters were ` +
        `read out of the file, so the file itself is fine — the reply came back empty.\n\n` +
        `In Settings → Model:\n` +
        `• Press "Run test". If that fails, the driver is the problem, not the resume.\n` +
        `• On NVIDIA NIM, check the key is valid and the model is an instruct model — ` +
        `Press "List available models" to see what your key can actually call — providers ` +
        `retire models without notice, and a retired one fails exactly like this.\n` +
        `• On a web driver, check you are still signed in to the chat site and that no dialog is covering the chat box.\n\n` +
        `Currently set to: ${settings.llm.driver}${settings.llm.model ? ` (${settings.llm.model})` : ''}.`
    )
  }

  log.info(
    `Parsed resume: ${parsed.experience.length} role(s), ${parsed.education.length} qualification(s), ${parsed.skills.length} skill(s)`
  )
  return parsed
}

/**
 * PDF text extraction leaves ligatures, soft hyphens and column artefacts that
 * make a model's job harder than it needs to be.
 */
export function normalizeResumeText(raw: string): string {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '') // soft hyphen
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/•/g, '- ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'number') return value === 0
  return false
}

/**
 * Fold a parsed resume into an existing profile.
 *
 * In `fill_empty` the parse only fills gaps, which is what makes re-importing
 * an updated resume safe: everything the user corrected by hand survives. In
 * `replace` the parse wins for every field it actually found -- but a field it
 * found nothing for still leaves the existing value alone, because deleting
 * someone's phone number because the PDF hid it is never the helpful reading.
 */
export function mergeIntoProfile(
  existing: Profile,
  parsed: ParsedResume,
  mode: MergeMode,
  rawText: string
): ImportResult {
  const next: Profile = ProfileSchema.parse({ ...existing })
  const changes: string[] = []
  const skipped: string[] = []

  const apply = <K extends keyof Profile>(key: K, value: Profile[K], label: string): void => {
    if (isEmpty(value)) return
    const current = next[key]
    const currentEmpty = isEmpty(current)

    if (!currentEmpty && mode === 'fill_empty') {
      if (String(current) !== String(value)) skipped.push(label)
      return
    }
    if (!currentEmpty && String(current) === String(value)) return

    next[key] = value
    changes.push(label)
  }

  apply('firstName', parsed.firstName as Profile['firstName'], 'first name')
  apply('lastName', parsed.lastName as Profile['lastName'], 'last name')
  apply('email', parsed.email as Profile['email'], 'email')
  apply('phone', parsed.phone as Profile['phone'], 'phone')
  if (parsed.phoneCountryCode) {
    apply('phoneCountryCode', parsed.phoneCountryCode as Profile['phoneCountryCode'], 'country code')
  }
  apply('city', parsed.city as Profile['city'], 'city')
  apply('state', parsed.state as Profile['state'], 'state')
  apply('country', parsed.country as Profile['country'], 'country')
  apply('headline', parsed.headline as Profile['headline'], 'headline')
  apply('summary', parsed.summary as Profile['summary'], 'summary')
  apply('currentTitle', parsed.currentTitle as Profile['currentTitle'], 'current title')
  apply('currentCompany', parsed.currentCompany as Profile['currentCompany'], 'current company')
  apply('linkedin', parsed.linkedin as Profile['linkedin'], 'LinkedIn')
  apply('github', parsed.github as Profile['github'], 'GitHub')
  apply('portfolio', parsed.portfolio as Profile['portfolio'], 'website')
  apply('yearsExperience', parsed.yearsExperience as Profile['yearsExperience'], 'years of experience')
  apply('skills', parsed.skills as Profile['skills'], `${parsed.skills.length} skills`)
  apply('languages', parsed.languages as Profile['languages'], `${parsed.languages.length} languages`)
  apply(
    'certifications',
    parsed.certifications as Profile['certifications'],
    `${parsed.certifications.length} certifications`
  )

  // Roles and education carry generated ids, so they are merged as whole lists
  // rather than field by field. Matching on company plus title keeps the id of
  // a role the user has already edited, which matters because the tailoring
  // prompt addresses roles by id.
  if (parsed.experience.length > 0) {
    if (next.experience.length === 0 || mode === 'replace') {
      next.experience = parsed.experience.map((role) => {
        const match = existing.experience.find(
          (e) =>
            e.company.trim().toLowerCase() === role.company.trim().toLowerCase() &&
            e.title.trim().toLowerCase() === role.title.trim().toLowerCase()
        )
        return {
          id: match?.id ?? uid('role'),
          company: role.company,
          title: role.title,
          location: role.location,
          startDate: role.startDate,
          endDate: role.endDate,
          current: role.current,
          bullets: role.bullets,
          tech: role.tech,
        }
      })
      changes.push(`${parsed.experience.length} roles`)
    } else {
      skipped.push('experience')
    }
  }

  if (parsed.education.length > 0) {
    if (next.education.length === 0 || mode === 'replace') {
      next.education = parsed.education.map((ed) => ({
        id: uid('edu'),
        school: ed.school,
        degree: ed.degree,
        field: ed.field,
        startDate: ed.startDate,
        endDate: ed.endDate,
        gpa: ed.gpa,
      }))
      changes.push(`${parsed.education.length} qualifications`)
    } else {
      skipped.push('education')
    }
  }

  // The raw text is always kept: it is the source of truth the fabrication
  // screen checks figures against, and re-parsing later needs it.
  const cleaned = normalizeResumeText(rawText)
  if (cleaned && cleaned !== next.masterResumeText) {
    next.masterResumeText = cleaned
    changes.push('master resume text')
  }

  // Work authorization is only taken when the document states it outright.
  if (parsed.workAuthorization.authorizedInCountries.length > 0) {
    if (next.workAuthorization.authorizedInCountries.length === 0 || mode === 'replace') {
      next.workAuthorization = {
        ...next.workAuthorization,
        authorizedInCountries: parsed.workAuthorization.authorizedInCountries,
      }
      changes.push('work authorization')
    }
  }
  if (parsed.workAuthorization.requiresSponsorship !== null && mode === 'replace') {
    next.workAuthorization = {
      ...next.workAuthorization,
      requiresSponsorship: parsed.workAuthorization.requiresSponsorship,
    }
  }

  return { profile: ProfileSchema.parse(next), parsed, changes, skipped }
}

/** Everything a resume cannot tell us, which the user still has to answer. */
export function remainingGaps(profile: Profile): string[] {
  const gaps: string[] = []
  if (!profile.email.trim()) gaps.push('email address')
  if (!profile.phone.trim()) gaps.push('phone number')
  if (profile.workAuthorization.authorizedInCountries.length === 0) {
    gaps.push('which countries you are authorized to work in')
  }
  if (!profile.compensation.expectedCtc.trim()) gaps.push('expected compensation')
  if (profile.workAuthorization.noticePeriodDays === 0 && !profile.workAuthorization.availableFrom.trim()) {
    gaps.push('notice period or start date')
  }
  return gaps
}
