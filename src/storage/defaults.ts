/**
 * Default prompt templates and seed data.
 *
 * Every prompt here is user-editable from the options page. They are written
 * for a model being driven through a chat UI, which means two things:
 * the output contract has to be stated bluntly and repeated, and the prompt has
 * to survive being pasted as a single message with no system role.
 *
 * Available placeholders are listed above each template; renderTemplate fills
 * them and silently drops unknown ones.
 */

import type { SearchRecipe } from './schemas'

/** Appended to every structured request so the reply is machine-parseable. */
export const JSON_CONTRACT = `
OUTPUT CONTRACT - follow exactly:
- Reply with exactly one fenced code block tagged json, and nothing else.
- No preamble, no explanation, no commentary before or after the block.
- The JSON must parse with JSON.parse on the first attempt.
- Use double quotes for all keys and string values. No trailing commas. No comments.
- If you are unsure of a value, still return valid JSON and signal uncertainty with the provided confidence field.
`.trim()

/**
 * Placeholders: {profile}, {rules}, {weights}, {title}, {company}, {location},
 * {salary}, {description}
 */
export const DEFAULT_SCORE_PROMPT = `
You are screening a job posting on behalf of a candidate. Decide how well it fits and whether applying is worth their time.

CANDIDATE PROFILE
{profile}

CANDIDATE RULES AND PREFERENCES
{rules}

SCORING WEIGHTS (out of 100 total)
{weights}

JOB POSTING
Title: {title}
Company: {company}
Location: {location}
Compensation: {salary}

Description:
{description}

HOW TO SCORE
- Score 0-100 using the weights above. Be strict: 80+ means the candidate is a genuinely strong applicant, not merely eligible.
- Penalise heavily when the posting requires years of experience well beyond the candidate's, demands a credential they lack, or is in a specialisation they have never worked in.
- Do not penalise for missing buzzwords the candidate plainly has under another name.
- "shouldApply" is true only when the score clears 70 AND nothing in "concerns" is disqualifying (for example: requires a security clearance, on-site in a city the candidate excluded, or explicitly no sponsorship when the candidate needs it).
- "reasons" and "concerns" are short factual phrases, at most 12 words each, at most 4 of each.
- "seniority" is one of: intern, junior, mid, senior, staff, lead, manager, director, unknown.

Return JSON of exactly this shape:
{"score": 0, "shouldApply": false, "reasons": [], "concerns": [], "seniority": "unknown"}
`.trim()

/**
 * Placeholders: {profile}, {job}, {fields}, {answerBank}
 */
export const DEFAULT_ANSWER_FIELDS_PROMPT = `
You are filling in a job application form on behalf of a candidate. You are given the candidate's data and a list of form fields that could not be resolved automatically. Produce a value for each field.

CANDIDATE PROFILE
{profile}

JOB BEING APPLIED TO
{job}

ANSWERS THE CANDIDATE HAS GIVEN BEFORE (reuse these verbatim when the question matches)
{answerBank}

FIELDS TO ANSWER
{fields}

RULES - these matter more than completeness
- NEVER invent a fact about the candidate. No employers, titles, dates, degrees, certifications, salary figures, visa statuses or years of experience that are not in the profile above.
- If a field asks for something the profile does not contain and it cannot be safely inferred, set "needsHuman": true, give your best guess as "value", and set confidence below 0.4. A parked field costs the candidate ten seconds; a fabricated answer costs them the job.
- For a select, radio or checkbox field, "value" MUST be exactly one of the option labels given for that field. Never invent an option.
- For a checkbox with no options listed, use "true" or "false".
- For yes/no questions about work authorisation, sponsorship, relocation or notice period, answer strictly from the profile's workAuthorization block.
- For salary and compensation fields, use the profile's compensation block. If it asks for a number only, give digits with no currency symbol or separators.
- For open text questions ("why do you want to work here", "tell us about a project"), write 3-6 sentences in the candidate's voice: concrete, specific to this company and role, drawing only on real profile details. No superlatives, no filler, no "I am passionate about".
- Respect any maxLength given for a field.
- "confidence" is your honest probability that a careful human would write the same thing: 0.9+ for direct profile lookups, 0.6-0.8 for reasonable inference, below 0.4 for guesses.
- Return one entry per field, using the exact "selector" string given.

Return JSON of exactly this shape:
{"answers": [{"selector": "", "value": "", "confidence": 0.0, "reasoning": "", "needsHuman": false}]}
`.trim()

