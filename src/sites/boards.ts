/**
 * Naukri.
 *
 * Naukri is permissive about automation but its apply flow is often a single
 * button plus a chatbot that asks follow-up questions in a drawer, and both
 * need a signed-in session. The adapter recognises the drawer, which is the
 * only part of the flow this agent can actually fill.
 *
 * Indeed used to live here too, as a discovery-only stub. It has its own
 * adapter now -- see `./indeed` -- because it is the agent's primary surface
 * and needs a real model of its multi-step Easy Apply wizard.
 */

import type { SiteAdapter } from './types'
import { COMMON_ERROR_SELECTORS, COMMON_SUCCESS_PATTERNS, textOf } from './types'
import type { CanonicalKey } from '@/form/canonical'
import type { FieldDescriptor } from '@/storage/schemas'

export const naukriAdapter: SiteAdapter = {
  id: 'naukri',
  label: 'Naukri',

  matches(url: string): boolean {
    return /naukri\.com$/.test(new URL(url, location.href).hostname)
  },

  /**
   * Naukri's job pages are adverts, not forms.
   *
   * Applying is a button that either posts your stored Naukri profile straight
   * away or opens a chatbot drawer of screening questions -- and both need you
   * signed in. Treating the advert as a form meant harvesting zero fields and
   * then "submitting" nothing, which is worse than skipping it. Only the
   * chatbot drawer counts as something this agent can fill.
   */
  detect(doc: Document, url: string) {
    const chatbot = doc.querySelector('.chatbot_DrawerContentWrapper, [class*="chatbot"]')
    const signedOut = doc.querySelector('#login_Layer, [class*="login-layer"], a[href*="/nlogin/login"]')
    const fields = doc.querySelectorAll('input:not([type="hidden"]):not([type="search"]), textarea, select')
    const title = textOf(doc.querySelector('.styles_jd-header-title__rZwM1, h1')) || doc.title
    const company = textOf(doc.querySelector('.styles_jd-header-comp-name__MvqAI, [class*="comp-name"]'))

    return {
      isApplicationForm: Boolean(chatbot) && fields.length > 0,
      confidence: chatbot ? 0.8 : 0.1,
      jobTitle: title,
      company,
      multiStep: Boolean(chatbot),
      detail: signedOut
        ? 'not signed in to Naukri - applying needs a logged-in session'
        : chatbot
          ? 'naukri chatbot questions'
          : 'naukri job advert, not an application form',
    }
  },

  applyEntrySelectors: ['#apply-button', '.apply-button', 'button[id*="apply" i]'],

  nextStepSelectors: ['.sendMsg', 'button[class*="send" i]', '.chatbot_Chat_Send'],

  submitSelectors: ['#apply-button', '.sendMsg', 'button[class*="send" i]'],

  successPatterns: [
    ...COMMON_SUCCESS_PATTERNS,
    /you have (successfully )?applied/i,
    /applied to this job/i,
    /application sent to recruiter/i,
  ],

  errorSelectors: COMMON_ERROR_SELECTORS,
}
