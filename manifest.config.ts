import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

/** Local wall-clock, so it can be compared against "when did I last build?". */
function buildStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Domains the form agent is injected into by default. Users can add more at
 * runtime from the options page; those are registered with
 * chrome.scripting.registerContentScripts rather than being baked in here.
 */
export const APPLY_MATCHES = [
  'https://boards.greenhouse.io/*',
  'https://job-boards.greenhouse.io/*',
  'https://*.greenhouse.io/*',
  'https://jobs.lever.co/*',
  'https://*.lever.co/*',
  'https://jobs.ashbyhq.com/*',
  'https://*.ashbyhq.com/*',
  'https://apply.workable.com/*',
  'https://*.workable.com/*',
  'https://jobs.smartrecruiters.com/*',
  'https://*.smartrecruiters.com/*',
  'https://*.myworkdayjobs.com/*',
  'https://*.myworkdaysite.com/*',
  'https://*.indeed.com/*',
  'https://*.naukri.com/*',
]

/**
 * Public job-board JSON endpoints. Reading these from the service worker is
 * faster and far more reliable than scraping a rendered board in a tab.
 */
export const BOARD_API_MATCHES = [
  'https://boards-api.greenhouse.io/*',
  'https://api.lever.co/*',
  'https://api.ashbyhq.com/*',
]

/**
 * Chat sites the reasoning engine can be driven through.
 *
 * Kept in step with `CHAT_SITES` in src/llm/chat-sites.ts, which is where the
 * per-site selectors live. DeepAI is the default web driver; DeepSeek is kept
 * as an alternative so a free driver that starts refusing sessions is not a dead
 * end.
 */
export const CHAT_MATCHES = ['https://deepai.org/*', 'https://chat.deepseek.com/*']

export default defineManifest({
  manifest_version: 3,
  name: 'AutoApply - autonomous job agent',
  short_name: 'AutoApply',
  version: pkg.version,
  // Shown on the chrome://extensions card, so which build Chrome actually has
  // loaded is readable without opening the extension at all.
  version_name: `${pkg.version} (build ${buildStamp()})`,
  description:
    'Discovers, scores, tailors and submits job applications autonomously, behind a confidence gate you control.',
  minimum_chrome_version: '116',

  permissions: [
    'storage',
    'unlimitedStorage',
    'tabs',
    'scripting',
    'alarms',
    'sidePanel',
    'notifications',
    'downloads',
  ],

  host_permissions: [
    // Chat sites the reasoning engine is driven through. The service worker
    // opens a tab on one of these and the bridge runs inside it.
    ...CHAT_MATCHES,
    // LLM API endpoints: required so the service worker can fetch them
    // without a CORS preflight failure ("Failed to fetch"). Optional
    // `https://*/*` exists for custom bases, but the common providers must
    // work without an extra permission prompt.
    'https://integrate.api.nvidia.com/*',
    'https://api.nvidia.com/*',
    'https://api.deepseek.com/*',
    'https://api.anthropic.com/*',
    'https://api.openai.com/*',
    ...BOARD_API_MATCHES,
    ...APPLY_MATCHES,
  ],

  // Granted on request, so a user can add a company that hosts its own form.
  optional_host_permissions: ['https://*/*'],

  background: { service_worker: 'src/background/service-worker.ts', type: 'module' },

  side_panel: { default_path: 'src/ui/sidepanel/index.html' },

  action: {
    default_popup: 'src/ui/popup/index.html',
    default_title: 'AutoApply',
    default_icon: { '16': 'icons/16.png', '48': 'icons/48.png', '128': 'icons/128.png' },
  },

  options_page: 'src/ui/options/index.html',

  icons: { '16': 'icons/16.png', '48': 'icons/48.png', '128': 'icons/128.png' },

  content_scripts: [
    {
      // The chat bridge resolves its own site from the URL, so one built file
      // serves every chat site listed here. Adding a third needs a new match
      // pattern and a profile, not a new content script.
      matches: CHAT_MATCHES,
      js: ['src/content/chat-bridge.ts'],
      run_at: 'document_idle',
    },
    {
      matches: APPLY_MATCHES,
      js: ['src/content/form-agent.ts'],
      run_at: 'document_idle',
      all_frames: true,
    },
    // Runs in the page's own world, before its scripts, so a form filled in a
    // minimized worker window is not told that nobody is watching it. See
    // src/content/visibility-shim.ts for why that matters for the fill itself
    // and not only for appearances.
    {
      matches: APPLY_MATCHES,
      js: ['src/content/visibility-shim.ts'],
      run_at: 'document_start',
      all_frames: true,
      world: 'MAIN',
    },
  ],

  web_accessible_resources: [{ resources: ['icons/*', 'assets/*'], matches: ['<all_urls>'] }],
})
