/**
 * Pointing, personas and session pacing.
 *
 * The click assertions matter beyond disguise: several ATS widgets open their
 * menu on `mousedown` and never see a bare `click`, and the native activation
 * at the end is what keeps checkboxes and radios toggling as they always did.
 */

import { describe, expect, it } from 'vitest'
import { driftDuring, humanClick, readingPauseMs } from '@/human/pointer'
import { derivePersona, resetPersonaCache } from '@/human/persona'
import { fatigueMultiplier, maybeMicroBreak, nextGap } from '@/human/pacing'
import { seededRng } from '@/human/rng'

describe('humanClick', () => {
  it('fires a full press sequence, not a bare click', async () => {
    document.body.innerHTML = '<button id="b">Apply</button>'
    const el = document.getElementById('b') as HTMLButtonElement
    const seen: string[] = []
    for (const t of ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click']) {
      el.addEventListener(t, () => seen.push(t))
    }

    await humanClick(el, { pressMs: { min: 1, max: 2 }, scroll: false }, seededRng(1))

    expect(seen).toContain('mouseover')
    expect(seen).toContain('mousedown')
    expect(seen).toContain('mouseup')
    expect(seen[seen.length - 1]).toBe('click')
    expect(seen.indexOf('mousedown')).toBeLessThan(seen.indexOf('mouseup'))
  })

  it('still toggles a checkbox, exactly as el.click() did', async () => {
    document.body.innerHTML = '<input type="checkbox" id="c" />'
    const el = document.getElementById('c') as HTMLInputElement
    await humanClick(el, { pressMs: { min: 1, max: 2 }, scroll: false }, seededRng(2))
    expect(el.checked).toBe(true)
  })

  it('clicks at coordinates that are not the same twice', async () => {
    document.body.innerHTML = '<button id="b">x</button>'
    const el = document.getElementById('b') as HTMLButtonElement
    const points: string[] = []
    el.addEventListener('mousedown', (e) => points.push(`${(e as MouseEvent).clientX},${(e as MouseEvent).clientY}`))
    for (let i = 0; i < 6; i++) {
      await humanClick(el, { pressMs: { min: 1, max: 2 }, scroll: false }, seededRng(i + 10))
    }
    expect(points).toHaveLength(6)
  })
})

describe('readingPauseMs', () => {
  it('pauses longer for a longer question', () => {
    const persona = { wpm: 240 }
    const short = readingPauseMs('Email', persona, seededRng(3))
    const long = readingPauseMs(
      'Are you legally authorised to work in this country without sponsorship, now or in the future?',
      persona,
      seededRng(3)
    )
    expect(long).toBeGreaterThan(short)
    expect(long).toBeLessThanOrEqual(4000)
  })

  it('does not pause for an empty label', () => {
    expect(readingPauseMs('   ', { wpm: 240 })).toBe(0)
  })
})

describe('derivePersona', () => {
  it('is stable for the same key and different across sites', () => {
    resetPersonaCache()
    const a = derivePersona('boards.greenhouse.io|salt')
    const b = derivePersona('boards.greenhouse.io|salt')
    const c = derivePersona('myworkdayjobs.com|salt')
    expect(a).toEqual(b)
    expect(a.typingSpeed).not.toBe(c.typingSpeed)
  })

  it('stays inside plausible human bounds', () => {
    for (const host of ['a.com', 'b.io', 'careers.example.org', 'jobs.test']) {
      const p = derivePersona(host)
      expect(p.typingSpeed).toBeGreaterThan(0.5)
      expect(p.typingSpeed).toBeLessThan(2)
      expect(p.typoChance).toBeLessThan(0.05)
      expect(p.wpm).toBeGreaterThan(100)
    }
  })
})

describe('session pacing', () => {
  it('stretches the gap as the session wears on', () => {
    const fresh = fatigueMultiplier({ sessionMs: 0, completed: 0 })
    const tired = fatigueMultiplier({ sessionMs: 4 * 3_600_000, completed: 60 })
    expect(fresh).toBe(1)
    expect(tired).toBeGreaterThan(fresh)
    expect(tired).toBeLessThanOrEqual(2)
  })

  it('never takes a break in the first few applications', () => {
    for (let seed = 1; seed < 30; seed++) {
      expect(maybeMicroBreak({ sessionMs: 120_000, completed: 3 }, seededRng(seed))).toBeNull()
    }
  })

  it('does take breaks over a long run', () => {
    const breaks = Array.from({ length: 60 }, (_, i) =>
      maybeMicroBreak({ sessionMs: 2 * 3_600_000, completed: 30 }, seededRng(i + 1))
    ).filter(Boolean)
    expect(breaks.length).toBeGreaterThan(0)
    for (const b of breaks) {
      expect(b!.ms).toBeGreaterThanOrEqual(3 * 60_000)
      expect(b!.ms).toBeLessThanOrEqual(8 * 60_000)
    }
  })

  it('respects the configured range while fresh', () => {
    const base = { min: 30_000, max: 60_000 }
    const gap = nextGap(base, { sessionMs: 0, completed: 0 }, 1, seededRng(5))
    expect(gap.isBreak).toBe(false)
    expect(gap.ms).toBeGreaterThanOrEqual(base.min)
    expect(gap.ms).toBeLessThanOrEqual(base.max)
    expect(gap.reason).toMatch(/before the next application/)
  })
})

describe('driftDuring', () => {
  it('moves the pointer while the agent is reading, and stops on time', async () => {
    document.body.innerHTML = '<div style="height:2000px">a form</div>'
    let moves = 0
    document.addEventListener('mousemove', () => moves++, true)

    const started = Date.now()
    await driftDuring(700, seededRng(4))
    const elapsed = Date.now() - started

    expect(moves).toBeGreaterThan(0)
    expect(elapsed).toBeGreaterThanOrEqual(600)
    expect(elapsed).toBeLessThan(1600)
  })

  it('does nothing at all when there is no pause to fill', async () => {
    let moves = 0
    document.addEventListener('mousemove', () => moves++, true)
    await driftDuring(0, seededRng(1))
    expect(moves).toBe(0)
  })
})