/**
 * Placeholders: {profile}, {job}, {roles}, {maxBullets}
 */
export const DEFAULT_TAILOR_RESUME_PROMPT = `
You are re-emphasising a candidate's existing resume for one specific job. You are NOT writing a new resume and you are NOT allowed to add experience.

CANDIDATE PROFILE
{profile}

EXISTING ROLES AND THEIR REAL BULLETS
{roles}

TARGET JOB
{job}

RULES - violating any of these makes the output unusable
- Every bullet you return must be a rewrite of a bullet that already exists for that role. You may reorder, re-emphasise, sharpen wording, surface a metric already present, and drop bullets that are irrelevant to this job. You may NOT introduce a new project, technology, employer, metric, or claim.
- Never change an employer name, job title, or date.
- Do not exceed {maxBullets} bullets per role. Fewer is fine.
- Each bullet: one line, starts with a strong past-tense verb (present tense for a current role), includes a concrete outcome or number when the original had one, no more than 30 words.
- No adjectives about the candidate ("passionate", "hard-working", "detail-oriented"). No first person pronouns.
- "summary" is 2-3 sentences positioning the candidate for THIS role using only real profile facts. It may mention the target role title.
- "skillsOrder" reorders the candidate's existing skills so the ones this job asks for come first. Do not add skills the candidate does not list.
- Return every role id you were given, in the same order.

Return JSON of exactly this shape:
{"summary": "", "roles": [{"id": "", "bullets": []}], "skillsOrder": []}
`.trim()

/**
 * Placeholders: {profile}, {job}, {tone}, {company}, {title}
 */
export const DEFAULT_COVER_LETTER_PROMPT = `
Write a cover letter for this candidate applying to this role.

CANDIDATE PROFILE
{profile}

TARGET JOB
{job}

RULES
- Tone: {tone}.
- 200-280 words. Four short paragraphs at most.
- Open with the specific reason this role and this company are a fit - reference something concrete from the posting, not the company's general reputation.
- Middle paragraphs: two specific, real accomplishments from the profile that map onto what the posting asks for. Name the technology or the outcome.
- Close with a short, non-grovelling line about next steps.
- Never invent a fact, a metric, a mutual connection, or a reason for leaving a job.
- No "I am writing to apply for", no "I believe I would be a great fit", no "passionate", no "dear hiring manager" salutation - the body only, starting from the first real sentence. The template adds the greeting and sign-off.
- Plain prose. No bullet points, no headings, no markdown.

Return JSON of exactly this shape:
{"body": ""}
`.trim()

/**
 * Placeholders: {resume}
 */
export const DEFAULT_PARSE_RESUME_PROMPT = `
Read this resume and return it as structured data. You are transcribing, not writing.

RESUME
{resume}

RULES - these matter more than completeness
- Report ONLY what the document states. If it does not give a phone number, a city, or a GPA, return an empty string for that field. Never infer, never guess, never fill a field to be helpful. An empty field is obvious to the user; a wrong one is not.
- Copy bullets verbatim from the document. Do not rewrite, summarise, improve, shorten or merge them. Strip only the leading bullet character and surrounding whitespace.
- Dates are YYYY-MM. If only a year is given, use YYYY-01. If a role is ongoing ("Present", "Current"), set "current": true and leave "endDate" empty.
- "yearsExperience" is total professional experience in whole years. Compute it from the employment dates. If the resume states a different figure explicitly, prefer the stated one. Return 0 if you cannot work it out from the dates.
- "headline" is the one-line title under the person's name, if there is one. "summary" is the opening profile or objective paragraph, copied as written. Both empty if absent.
- "currentTitle" and "currentCompany" come from the most recent role.
- Split the full name into first and last. For a name with more than two parts, the last word is the last name and everything before it is the first name.
- For "phoneCountryCode", return the dialling prefix with a plus sign if the number includes one, otherwise empty. "phone" is the number without that prefix.
- Links: return full URLs. If the resume shows a bare handle, expand it into the usual URL for that site.
- "skills" are the technologies and competencies listed as skills. Do not invent skills from prose or infer them from job titles.
- "workAuthorization.authorizedInCountries" is only populated when the resume explicitly states work authorisation or citizenship. "requiresSponsorship" is true or false only when the document says so outright, otherwise null.
- List experience newest first. Include every role, including internships.

Return JSON of exactly this shape:
{"firstName": "", "lastName": "", "email": "", "phone": "", "phoneCountryCode": "", "city": "", "state": "", "country": "", "headline": "", "summary": "", "currentTitle": "", "currentCompany": "", "yearsExperience": 0, "linkedin": "", "github": "", "portfolio": "", "skills": [], "languages": [], "certifications": [], "experience": [{"company": "", "title": "", "location": "", "startDate": "", "endDate": "", "current": false, "bullets": [], "tech": []}], "education": [{"school": "", "degree": "", "field": "", "startDate": "", "endDate": "", "gpa": ""}], "workAuthorization": {"authorizedInCountries": [], "requiresSponsorship": null}}
`.trim()

