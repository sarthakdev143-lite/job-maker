/**
 * Every shape that crosses a process boundary or hits disk is declared here as
 * a zod schema, and the TypeScript types are derived from it. Nothing persisted
 * is trusted on read: storage helpers parse through these, so a schema change
 * or a corrupted record degrades to a default instead of crashing the worker.
 */
import { z } from 'zod'

/* ------------------------------------------------------------------ profile */

export const ProfileLinkSchema = z.object({
  label: z.string().default(''),
  url: z.string().default(''),
})

export const ExperienceSchema = z.object({
  id: z.string(),
  company: z.string().default(''),
  title: z.string().default(''),
  location: z.string().default(''),
  startDate: z.string().default(''), // YYYY-MM
  endDate: z.string().default(''), // YYYY-MM, or '' when current
  current: z.boolean().default(false),
  bullets: z.array(z.string()).default([]),
  tech: z.array(z.string()).default([]),
})

export const EducationSchema = z.object({
  id: z.string(),
  school: z.string().default(''),
  degree: z.string().default(''),
  field: z.string().default(''),
  startDate: z.string().default(''),
  endDate: z.string().default(''),
  gpa: z.string().default(''),
})

/**
 * Demographic answers are optional everywhere and default to declining. They
 * exist only so the agent can fill EEO sections without parking the whole
 * application for review; the user opts in explicitly in settings.
 */
export const VoluntaryDisclosureSchema = z.object({
  answerEeoQuestions: z.boolean().default(false),
  gender: z.string().default('Decline To Self Identify'),
  race: z.string().default('Decline To Self Identify'),
  veteranStatus: z.string().default('I do not wish to answer'),
  disabilityStatus: z.string().default('I do not wish to answer'),
  hispanicLatino: z.string().default('Decline To Self Identify'),
})

export const ProfileSchema = z.object({
  firstName: z.string().default(''),
  lastName: z.string().default(''),
  preferredName: z.string().default(''),
  email: z.string().default(''),
  phone: z.string().default(''),
  phoneCountryCode: z.string().default('+91'),
  addressLine1: z.string().default(''),
  addressLine2: z.string().default(''),
  city: z.string().default(''),
  state: z.string().default(''),
  postalCode: z.string().default(''),
  country: z.string().default('India'),

  headline: z.string().default(''),
  summary: z.string().default(''),
  yearsExperience: z.number().default(0),
  currentTitle: z.string().default(''),
  currentCompany: z.string().default(''),

  links: z.array(ProfileLinkSchema).default([]),
  linkedin: z.string().default(''),
  github: z.string().default(''),
  portfolio: z.string().default(''),

  experience: z.array(ExperienceSchema).default([]),
  education: z.array(EducationSchema).default([]),
  skills: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  certifications: z.array(z.string()).default([]),

  // Work authorization: the questions every ATS asks, answered once.
  workAuthorization: z
    .object({
      authorizedInCountries: z.array(z.string()).default([]),
      requiresSponsorship: z.boolean().default(false),
      sponsorshipNote: z.string().default(''),
      willingToRelocate: z.boolean().default(false),
      relocationNote: z.string().default(''),
      noticePeriodDays: z.number().default(30),
      availableFrom: z.string().default(''),
    })
    .default({}),

  compensation: z
    .object({
      currency: z.string().default('INR'),
      currentCtc: z.string().default(''),
      expectedCtc: z.string().default(''),
      minimumAcceptable: z.string().default(''),
      negotiable: z.boolean().default(true),
    })
    .default({}),

  voluntary: VoluntaryDisclosureSchema.default({}),

  /** Free-form facts the model may draw on when answering unusual questions. */
  extraContext: z.string().default(''),

  /** Master resume text: the source of truth for all tailoring. */
  masterResumeText: z.string().default(''),
})

export type Profile = z.infer<typeof ProfileSchema>
export type Experience = z.infer<typeof ExperienceSchema>
export type Education = z.infer<typeof EducationSchema>
export type ProfileLink = z.infer<typeof ProfileLinkSchema>

/* ----------------------------------------------------------------- matching */

