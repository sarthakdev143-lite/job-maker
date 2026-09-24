/**
 * What a job-board aggregator does to a sweep.
 *
 * A remote-India search of the Workable index returned forty postings that all
 * passed every rule. Twenty-three of them came from one account reposting other
 * companies' vacancies: transcription work in seven languages, an FP&A role, an
 * operations specialist. They were legitimate remote postings in the right
 * country, they crowded out the real employers behind them, and each one cost a
 * model call to reject at single digits.
 *
 * Two defences, tested here: recognise the professions they belong to, and stop
 * any one employer taking the whole run.
 */

import { describe, expect, it } from 'vitest'
import { detectFunction, wrongProfession } from '@/matching/function-fit'

const ENGINEER = ['Senior Software Engineer', 'Technical Architect']

describe('the professions an aggregator posts', () => {
  it('recognises annotation and transcription work', () => {
    expect(detectFunction('PDF Annotation & Transcription Experts - Bengali')).toBe('annotation')
    expect(detectFunction('Generalist (AI Training Specialist)')).toBe('annotation')
    expect(detectFunction('Content Moderation Associate')).toBe('annotation')
    expect(detectFunction('Data Entry Executive')).toBe('annotation')
  })

  it('recognises back-office operations roles', () => {
    expect(detectFunction('Operations Specialist')).toBe('operations')
    expect(detectFunction('Executive Assistant')).toBe('operations')
    expect(detectFunction('Business Operations Manager')).toBe('operations')
  })

  it('recognises finance roles written the way a posting writes them', () => {
    expect(detectFunction('Financial Planning & Analysis')).toBe('finance')
    expect(detectFunction('Finance Manager')).toBe('finance')
  })

  it('drops them for an engineer without a model call', () => {
    expect(wrongProfession('PDF Annotation & Transcription Experts - Telugu', ENGINEER)).toBe('annotation')
    expect(wrongProfession('Operations Specialist', ENGINEER)).toBe('operations')
    expect(wrongProfession('Financial Planning & Analysis', ENGINEER)).toBe('finance')
  })
})

describe('what the new families must not swallow', () => {
  it('leaves engineering titles that merely contain an operations word', () => {
    // Engineering is matched first precisely so these survive.
    expect(detectFunction('Site Reliability Engineer II')).toBe('engineering')
    expect(detectFunction('DevOps Engineer')).toBe('engineering')
    expect(detectFunction('Platform Operations Engineer')).toBe('engineering')
    expect(detectFunction('Machine Learning Engineer, Training Infrastructure')).toBe('engineering')
  })

  it('keeps a data engineer away from the annotation family', () => {
    expect(detectFunction('Data Engineer II')).toBe('engineering')
    expect(wrongProfession('Data Engineer II', ENGINEER)).toBeNull()
  })

  it('still lets an unfamiliar title through to be scored properly', () => {
    expect(detectFunction('FMCG Power BI')).toBe('unknown')
    expect(wrongProfession('FMCG Power BI', ENGINEER)).toBeNull()
  })
})
