import { chromium } from 'file:///D:/Sarthak/Coding/My Codes/Vibe-coding/job-maker/node_modules/playwright-core/index.mjs'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe'
const DIST = 'D:/Sarthak/Coding/My Codes/Vibe-coding/job-maker/dist'
const [, , PROFILE, MOCK_HTML] = process.argv
const html = readFileSync(MOCK_HTML, 'utf8')
const SP = 'C:/Users/umesh/AppData/Local/Temp/claude/D--Sarthak-Coding-My-Codes-Vibe-coding-job-maker/1412b0f7-188f-4ae3-876c-c8410626c450/scratchpad'
const PORT = 8443
const TARGET = `https://localhost:${PORT}/mockco/jobs/1001`

// A local stand-in for a company-hosted application form. Served over https on
// localhost with a self-signed certificate -- no real site is impersonated, and
// the extension reaches it through its own "extra domains" grant, which is the
// same path a company careers page takes.
const server = createServer(
  { key: readFileSync(`${SP}/key.pem`), cert: readFileSync(`${SP}/cert.pem`) },
  (req, res) => {
    if (req.url === '/log') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { console.log('  [page]', body.slice(0, 200)); res.writeHead(204); res.end() })
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  }
)
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
console.log('mock ATS on', TARGET)

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: BRAVE, headless: false,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check', '--ignore-certificate-errors'],
  viewport: { width: 1280, height: 900 },
})
let [worker] = ctx.serviceWorkers()
if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 30000 })
const id = new URL(worker.url()).host
const page = await ctx.newPage()
await page.goto(`chrome-extension://${id}/src/ui/options/index.html`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)

const send = (msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg)

// --- seed profile, settings and one queued job ---------------------------
// Written through the extension's own message API, so anything the schema
// rejects is reported instead of silently falling back to defaults.
const profile = {
  firstName: 'Aarav', lastName: 'Sharma', email: 'aarav.sharma.test@example.com',
  phone: '9876543210', phoneCountryCode: '+91', city: 'Bengaluru', state: 'Karnataka',
  country: 'India', headline: 'Backend engineer', currentTitle: 'Software Engineer',
  currentCompany: 'Test Labs', yearsExperience: 4,
  linkedin: 'https://linkedin.com/in/aarav-test', github: 'https://github.com/aarav-test',
  skills: ['TypeScript', 'Node.js', 'Postgres'],
  masterResumeText: 'Aarav Sharma - backend engineer with four years building Node.js and Postgres services.',
  experience: [{ id: 'exp-1', company: 'Test Labs', title: 'Software Engineer', location: 'Bengaluru',
    startDate: '2021-06', endDate: '', current: true, bullets: ['Built and ran Node.js services on Postgres.'], tech: ['Node.js'] }],
  workAuthorization: { authorizedInCountries: ['India'], requiresSponsorship: false, willingToRelocate: true, noticePeriodDays: 30 },
}
console.log('saveProfile:', JSON.stringify(await send({ type: 'ui:saveProfile', profile })).slice(0, 220))

const got = await send({ type: 'ui:getSettings' })
const settings = got?.data ?? got
settings.autonomy = {
  ...settings.autonomy, mode: 'full', minMatchScore: 0, dailyCap: 5, perVendorDailyCap: 5,
  notifyOnSubmit: false, delayBetweenApplicationsMs: { min: 1000, max: 2000 },
  delayBetweenFieldsMs: { min: 80, max: 200 },
  activeHours: { start: 0, end: 24 }, activeDays: [0, 1, 2, 3, 4, 5, 6],
}
settings.enabledSites = { ...settings.enabledSites, greenhouse: true, generic: true }
settings.extraDomains = [...(settings.extraDomains ?? []), 'localhost']
settings.documents = { ...settings.documents, generateCoverLetter: false, tailorResume: false }
// The model tier is stubbed: the API driver's health() only checks that a key
// and model are set, so the agent starts and every real completion fails --
// which is exactly the "no model reachable" path the resolver must survive.
settings.llm = { ...settings.llm, driver: 'openai-compatible', apiKey: 'test-key-not-real', model: 'gpt-4o-mini', requestTimeoutMs: 15000, maxRetries: 0 }
console.log('saveSettings:', JSON.stringify(await send({ type: 'ui:saveSettings', settings })).slice(0, 220))
console.log('preflight:', JSON.stringify(await send({ type: 'ui:preflight' })).slice(0, 500))

