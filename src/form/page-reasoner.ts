/**
 * Asking the model to read a page the selectors could not.
 *
 * Every site adapter in this extension is a list of CSS selectors, and every
 * one of them is a bet that the markup has not changed since it was written.
 * Those bets lose: Indeed rotates its generated class names, a company puts its
 * own careers page in front of an Ashby board, Naukri renames a button. When
 * one loses, the adapter says "no application form found" and a job that would
 * have worked is skipped for ever.
 *
 * This is the tier below the selectors. It is never the first thing tried --
 * selectors are free and instant, and on a site that still matches they are
 * also more accurate than a small model reading a list. It runs only where the
 * adapter has already given up, which is exactly where a skipped job would
 * otherwise be the outcome.
 *
 * Two questions are asked, and only these two, because they are the two that
 * decide whether an application happens at all:
 *
 *   - which control on this page starts the application?
 *   - did the thing I just clicked actually submit it?
 *
 * The model answers with a reference number from the outline, never a selector
 * of its own invention. A number can be checked against the list it came from;
 * a string has to be trusted.
 */

import { z } from 'zod'

import { llm } from '@/llm/broker'
import { createLogger } from '@/shared/logger'
import type { PageOutline } from './outline'
import { renderOutline } from './outline'

const log = createLogger('page-reasoner')

/* ------------------------------------------------------------- schemas */

export const ApplyControlSchema = z.object({
  /** The outline reference of the control, or 0 for "none of these". */
  ref: z.number().default(0),
  confidence: z.number().min(0).max(1).default(0),
  reasoning: z.string().default(''),
})

export const NextControlSchema = z.object({
  /** The outline reference of the control that moves the form on, or 0. */
  ref: z.number().default(0),
  confidence: z.number().min(0).max(1).default(0),
  /** True when this control finishes the application rather than continuing. */
  submits: z.boolean().default(false),
  reasoning: z.string().default(''),
})

export const SubmissionVerdictSchema = z.object({
  /** submitted | rejected | in_progress | unknown */
  state: z.string().default('unknown'),
  confidence: z.number().min(0).max(1).default(0),
  /** The wording on the page that decided it. */
  evidence: z.string().default(''),
})

export type ApplyControl = z.infer<typeof ApplyControlSchema>
export type NextControl = z.infer<typeof NextControlSchema>
export type SubmissionVerdict = z.infer<typeof SubmissionVerdictSchema>

/* ------------------------------------------------------- apply control */

export type ApplyControlResult = {
  /** The selector to click, or '' when the model found nothing. */
  selector: string
  ref: number
  confidence: number
  reasoning: string
  /** The words on the chosen control, for the log and the timeline. */
  text: string
}

/**
 * Below this the model is guessing, and clicking a guess on a job board is how
 * an agent ends up on a "report this listing" dialog.
 */
export const APPLY_CONTROL_THRESHOLD = 0.6

/**
 * Which control on this page starts an application?
 *
 * Returns an empty selector rather than throwing when nothing qualifies: "this
 * page has no apply button" is a real and common answer -- an expired listing,
 * a login wall, a search results page reached by a stale link -- and it is not
 * an error.
 */
export async function findApplyControl(
  outline: PageOutline,
  job: { title: string; company: string } | null
): Promise<ApplyControlResult> {
  const none: ApplyControlResult = { selector: '', ref: 0, confidence: 0, reasoning: '', text: '' }
  if (outline.elements.length === 0) return { ...none, reasoning: 'nothing interactive on the page' }

  const prompt = [
    'You are looking at a job posting page. Find the single control that starts an application.',
    '',
    job ? `The job is "${job.title}" at "${job.company}".` : '',
    '',
    renderOutline(outline),
    '',
    'Rules:',
    '- Answer with the [number] of the control that begins applying for THIS job.',
    '- Prefer a control that applies directly on this site over one that sends the user to another site.',
    '- A control that saves, shares, reports, signs in, or applies to a DIFFERENT job is not the answer.',
    '- If the application has already been submitted, or no control starts one, answer ref 0.',
    '- confidence is 0 to 1. Use below 0.5 when you are not sure it is an apply control.',
  ]
    .filter(Boolean)
    .join('\n')

  const answer = await llm.completeStructured(
    { prompt, schema: ApplyControlSchema, freshContext: true },
    'find the apply control'
  )

  const chosen = outline.elements.find((e) => e.ref === answer.ref)
  if (!chosen) {
    // ref 0, or a number the model invented. Both mean "no usable answer", and
    // inventing a selector from a bad ref is how a wrong button gets clicked.
    if (answer.ref !== 0) {
      log.warn(`Model chose ref ${answer.ref}, which is not in the outline; treating as no match`)
    }
    return { ...none, confidence: answer.confidence, reasoning: answer.reasoning }
  }

  if (chosen.disabled) {
    return { ...none, confidence: 0, reasoning: `chose "${chosen.text}", which is disabled` }
  }

  return {
    selector: chosen.selector,
    ref: chosen.ref,
    confidence: answer.confidence,
    reasoning: answer.reasoning,
    text: chosen.text,
  }
}