/**
 * Placeholders: {profile}
 */
export const DEFAULT_SUGGEST_RULES_PROMPT = `
Propose job search and filtering rules for this candidate, based on what they have actually done.

CANDIDATE PROFILE
{profile}

RULES
- "titleIncludes" are title keywords worth searching for: the roles this person would plausibly be hired into today, not aspirational ones. Between 3 and 8 entries, lowercase, no seniority prefixes (the seniority list handles that separately).
- "titleExcludes" are titles that would waste their time: adjacent specialisations they have no background in, and levels far below where they are now. Between 3 and 8 entries.
- "descriptionIncludes" are at most 4 technologies or domains central enough that a posting not mentioning any of them is probably a poor fit. Leave empty if nothing is that central.
- "seniority" is the levels worth considering, drawn from: intern, junior, mid, senior, staff, lead, manager, director. Include the level they are at now and one either side where that makes sense. Never include a level more than one step above their current one.
- "searchKeywords" are 2 to 4 phrases to type into a job board search.
- "greenhouseBoards" and "leverBoards" are company slugs for boards worth watching, drawn from companies similar to where this person has worked or in the same domain. Use the slug as it appears in the board URL (lowercase, no spaces). At most 8 each, and leave them empty rather than guessing at slugs you are not confident about - a wrong slug just returns nothing.
- "rationale" is one or two sentences explaining the shape of what you proposed.

Return JSON of exactly this shape:
{"titleIncludes": [], "titleExcludes": [], "descriptionIncludes": [], "seniority": [], "searchKeywords": [], "greenhouseBoards": [], "leverBoards": [], "rationale": ""}
`.trim()

export const DEFAULT_PROMPTS = {
  score: DEFAULT_SCORE_PROMPT,
  answerFields: DEFAULT_ANSWER_FIELDS_PROMPT,
  tailorResume: DEFAULT_TAILOR_RESUME_PROMPT,
  coverLetter: DEFAULT_COVER_LETTER_PROMPT,
  parseResume: DEFAULT_PARSE_RESUME_PROMPT,
  suggestRules: DEFAULT_SUGGEST_RULES_PROMPT,
}

/**
 * No seed searches.
 *
 * Shipping three disabled examples aimed at companies the user has never
 * mentioned looked like a starting point and was really just noise: they had to
 * be understood, edited and switched on before anything worked, and a
 * half-configured search that is switched on is worse than none. The Searches
 * page builds real ones from the profile in one click instead.
 */
export function seedRecipes(): SearchRecipe[] {
  return []
}

/** Answers almost every ATS asks for, seeded from the profile on first run. */
export const COMMON_QUESTION_SEEDS: Array<{ label: string; profileKey: string }> = [
  { label: 'First name', profileKey: 'firstName' },
  { label: 'Last name', profileKey: 'lastName' },
  { label: 'Email', profileKey: 'email' },
  { label: 'Phone', profileKey: 'phone' },
  { label: 'City', profileKey: 'city' },
  { label: 'State', profileKey: 'state' },
  { label: 'Country', profileKey: 'country' },
  { label: 'Postal code', profileKey: 'postalCode' },
  { label: 'LinkedIn profile', profileKey: 'linkedin' },
  { label: 'GitHub profile', profileKey: 'github' },
  { label: 'Portfolio website', profileKey: 'portfolio' },
  { label: 'Current company', profileKey: 'currentCompany' },
  { label: 'Current title', profileKey: 'currentTitle' },
]