// A queued job pointing at the mock, written straight into the extension's DB.
await page.evaluate(async (target) => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('autoapply')
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const job = {
    id: 'mock-job-1', source: 'manual', vendor: 'generic', url: target, applyUrl: target,
    company: 'MockCo', title: 'Backend Engineer', location: 'Bengaluru, India', workMode: 'onsite',
    salaryText: '', salaryMin: null, salaryMax: null, postedAt: Date.now(),
    descriptionText: 'Backend engineer working on Node.js and Postgres services.',
    descriptionSource: 'hydrated', dedupeHash: 'mock-1', status: 'queued', matchScore: 92,
    matchReasons: ['stack match'], matchConcerns: [], rejectReason: '', discoveredAt: Date.now(),
  }
  await new Promise((res, rej) => {
    const tx = db.transaction('jobs', 'readwrite')
    tx.objectStore('jobs').put(job)
    tx.oncomplete = res; tx.onerror = () => rej(tx.error)
  })
}, TARGET)

// Host permission for the mock origin, requested from a real click so Chrome
// accepts it as a user gesture -- the same grant the Site access page makes.
await page.evaluate(() => {
  const b = document.createElement('button')
  b.id = 'grant-btn'
  b.textContent = 'grant'
  b.addEventListener('click', async () => {
    window.__granted = await chrome.permissions.request({ origins: ['https://localhost/*'] }).catch((e) => String(e))
  })
  document.body.appendChild(b)
})
await page.click('#grant-btn')
await page.waitForTimeout(1500)
console.log('permission granted:', await page.evaluate(() => window.__granted))

console.log('seeded. starting agent...')
console.log('start:', JSON.stringify(await send({ type: 'ui:startAgent' })).slice(0, 200))

// --- watch the application through to a terminal state --------------------
let app = null
const t0 = Date.now()
for (let i = 0; i < 100; i++) {
  await page.waitForTimeout(3000)
  const reply = await send({ type: 'ui:listApplications', limit: 5 })
  const list = reply?.data ?? reply
  app = Array.isArray(list) ? list[0] : list?.applications?.[0]
  if (app && ['submitted', 'needs_review', 'failed', 'skipped', 'dry_run'].includes(app.status)) break
}
console.log(`\nelapsed ${Math.round((Date.now() - t0) / 1000)}s`)
console.log('APPLICATION:', app ? JSON.stringify({ status: app.status, error: app.error, confidence: app.confidence, filled: app.fillPlan?.length, unresolved: app.unresolved?.length }, null, 1) : 'none')
if (app?.timeline) for (const t of app.timeline) console.log(`  [${t.level}] ${t.step}: ${String(t.detail).slice(0, 150)}`)

// --- what the form actually received --------------------------------------
const formPage = ctx.pages().find((p) => p.url().includes('mockco'))
if (formPage) {
  const got = await formPage.evaluate(() => ({
    submitted: window.__submitted ?? null,
    confirmationVisible: !document.getElementById('application_confirmation')?.hidden,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
  })).catch((e) => ({ error: String(e) }))
  console.log('\nFORM RECEIVED:', JSON.stringify(got, null, 1))
} else {
  console.log('\nFORM PAGE: closed (pages: ' + ctx.pages().map((p) => p.url().slice(0, 60)) + ')')
}
await send({ type: 'ui:stopAgent' })
await ctx.close()
server.close()