/* ---------------------------------------------------------- submission */

export type SubmissionReading = {
  submitted: boolean
  /** submitted | rejected | in_progress | unknown */
  state: string
  confidence: number
  evidence: string
}

/**
 * A submission is only recorded on a confident yes.
 *
 * The asymmetry is deliberate. Recording a submission that did not happen
 * silently drops a job the user wanted and inflates the daily counter; failing
 * to record one that did costs a review the user can resolve in a second. So
 * the bar for "yes" is high and the fallback is always human review.
 */
export const SUBMISSION_THRESHOLD = 0.7

/**
 * Did the application actually go through?
 *
 * Asked only when the adapter's own confirmation selectors and success phrases
 * found nothing -- which happens constantly, because every ATS words its
 * confirmation differently and a regex list only ever covers the ones somebody
 * has already seen.
 */
export async function readSubmissionState(outline: PageOutline): Promise<SubmissionReading> {
  const prompt = [
    'An application form was just submitted on this page. Read the page and say what happened.',
    '',
    renderOutline(outline),
    '',
    'Answer with one state:',
    '- "submitted": the page confirms the application was received or sent.',
    '- "rejected": the page is showing validation errors, a required field, or a failure.',
    '- "in_progress": the form is still open, or this is another step of it.',
    '- "unknown": the page does not say either way.',
    '',
    'evidence must quote the exact wording on the page that decided it, or be empty.',
    'confidence is 0 to 1. A confirmation you had to infer is below 0.7.',
  ].join('\n')

  const answer = await llm.completeStructured(
    { prompt, schema: SubmissionVerdictSchema, freshContext: true },
    'read the submission state'
  )

  const state = answer.state.trim().toLowerCase()
  return {
    submitted: state === 'submitted' && answer.confidence >= SUBMISSION_THRESHOLD,
    state,
    confidence: answer.confidence,
    evidence: answer.evidence.slice(0, 300),
  }
}

/* ------------------------------------------------------ advancing a form */

export type NextControlResult = {
  selector: string
  confidence: number
  /** True when the model believes this control sends the application. */
  submits: boolean
  reasoning: string
  text: string
}

/**
 * The bar for continuing is the same as for applying, and for the same reason:
 * a wrong click on a multi-step form is a wrong answer sent in the user's name.
 */
export const NEXT_CONTROL_THRESHOLD = 0.6

/**
 * Which control moves this form on to the next step?
 *
 * Needed because a wizard is where hardcoded lists fail worst. Naukri drives
 * its whole application through a chat drawer whose controls are the answers
 * themselves; Indeed relabels one button at every step. A list of selectors and
 * a regex for the word "continue" covers neither, and when it misses the
 * application stops halfway with everything filled in and nothing sent.
 *
 * `submits` is asked separately and on purpose. The caller must be able to tell
 * "press this to continue" from "press this to send it", because the second one
 * has to go through the autonomy gate first.
 */
export async function findNextControl(
  outline: PageOutline,
  answered: number
): Promise<NextControlResult> {
  const none: NextControlResult = { selector: '', confidence: 0, submits: false, reasoning: '', text: '' }
  if (outline.elements.length === 0) return { ...none, reasoning: 'nothing interactive on the page' }

  const prompt = [
    'You are partway through filling in a job application. The form did not move when the usual',
    `continue button was looked for. ${answered} field(s) have been filled on this step.`,
    '',
    renderOutline(outline),
    '',
    'Rules:',
    '- Answer with the [number] of the control that moves this application forward.',
    '- Set submits true ONLY if that control sends the finished application.',
    '- A control that cancels, saves a draft, goes back, closes, or leaves the form is not the answer.',
    '- If nothing moves the form forward, answer ref 0.',
    '- confidence is 0 to 1.',
  ].join('\n')

  const answer = await llm.completeStructured(
    { prompt, schema: NextControlSchema, freshContext: true },
    'find the continue control'
  )

  const chosen = outline.elements.find((e) => e.ref === answer.ref)
  if (!chosen || chosen.disabled) {
    return { ...none, confidence: answer.confidence, reasoning: answer.reasoning }
  }

  return {
    selector: chosen.selector,
    confidence: answer.confidence,
    submits: answer.submits,
    reasoning: answer.reasoning,
    text: chosen.text,
  }
}
