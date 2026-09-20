/**
 * Which ATSes score the session before accepting an application?
 *
 * A Greenhouse board refused three fully and correctly filled applications with
 * "There was an error processing your application", immediately after a call to
 * reCAPTCHA Enterprise. That is not a bug in the filling -- it is the site
 * declining to accept an automated session at all, and it sets a hard ceiling
 * on what unattended submission can achieve there.
 *
 * So before tuning anything else, it is worth knowing which boards do this. The
 * scan loads a real application page per vendor and records the bot-check
 * services it contacts and the globals it installs. Nothing is filled and
 * nothing is submitted; this only reads what the page loads.
 *
 *   node tests/e2e/scan-bot-checks.mjs
 *
 * Point AA_BROWSER at whichever Chromium build is installed.
 */

import { chromium } from 'playwright-core'

const BROWSER = process.env.AA_BROWSER ?? 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe'

/** Known session-scoring and bot-management services, by request URL. */
const VENDORS = [
  [/recaptcha\.net|google\.com\/recaptcha|recaptcha\/enterprise/i, 'reCAPTCHA'],
  [/hcaptcha\.com/i, 'hCaptcha'],
  [/challenges\.cloudflare\.com|turnstile/i, 'Cloudflare Turnstile'],
  [/datadome/i, 'DataDome'],
  [/perimeterx|px-cloud|pxchk/i, 'PerimeterX'],
  [/arkoselabs|funcaptcha/i, 'Arkose'],
  [/akamai|_abck|bot-manager/i, 'Akamai Bot Manager'],
  [/incapsula|imperva/i, 'Imperva'],
]

const TARGETS = [
  ['greenhouse (control)', 'https://job-boards.greenhouse.io/turing/jobs/6142224004'],
  ['lever', 'https://jobs.lever.co/mindtickle/203fff0a-f8cc-48cf-bc6f-fcd97a469674/apply'],
  ['ashby', 'https://jobs.ashbyhq.com/anyscale/02698dc0-9416-425f-a13d-0938ffd229a8/application'],
  ['smartrecruiters', 'https://jobs.smartrecruiters.com/SonicAutomotive/744000150512649'],
]

const browser = await chromium.launch({ executablePath: BROWSER, headless: true })

for (const [name, url] of TARGETS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  const hits = new Set()
  page.on('request', (r) => {
    for (const [re, vendor] of VENDORS) if (re.test(r.url())) hits.add(vendor)
  })

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(5000)
    // Some boards mount the form (and its bot check) only once it is on screen.
    await page.mouse.wheel(0, 2000)
    await page.waitForTimeout(3000)

    const facts = await page.evaluate(() => ({
      globals: ['grecaptcha', 'hcaptcha', 'turnstile', 'DD_RUM', '_pxAppId'].filter((g) => g in window),
      formCount: document.querySelectorAll('form').length,
      fileInputs: document.querySelectorAll('input[type=file]').length,
      submitText: Array.from(document.querySelectorAll('button[type=submit], input[type=submit]'))
        .map((b) => (b.innerText || b.value || '').trim())
        .filter(Boolean)
        .slice(0, 3),
      recaptchaNodes: document.querySelectorAll('[class*="recaptcha"], [id*="recaptcha"], iframe[src*="recaptcha"]').length,
    }))

    console.log(`\n=== ${name}`)
    console.log('  url:', url.slice(0, 80))
    console.log('  bot checks contacted:', hits.size ? [...hits].join(', ') : 'none')
    console.log('  globals:', facts.globals.length ? facts.globals.join(', ') : 'none')
    console.log('  recaptcha DOM nodes:', facts.recaptchaNodes)
    console.log('  forms/file inputs:', `${facts.formCount}/${facts.fileInputs}`, '| submit:', JSON.stringify(facts.submitText))
  } catch (e) {
    console.log(`\n=== ${name}\n  FAILED: ${String(e).slice(0, 120)}`)
  }
  await page.close()
}

await browser.close()
