/**
 * Typing plans and the DOM writer.
 *
 * The plan assertions are the load-bearing ones: a plan that does not reproduce
 * its text exactly, or that runs past its budget, is a silently corrupted
 * application or a run that takes hours instead of minutes.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_TYPING, planTyping, replay, typeInto, typingOptionsFor } from '@/human/typing'
import { derivePersona } from '@/human/persona'
import { seededRng } from '@/human/rng'

const total = (steps: { delayMs: number }[]) => steps.reduce((n, s) => n + s.delayMs, 0)

describe('planTyping', () => {
  it('reproduces the text exactly', () => {
    const text = 'Answer with JSON only. Do not add commentary.\nField: years_experience'
    expect(replay(planTyping(text, {}, seededRng(7)))).toBe(text)
  })

  it('starts immediately and stays inside the time budget', () => {
    const steps = planTyping('x'.repeat(400), {}, seededRng(11))
    expect(steps[0].delayMs).toBe(0)
    expect(total(steps)).toBeLessThanOrEqual(DEFAULT_TYPING.budgetMs)
  })

  it('keeps a long prompt inside the budget instead of typing for minutes', () => {
    const long = 'The quick brown fox jumps over the lazy dog. '.repeat(200)
    const steps = planTyping(long, {}, seededRng(3))
    expect(replay(steps)).toBe(long)
    expect(total(steps)).toBeLessThanOrEqual(DEFAULT_TYPING.budgetMs)
  })

  it('produces irregular gaps rather than a fixed cadence', () => {
    const steps = planTyping('Hello there, this is a fairly ordinary sentence.', {}, seededRng(23))
    const gaps = steps.slice(1).map((s) => s.delayMs)
    expect(gaps.length).toBeGreaterThan(2)
    expect(new Set(gaps).size).toBeGreaterThan(1)
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(0)
  })

  it('breaks the text into several bursts, not one paste', () => {
    const steps = planTyping('Software engineer with four years of experience.', {}, seededRng(5))
    expect(steps.length).toBeGreaterThan(3)
  })

  it('corrects its own typos back to the exact text', () => {
    const text = 'senior backend engineer with distributed systems experience'
    const steps = planTyping(text, { typoChance: 0.9 }, seededRng(19))
    expect(steps.some((s) => s.backspaces)).toBe(true)
    expect(replay(steps)).toBe(text)
  })

  it('never types a typo it does not take back', () => {
    for (let seed = 1; seed < 40; seed++) {
      const text = 'reasonable answer about relocation and notice period'
      expect(replay(planTyping(text, { typoChance: 0.5 }, seededRng(seed)))).toBe(text)
    }
  })

  it('returns nothing for empty text', () => {
    expect(planTyping('')).toEqual([])
  })
})

describe('typingOptionsFor', () => {
  it('scales cadence by the persona and preserves caller options', () => {
    const persona = derivePersona('greenhouse.io|salt')
    const opts = typingOptionsFor(persona, { budgetMs: 1000, commit: false })
    expect(opts.commit).toBe(false)
    expect(opts.minStepMs).toBe(Math.round(DEFAULT_TYPING.minStepMs * persona.typingSpeed))
    expect(opts.budgetMs).toBe(Math.round(1000 * persona.typingBudget))
  })

  it('honours an explicit request for no typos', () => {
    expect(typingOptionsFor(derivePersona('x'), { typoChance: 0 }).typoChance).toBe(0)
  })
})

describe('typeInto', () => {
  it('ends with the exact value and fires many input events', async () => {
    document.body.innerHTML = '<input id="f" />'
    const el = document.getElementById('f') as HTMLInputElement
    let inputs = 0
    el.addEventListener('input', () => inputs++)

    const ok = await typeInto(el, 'Bengaluru, India', { budgetMs: 60 }, seededRng(2))

    expect(ok).toBe(true)
    expect(el.value).toBe('Bengaluru, India')
    expect(inputs).toBeGreaterThan(3)
  })

  it('replaces whatever the field already held', async () => {
    document.body.innerHTML = '<textarea id="t">old answer</textarea>'
    const el = document.getElementById('t') as HTMLTextAreaElement
    await typeInto(el, 'new answer', { budgetMs: 40 }, seededRng(4))
    expect(el.value).toBe('new answer')
  })

  it('writes into a contenteditable composer', async () => {
    document.body.innerHTML = '<div id="c" contenteditable="true"></div>'
    const el = document.getElementById('c') as HTMLElement
    await typeInto(el, 'hello there', { budgetMs: 40 }, seededRng(6))
    expect(el.textContent).toBe('hello there')
  })

  it('leaves the exact value even when typos are certain', async () => {
    document.body.innerHTML = '<input id="f" />'
    const el = document.getElementById('f') as HTMLInputElement
    await typeInto(el, 'five years', { budgetMs: 80, typoChance: 1 }, seededRng(8))
    expect(el.value).toBe('five years')
  })
})