export const WorkModeSchema = z.enum(['remote', 'hybrid', 'onsite', 'unknown'])
export const SenioritySchema = z.enum([
  'intern',
  'junior',
  'mid',
  'senior',
  'staff',
  'lead',
  'manager',
  'director',
  'unknown',
])

export const MatchRulesSchema = z.object({
  titleIncludes: z.array(z.string()).default([]),
  titleExcludes: z.array(z.string()).default([]),
  descriptionIncludes: z.array(z.string()).default([]),
  descriptionExcludes: z.array(z.string()).default([]),
  companyBlocklist: z.array(z.string()).default([]),
  companyAllowlist: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  /**
   * Places the user may actually work from, for remote roles.
   *
   * "Remote" is not the same as "remote for you". A sweep that correctly kept
   * only remote jobs still filled up with "Remote - US", "Remote, Japan" and
   * "Remote - Netherlands", none of which an applicant in India can take. When
   * this is set, a remote role has to be open somewhere on this list, or be
   * advertised as global, to survive. Empty means no eligibility check at all.
   */
  remoteEligibility: z.array(z.string()).default([]),
  workModes: z.array(WorkModeSchema).default(['remote', 'hybrid', 'onsite', 'unknown']),
  /**
   * Levels worth applying to, by default everything below management.
   *
   * 'staff' and 'lead' used to be missing, which silently rejected the exact
   * titles an experienced engineer or architect should be seeing: a thirteen
   * year principal architect ran a full sweep and had every single result
   * thrown away with "seniority staff excluded" before it was ever scored.
   * Management levels stay out of the default because wanting to stay
   * hands-on is the more common case, not because they are worse roles.
   */
  seniority: z
    .array(SenioritySchema)
    .default(['junior', 'mid', 'senior', 'staff', 'lead', 'unknown']),
  minSalary: z.number().nullable().default(null),
  salaryCurrency: z.string().default('INR'),
  maxDaysOld: z.number().default(30),
  requireSalaryPosted: z.boolean().default(false),
  excludeIfSponsorshipUnavailable: z.boolean().default(false),
  /** Weights handed to the scorer so the user can say what actually matters. */
  weights: z
    .object({
      titleFit: z.number().default(30),
      skillsOverlap: z.number().default(30),
      seniorityFit: z.number().default(15),
      locationFit: z.number().default(15),
      compensationFit: z.number().default(10),
    })
    .default({}),
})

export type MatchRules = z.infer<typeof MatchRulesSchema>
export type WorkMode = z.infer<typeof WorkModeSchema>
export type Seniority = z.infer<typeof SenioritySchema>

/* ----------------------------------------------------------- search recipes */

export const SearchRecipeSchema = z.object({
  id: z.string(),
  name: z.string().default('Untitled search'),
  enabled: z.boolean().default(true),
  source: z.enum(['greenhouse', 'lever', 'ashby', 'indeed', 'naukri', 'custom']),
  keywords: z.array(z.string()).default([]),
  location: z.string().default(''),
  remoteOnly: z.boolean().default(false),
  /** Board slugs for source-specific crawls, e.g. a Greenhouse company token. */
  boards: z.array(z.string()).default([]),
  /** Fully-formed URLs, used when source is 'custom'. */
  customUrls: z.array(z.string()).default([]),
  maxResultsPerRun: z.number().default(40),
  lastRunAt: z.number().nullable().default(null),
})

export type SearchRecipe = z.infer<typeof SearchRecipeSchema>

/* --------------------------------------------------------------- autonomy */

/**
 * How far the agent goes on its own.
 *
 * 'handoff' exists because several boards will not accept an automated
 * submission at all: Greenhouse, Lever and Ashby all score the session with
 * reCAPTCHA or hCaptcha, and a Greenhouse board refused three applications that
 * were filled perfectly and completely. On those sites the useful division of
 * labour is the agent doing the twenty minutes of form filling and the person
 * pressing the last button, so handoff fills everything, stops at submit, and
 * leaves the finished form on screen.
 */
export const AutonomyModeSchema = z.enum(['dry_run', 'review', 'handoff', 'gated', 'full'])

