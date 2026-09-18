/**
 * The outline is what the model sees instead of the page.
 *
 * Everything the fallback decides rests on it being faithful: if a hidden
 * control appears in the list the model will pick a button nobody can click,
 * and if a selector in the list does not resolve the click goes nowhere. So
 * these tests are about honesty rather than completeness.
 */

import { describe, expect, it } from 'vitest'

import { elementText, isVisible, outlinePage, renderOutline, stableSelector } from '@/form/outline'

function pageWith(html: string): Document {
  document.body.innerHTML = html
  return document
}

describe('isVisible', () => {
  it('rejects display:none, which is how a closed menu hides its buttons', () => {
    const doc = pageWith('<button id="a" style="display:none">Apply</button>')
    expect(isVisible(doc.getElementById('a')!)).toBe(false)
  })

  it('rejects aria-hidden, which screen readers and users both skip', () => {
    const doc = pageWith('<div><button id="a" aria-hidden="true">Apply</button></div>')
    expect(isVisible(doc.getElementById('a')!)).toBe(false)
  })
})

describe('elementText', () => {
  it('prefers the words actually on the control', () => {
    const doc = pageWith('<button id="a" aria-label="ignored">Apply now</button>')
    expect(elementText(doc.getElementById('a')!)).toBe('Apply now')
  })

  it('falls back through aria-label, title, placeholder and name', () => {
    const doc = pageWith('<input id="a" aria-label="Email address" />')
    expect(elementText(doc.getElementById('a')!)).toBe('Email address')

    const doc2 = pageWith('<input id="b" placeholder="Your phone" />')
    expect(elementText(doc2.getElementById('b')!)).toBe('Your phone')

    const doc3 = pageWith('<input id="c" name="first_name" />')
    expect(elementText(doc3.getElementById('c')!)).toBe('first_name')
  })

  it('collapses whitespace, so a multi-line button is one readable label', () => {
    const doc = pageWith('<button id="a">Apply\n\n   now</button>')
    expect(elementText(doc.getElementById('a')!)).toBe('Apply now')
  })
})

describe('stableSelector', () => {
  it('prefers an id', () => {
    const doc = pageWith('<button id="apply-btn">Apply</button>')
    expect(stableSelector(doc.getElementById('apply-btn')!, doc)).toBe('#apply-btn')
  })

  it('refuses a generated id, which is the thing that rotates', () => {
    const doc = pageWith('<button id="btn-812345">Apply</button>')
    expect(stableSelector(doc.querySelector('button')!, doc)).not.toBe('#btn-812345')
  })

  it('uses a test hook when there is no usable id', () => {
    const doc = pageWith('<button data-testid="apply">Apply</button>')
    expect(stableSelector(doc.querySelector('button')!, doc)).toBe('[data-testid="apply"]')
  })

  it('uses name for a form control', () => {
    const doc = pageWith('<form><input name="email" /></form>')
    expect(stableSelector(doc.querySelector('input')!, doc)).toBe('input[name="email"]')
  })

  it('always returns something that resolves back to the same element', () => {
    // The whole contract. A selector the runner cannot use is worse than none,
    // because the click silently goes nowhere.
    const doc = pageWith(`
      <div><section><button>One</button><button>Two</button><button>Three</button></section></div>
    `)
    for (const el of Array.from(doc.querySelectorAll('button'))) {
      const selector = stableSelector(el, doc)
      expect(doc.querySelector(selector)).toBe(el)
    }
  })

  it('never falls back to a generated class name', () => {
    const doc = pageWith('<button class="css-1x2y3z4 sc-abcdef">Apply</button>')
    expect(stableSelector(doc.querySelector('button')!, doc)).not.toMatch(/css-|sc-/)
  })
})

describe('outlinePage', () => {
  it('numbers every control it lists, starting at 1', () => {
    const doc = pageWith('<button>Apply</button><button>Save job</button>')
    const outline = outlinePage(doc, 'https://example.com/job/1')
    expect(outline.elements.map((e) => e.ref)).toEqual([1, 2])
  })

  it('omits controls that are not on screen', () => {
    const doc = pageWith('<button>Apply</button><button style="display:none">Hidden apply</button>')
    const outline = outlinePage(doc, 'https://example.com/job/1')
    expect(outline.elements.map((e) => e.text)).toEqual(['Apply'])
  })

  it('keeps unlabelled inputs, which are still facts about the page', () => {
    const doc = pageWith('<input type="text" /><span>not a control</span>')
    const outline = outlinePage(doc, 'https://example.com')
    expect(outline.elements).toHaveLength(1)
    expect(outline.elements[0].role).toBe('input')
  })

  it('drops unlabelled buttons, which cannot be chosen by description', () => {
    const doc = pageWith('<button></button><button>Apply</button>')
    const outline = outlinePage(doc, 'https://example.com')
    expect(outline.elements.map((e) => e.text)).toEqual(['Apply'])
  })

  it('marks disabled and required, which change what the model should say', () => {
    const doc = pageWith('<button disabled>Apply</button><input name="email" required />')
    const outline = outlinePage(doc, 'https://example.com')
    expect(outline.elements[0].disabled).toBe(true)
    expect(outline.elements[1].required).toBe(true)
  })

  it('reports a submit input as a button, not an input', () => {
    const doc = pageWith('<input type="submit" value="Send application" />')
    const outline = outlinePage(doc, 'https://example.com')
    expect(outline.elements[0].role).toBe('button')
  })

  it('carries the headings, which tell a confirmation page from a form', () => {
    const doc = pageWith('<h1>Application received</h1><button>Back to jobs</button>')
    const outline = outlinePage(doc, 'https://example.com/thanks')
    expect(outline.headings).toContain('Application received')
  })
})

describe('renderOutline', () => {
  it('renders every control with its reference number', () => {
    const doc = pageWith('<button>Apply now</button><button disabled>Applied</button>')
    const text = renderOutline(outlinePage(doc, 'https://example.com/job/1'))
    expect(text).toContain('[1] button "Apply now"')
    expect(text).toContain('(disabled)')
    expect(text).toContain('https://example.com/job/1')
  })
})
