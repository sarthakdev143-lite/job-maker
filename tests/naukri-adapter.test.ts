/**
 * The Naukri adapter.
 *
 * Scope note, because it matters for how much these tests are worth: unlike
 * `indeed-adapter.test.ts`, whose selectors were read off a real signed-in
 * application, the Naukri selectors here were written from Naukri's published
 * markup and NOT verified against a live page. What these tests do pin down is
 * the branch logic — given a page in each of the five states, which verdict
 * comes out — which is where the previous adapter went wrong. If Naukri renames
 * a class, these still pass and the adapter still misses; only a live run can
 * close that gap.
 *
 * The defect being guarded against: the old adapter reported every advert as
 * "not an application form", so the runner clicked Apply — genuinely submitting
 * on Naukri, where that button is the whole application — and then recorded the
 * job as skipped. The application went out and the user never saw it.
 */

import { describe, expect, it } from 'vitest'

import { naukriAdapter } from '@/sites/boards'
import { adapterForUrl } from '@/sites/registry'
import type { FieldDescriptor } from '@/storage/schemas'

const URL = 'https://www.naukri.com/job-listings-backend-engineer-acme-bangalore-123456'

function doc(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
}

const HEADER = '<h1 class="styles_jd-header-title__rZwM1">Backend Engineer</h1>'

describe('matches', () => {
  it.each([
    'https://www.naukri.com/job-listings-x-123',
    'https://naukri.com/anything',
    'https://recruit.naukri.com/board',
  ])('claims %s', (url) => {
    expect(naukriAdapter.matches(url)).toBe(true)
  })

  it.each(['https://notnaukri.com/x', 'https://naukri.com.evil.test/x', 'https://indeed.com/x'])(
    'does not claim %s',
    (url) => {
      expect(naukriAdapter.matches(url)).toBe(false)
    }
  )

  it('is the adapter the registry picks for a naukri url', () => {
    expect(adapterForUrl(URL).id).toBe('naukri')
  })
})

describe('detect', () => {
  it('reports one-click apply so the runner gates before clicking', () => {
    const result = naukriAdapter.detect(doc(`${HEADER}<button id="apply-button">Apply</button>`), URL)

    // The whole point: the button IS the application, so the runner must know
    // that before it touches it.
    expect(result.entrySubmitsImmediately).toBe(true)
    expect(result.isApplicationForm).toBe(false)
    expect(result.confidence).toBeGreaterThan(0.4)
    expect(result.jobTitle).toBe('Backend Engineer')
  })

  it('does NOT treat "Apply on company site" as a one-click apply', () => {
    // That button only redirects to a real ATS. Submitting on it is meaningless
    // and marking the job applied would lose a genuine application.
    const result = naukriAdapter.detect(
      doc(`${HEADER}<button id="company-site-button">Apply on company site</button>`),
      URL
    )

    expect(result.entrySubmitsImmediately).toBeFalsy()
    expect(result.isApplicationForm).toBe(false)
  })

  it('treats the chatbot drawer as a fillable multi-step form', () => {
    const result = naukriAdapter.detect(
      doc(
        `${HEADER}<div class="chatbot_DrawerContentWrapper">
           <label>What is your expected CTC?</label><input type="text" />
           <button class="sendMsg">Send</button>
         </div>`
      ),
      URL
    )

    expect(result.isApplicationForm).toBe(true)
    expect(result.multiStep).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.4)
  })

  it('refuses everything when signed out, rather than clicking a login prompt', () => {
    const result = naukriAdapter.detect(
      doc(`${HEADER}<div id="login_Layer"></div><button id="apply-button">Apply</button>`),
      URL
    )

    expect(result.isApplicationForm).toBe(false)
    expect(result.entrySubmitsImmediately).toBeFalsy()
    expect(result.confidence).toBe(0)
    expect(result.detail).toMatch(/signed in/i)
  })

  it('does not re-apply to a job already applied to', () => {
    const result = naukriAdapter.detect(
      doc(`${HEADER}<button id="apply-button">Applied</button>`),
      URL
    )

    expect(result.entrySubmitsImmediately).toBeFalsy()
    expect(result.confidence).toBe(0)
    expect(result.detail).toMatch(/already applied/i)
  })

  it('does not read "Applied" from the recommendations rail as this job', () => {
    // "Applied" appears all over Naukri; matching the whole body would mark
    // every job as already done and the agent would apply to nothing.
    const result = naukriAdapter.detect(
      doc(
        `${HEADER}<aside class="similar-jobs">Applied</aside>
         <button id="apply-button">Apply</button>`
      ),
      URL
    )

    expect(result.entrySubmitsImmediately).toBe(true)
    expect(result.detail).not.toMatch(/already applied/i)
  })

  it('reports a plain advert with no apply control as nothing to do', () => {
    const result = naukriAdapter.detect(doc(`${HEADER}<p>Some job description.</p>`), URL)

    expect(result.isApplicationForm).toBe(false)
    expect(result.entrySubmitsImmediately).toBeFalsy()
    expect(result.confidence).toBeLessThan(0.4)
  })

  it('prefers the chatbot over the apply button once the drawer is open', () => {
    // Both are present mid-flow; filling the open question is the right move,
    // pressing Apply again is not.
    const result = naukriAdapter.detect(
      doc(
        `${HEADER}<button id="apply-button">Apply</button>
         <div class="chatbot_DrawerContentWrapper"><input /></div>`
      ),
      URL
    )

    expect(result.isApplicationForm).toBe(true)
    expect(result.entrySubmitsImmediately).toBeFalsy()
  })
})

describe('canonicalKey', () => {
  const field = (label: string): FieldDescriptor =>
    ({ label, placeholder: '' }) as unknown as FieldDescriptor

  it.each([
    ['What is your expected CTC?', 'expectedSalary'],
    ['Expected salary', 'expectedSalary'],
    ['Current CTC', 'currentSalary'],
    ['What is your notice period?', 'noticePeriod'],
    ['How soon can you join?', 'noticePeriod'],
    ['Total experience', 'yearsExperience'],
    ['Years of experience', 'yearsExperience'],
    ['Current company', 'currentCompany'],
    ['Current designation', 'currentTitle'],
    ['Preferred location', 'city'],
    ['Are you willing to relocate?', 'willingToRelocate'],
  ])('maps the chatbot question %j to %s', (label, expected) => {
    expect(naukriAdapter.canonicalKey?.(field(label))).toBe(expected)
  })

  it('returns null for a question it does not know, so the generic tiers run', () => {
    expect(naukriAdapter.canonicalKey?.(field('Describe a hard bug you fixed'))).toBeNull()
    expect(naukriAdapter.canonicalKey?.(field(''))).toBeNull()
  })

  it('does not confuse current CTC with expected CTC', () => {
    expect(naukriAdapter.canonicalKey?.(field('Expected CTC'))).toBe('expectedSalary')
    expect(naukriAdapter.canonicalKey?.(field('Current CTC'))).toBe('currentSalary')
  })
})