export const AutonomySchema = z.object({
  /** Master switch. While false, nothing runs unattended. */
  enabled: z.boolean().default(false),
  /** dry_run fills but never submits; review queues everything for one click. */
  mode: AutonomyModeSchema.default('dry_run'),
  minMatchScore: z.number().default(75),
  minFillConfidence: z.number().default(0.85),
  /** Unresolved required fields park the application regardless of mode. */
  requireAllRequiredFields: z.boolean().default(true),
  /**
   * Answer every mandatory question, guessing the most defensible option when
   * nothing else can. A blank mandatory field is not a cautious application,
   * it is a rejected one. Questions about work authorization, sponsorship and
   * credentials are never guessed at, whatever this says.
   */
  answerEverything: z.boolean().default(true),
  /**
   * Trade per-application polish for throughput.
   *
   * The model driver is a single serialised chat session, so every call is on
   * the critical path of the whole run. At the default settings one job costs
   * up to four of them -- score it, answer its fields, tailor a resume, write a
   * cover letter -- which is two to four minutes of pure model time before a
   * page has even loaded, and caps an overnight run at a couple of dozen
   * applications.
   *
   * With this on, the deterministic prefilter decides what to apply to and the
   * model is used only for questions that genuinely need it. That is the right
   * trade when the user's instruction is "apply to everything that matches":
   * scoring only ever removes jobs they already said they wanted.
   */
  volumeMode: z.boolean().default(false),
  maxApplicationsPerDay: z.number().default(15),
  perSiteDailyCap: z.record(z.string(), z.number()).default({
    greenhouse: 20,
    lever: 20,
    ashby: 20,
    workable: 15,
    smartrecruiters: 15,
    workday: 5,
    indeed: 5,
    naukri: 10,
    generic: 5,
  }),
  /** Local-time window in which unattended runs are allowed. */
  activeHours: z.object({ start: z.number().default(9), end: z.number().default(21) }).default({}),
  /**
   * Every day by default. A weekdays-only default meant anyone who installed
   * this on a Saturday found an agent that reported "running" and did nothing.
   */
  activeDays: z.array(z.number()).default([0, 1, 2, 3, 4, 5, 6]),
  /** Randomized pacing, in milliseconds. */
  delayBetweenFieldsMs: z
    .object({ min: z.number().default(120), max: z.number().default(450) })
    .default({}),
  delayBetweenApplicationsMs: z
    .object({ min: z.number().default(45000), max: z.number().default(180000) })
    .default({}),
  /**
   * Hard wall-clock ceiling on one application, in milliseconds.
   *
   * Without it a single model call could own the whole run: the request timeout
   * is three minutes and it is retried twice, then failed over to a second
   * driver, so one unlucky job could sit silent for a quarter of an hour while
   * the agent looked frozen. Five minutes is generous for a form that is going
   * to work and short enough that a job which is not going to work gets out of
   * the way.
   */
  maxApplicationMs: z.number().default(300000),
  /** Halt the whole run after this many consecutive failures. */
  circuitBreakerFailures: z.number().default(3),
  notifyOnSubmit: z.boolean().default(true),
  notifyOnReviewNeeded: z.boolean().default(true),
})

export type Autonomy = z.infer<typeof AutonomySchema>
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>

/* -------------------------------------------------------------- llm config */

export const LlmConfigSchema = z.object({
  driver: z.enum(['deepseek-web', 'anthropic-api', 'openai-compatible', 'nvidia-nim']).default('deepseek-web'),
  apiKey: z.string().default(''),
  apiBaseUrl: z.string().default(''),
  model: z.string().default(''),
  /** Keep the DeepSeek worker window minimized and out of the way. */
  keepWindowMinimized: z.boolean().default(true),
  requestTimeoutMs: z.number().default(180000),
  maxRetries: z.number().default(2),
  /** Start a fresh DeepSeek conversation every N requests to bound context. */
  newChatEveryNRequests: z.number().default(8),
  /**
   * Minimum gap between two prompts on the DeepSeek web driver.
   *
   * The consumer chat product is sized for a person typing, not for a loop.
   * Pacing requests keeps the load we put on it modest, which is both the
   * polite thing to do and what keeps an account in good standing. The
   * supported way to run at speed is DeepSeek's paid API (the
   * "openai-compatible" driver), not a faster scraper.
   */
  minRequestGapMs: z.number().default(5000),
})

export type LlmConfig = z.infer<typeof LlmConfigSchema>

/* --------------------------------------------------------------- documents */

export const DocumentConfigSchema = z.object({
  tailorResume: z.boolean().default(true),
  generateCoverLetter: z.boolean().default(true),
  /** Hard guard: reject tailored output that invents employers, titles or dates. */
  rejectFabrications: z.boolean().default(true),
  resumeTemplate: z.enum(['classic', 'compact']).default('classic'),
  resumeFileNamePattern: z.string().default('{firstName}_{lastName}_Resume.pdf'),
  coverFileNamePattern: z.string().default('{firstName}_{lastName}_Cover_{company}.pdf'),
  coverLetterTone: z.string().default('direct, specific, no filler'),
  maxBulletsPerRole: z.number().default(5),
})

export type DocumentConfig = z.infer<typeof DocumentConfigSchema>

/* ------------------------------------------------------------- prompt bank */

export const PromptTemplatesSchema = z
  .object({
    score: z.string().default(''),
    answerFields: z.string().default(''),
    tailorResume: z.string().default(''),
    coverLetter: z.string().default(''),
    parseResume: z.string().default(''),
    suggestRules: z.string().default(''),
  })
  .default({})

export type PromptTemplates = z.infer<typeof PromptTemplatesSchema>

/* ---------------------------------------------------------------- settings */

export const SettingsSchema = z.object({
  version: z.number().default(1),
  autonomy: AutonomySchema.default({}),
  llm: LlmConfigSchema.default({}),
  documents: DocumentConfigSchema.default({}),
  matchRules: MatchRulesSchema.default({}),
  prompts: PromptTemplatesSchema,
  /** Extra domains the user wants the form agent injected into. */
  customApplyDomains: z.array(z.string()).default([]),
  /** Per-domain selector overrides: domain -> (canonical field key -> selector). */
  selectorOverrides: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  /** Sites the agent is allowed to submit on at all. */
  enabledSites: z.record(z.string(), z.boolean()).default({
    greenhouse: true,
    lever: true,
    ashby: true,
    workable: true,
    smartrecruiters: true,
    workday: false,
    indeed: false,
    naukri: true,
    generic: false,
  }),
  onboardingComplete: z.boolean().default(false),
})

export type Settings = z.infer<typeof SettingsSchema>

/* ------------------------------------------------------------------- jobs */

export const JobStatusSchema = z.enum([
  'new',
  'scored',
  'rejected',
  'queued',
  'applied',
  'failed',
  'skipped',
])

export const JobSchema = z.object({
  id: z.string(),
  source: z.string(),
  vendor: z.string().default('generic'),
  url: z.string(),
  applyUrl: z.string().default(''),
  company: z.string().default(''),
  title: z.string().default(''),
  location: z.string().default(''),
  workMode: WorkModeSchema.default('unknown'),
  salaryText: z.string().default(''),
  salaryMin: z.number().nullable().default(null),
  salaryMax: z.number().nullable().default(null),
  postedAt: z.number().nullable().default(null),
  descriptionText: z.string().default(''),
  /**
   * Where the description came from.
   *
   * Listing cards carry a one-line snippet; hydration (or the apply page
   * itself) replaces it with the real posting. The prefilter cannot judge
   * "must mention" rules against a snippet, so it defers them instead of
   * rejecting nearly everything.
   */
  descriptionSource: z.enum(['snippet', 'hydrated', 'apply_page']).default('hydrated'),
  dedupeHash: z.string(),
  status: JobStatusSchema.default('new'),
  matchScore: z.number().nullable().default(null),
  matchReasons: z.array(z.string()).default([]),
  matchConcerns: z.array(z.string()).default([]),
  rejectReason: z.string().default(''),
  discoveredAt: z.number(),
  scoredAt: z.number().nullable().default(null),
  recipeId: z.string().default(''),
  /**
   * The posting is Indeed Easy Apply: the form is hosted by Indeed and
   * prefilled from the user's account, so it costs seconds rather than a full
   * form-filling pass. The runner works through these first.
   */
  easyApply: z.boolean().default(false),
})

export type Job = z.infer<typeof JobSchema>
export type JobStatus = z.infer<typeof JobStatusSchema>

/* ------------------------------------------------------------ applications */

export const FieldKindSchema = z.enum([
  'text',
  'textarea',
  'email',
  'tel',
  'url',
  'number',
  'date',
  'select',
  'radio',
  'checkbox',
  'file',
  'combobox',
  'unknown',
])

export const FieldDescriptorSchema = z.object({
  selector: z.string(),
  frameId: z.number().default(0),
  kind: FieldKindSchema,
  label: z.string().default(''),
  normalizedLabel: z.string().default(''),
  placeholder: z.string().default(''),
  name: z.string().default(''),
  id: z.string().default(''),
  required: z.boolean().default(false),
  options: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
  currentValue: z.string().default(''),
  maxLength: z.number().nullable().default(null),
  /** Radio and checkbox members of the same question share a group key. */
  group: z.string().default(''),
})

export type FieldDescriptor = z.infer<typeof FieldDescriptorSchema>
export type FieldKind = z.infer<typeof FieldKindSchema>

export const FillSourceSchema = z.enum([
  'adapter',
  'answer_bank',
  'llm',
  'profile',
  'user',
  'default',
  /** Last-resort answer chosen so a mandatory question is not left blank. */
  'guess',
])

export const FilledFieldSchema = z.object({
  selector: z.string(),
  label: z.string(),
  kind: z.string(),
  value: z.string(),
  confidence: z.number(),
  source: FillSourceSchema,
  reasoning: z.string().default(''),
  verified: z.boolean().default(false),
  error: z.string().default(''),
  required: z.boolean().default(false),
})

export type FilledField = z.infer<typeof FilledFieldSchema>
export type FillSource = z.infer<typeof FillSourceSchema>

export const TimelineEventSchema = z.object({
  at: z.number(),
  step: z.string(),
  detail: z.string().default(''),
  level: z.enum(['info', 'warn', 'error']).default('info'),
})

export const ApplicationStatusSchema = z.enum([
  'queued',
  'running',
  'needs_review',
  'submitted',
  'failed',
  'skipped',
  'dry_run',
])

export const ApplicationSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  company: z.string().default(''),
  title: z.string().default(''),
  url: z.string().default(''),
  vendor: z.string().default('generic'),
  status: ApplicationStatusSchema.default('queued'),
  fillPlan: z.array(FilledFieldSchema).default([]),
  unresolved: z.array(FieldDescriptorSchema).default([]),
  confidence: z.number().default(0),
  matchScore: z.number().nullable().default(null),
  docs: z
    .object({
      resumeDocId: z.string().default(''),
      coverDocId: z.string().default(''),
      coverLetterText: z.string().default(''),
    })
    .default({}),
  timeline: z.array(TimelineEventSchema).default([]),
  attempts: z.number().default(0),
  error: z.string().default(''),
  createdAt: z.number(),
  updatedAt: z.number(),
  submittedAt: z.number().nullable().default(null),
})

export type Application = z.infer<typeof ApplicationSchema>
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>
export type TimelineEvent = z.infer<typeof TimelineEventSchema>

/* ------------------------------------------------------------- answer bank */

export const AnswerBankEntrySchema = z.object({
  id: z.string(),
  qNormalized: z.string(),
  label: z.string(),
  kind: z.string().default('text'),
  value: z.string(),
  source: z.enum(['profile', 'llm', 'user', 'adapter']).default('user'),
  /** Optional scope: reuse this answer only on a given vendor or company. */
  scope: z.string().default(''),
  usageCount: z.number().default(0),
  lastUsed: z.number().nullable().default(null),
  createdAt: z.number(),
  pinned: z.boolean().default(false),
})

export type AnswerBankEntry = z.infer<typeof AnswerBankEntrySchema>

/* --------------------------------------------------------- stored document */

export const StoredDocSchema = z.object({
  id: z.string(),
  kind: z.enum(['resume', 'cover_letter', 'other']),
  fileName: z.string(),
  mimeType: z.string().default('application/pdf'),
  jobId: z.string().default(''),
  createdAt: z.number(),
  sizeBytes: z.number().default(0),
})

export type StoredDoc = z.infer<typeof StoredDocSchema>

/* -------------------------------------------------------------- event log */

export const LogEventSchema = z.object({
  id: z.string(),
  at: z.number(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  scope: z.string(),
  message: z.string(),
  data: z.unknown().optional(),
  jobId: z.string().default(''),
})

export type LogEvent = z.infer<typeof LogEventSchema>

/* ------------------------------------------------ llm structured responses */

export const ScoreResponseSchema = z.object({
  score: z.number().min(0).max(100),
  shouldApply: z.boolean(),
  reasons: z.array(z.string()).default([]),
  concerns: z.array(z.string()).default([]),
  seniority: z.string().default('unknown'),
})

export const FieldAnswerSchema = z.object({
  selector: z.string(),
  value: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().default(''),
  /** Set when only the user can answer this honestly. */
  needsHuman: z.boolean().default(false),
})

export const FieldAnswersResponseSchema = z.object({
  answers: z.array(FieldAnswerSchema).default([]),
})

export const TailoredResumeSchema = z.object({
  summary: z.string().default(''),
  roles: z
    .array(
      z.object({
        id: z.string(),
        bullets: z.array(z.string()).default([]),
      })
    )
    .default([]),
  skillsOrder: z.array(z.string()).default([]),
})

export const CoverLetterSchema = z.object({
  body: z.string(),
})

/**
 * A resume read back as structure.
 *
 * Every field is optional with an empty default, because a parser that invents
 * a plausible value to satisfy a required field is worse than one that admits
 * the document did not say. Empty means "not stated", and the merge leaves the
 * profile alone wherever it sees one.
 */
export const ParsedResumeSchema = z.object({
  firstName: z.string().default(''),
  lastName: z.string().default(''),
  email: z.string().default(''),
  phone: z.string().default(''),
  phoneCountryCode: z.string().default(''),
  city: z.string().default(''),
  state: z.string().default(''),
  country: z.string().default(''),
  headline: z.string().default(''),
  summary: z.string().default(''),
  currentTitle: z.string().default(''),
  currentCompany: z.string().default(''),
  yearsExperience: z.number().default(0),
  linkedin: z.string().default(''),
  github: z.string().default(''),
  portfolio: z.string().default(''),
  skills: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  certifications: z.array(z.string()).default([]),
  experience: z
    .array(
      z.object({
        company: z.string().default(''),
        title: z.string().default(''),
        location: z.string().default(''),
        startDate: z.string().default(''),
        endDate: z.string().default(''),
        current: z.boolean().default(false),
        bullets: z.array(z.string()).default([]),
        tech: z.array(z.string()).default([]),
      })
    )
    .default([]),
  education: z
    .array(
      z.object({
        school: z.string().default(''),
        degree: z.string().default(''),
        field: z.string().default(''),
        startDate: z.string().default(''),
        endDate: z.string().default(''),
        gpa: z.string().default(''),
      })
    )
    .default([]),
  workAuthorization: z
    .object({
      authorizedInCountries: z.array(z.string()).default([]),
      requiresSponsorship: z.boolean().nullable().default(null),
    })
    .default({}),
})

export type ParsedResume = z.infer<typeof ParsedResumeSchema>

/** Search and matching rules proposed from a profile. */
export const SuggestedRulesSchema = z.object({
  titleIncludes: z.array(z.string()).default([]),
  titleExcludes: z.array(z.string()).default([]),
  descriptionIncludes: z.array(z.string()).default([]),
  seniority: z.array(z.string()).default([]),
  searchKeywords: z.array(z.string()).default([]),
  greenhouseBoards: z.array(z.string()).default([]),
  leverBoards: z.array(z.string()).default([]),
  rationale: z.string().default(''),
})

export type SuggestedRules = z.infer<typeof SuggestedRulesSchema>

export type ScoreResponse = z.infer<typeof ScoreResponseSchema>
export type FieldAnswer = z.infer<typeof FieldAnswerSchema>
export type FieldAnswersResponse = z.infer<typeof FieldAnswersResponseSchema>
export type TailoredResume = z.infer<typeof TailoredResumeSchema>
export type CoverLetter = z.infer<typeof CoverLetterSchema>
