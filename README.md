# AutoApply

A Chrome extension that finds jobs, scores them against your rules, tailors a resume and cover letter, fills the application form, and submits it — with a gate you control deciding how much of that it does without asking.

It runs entirely on your machine. There is no server, no account, and no API key unless you want one: the default reasoning engine is a logged-in DeepSeek chat tab that the extension drives in a minimised window.

---

## Install

```bash
npm install
npm run build
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `dist/` folder

The settings page opens on first install. During development, `npm run dev` gives you hot reload against the same `dist/` folder.

---

## First run

Do these in order. Steps 1–3 take about fifteen minutes and everything afterwards depends on them.

**1. Pick your engine.** Two options, API first: Settings → **Model** → Driver → **NVIDIA NIM**, paste a NIM key from build.nvidia.com and name a model (e.g. `meta/llama-3.1-405b-instruct`), then press *Run test*. If NIM goes down mid-run the agent fails over to the DeepSeek web tab for that request rather than parking the application — so as a safety net, still sign in at [chat.deepseek.com](https://chat.deepseek.com) in this browser. Pure free option: leave the driver on DeepSeek web and just sign in; the extension reuses that session and never sees your password. Either way, press *Run test* — you should get a JSON reply back.

**2. Drop your resume on the Profile page.** Settings → **Profile** → drag a PDF onto the box at the top. The model reads it and fills in everything below: name, contact details, every role with its bullets, education, skills. Takes about half a minute.

Then check two things it filled and four it could not:

- **Read what it extracted.** It transcribes rather than invents, but a two-column layout can still confuse it.
- **Work authorization, expected compensation, notice period** — a resume does not state these, and every ATS asks. The import tells you exactly which ones are still blank. Leave them empty and those applications stop for review.

Press *Preview resume PDF* to see what employers will actually receive.

**3. Add a search.** Settings → **Searches** → *Set them up for me* reads your profile and creates switched-on searches aimed at it. Settings → **Matching** → *Suggest rules* does the same for the filters. Both are drafts you can edit.

To do it by hand instead — the most reliable sources are the ATS boards, read through public JSON rather than scraped:

| Source | How to configure |
|---|---|
| Greenhouse | Company slugs from the board URL, e.g. `stripe` from `boards.greenhouse.io/stripe` |
| Lever | Company slugs, e.g. `ramp` from `jobs.lever.co/ramp` |
| Ashby | Board names from `jobs.ashbyhq.com/<name>` |
| Naukri, Indeed | Keywords plus a location; these open a background tab and read listing cards |

Press *Run all enabled*, then open the side panel (toolbar icon → **Open console**) and look at the **Jobs** tab. The *Filtered out* list shows what your rules rejected and why — that is the fastest way to find out your rules are too tight.

**4. Stay in dry run for a while.** Settings → **Autonomy** starts in **Dry run**: the agent does every step including filling the form, then stops without submitting. Press *Start* in the side panel and watch the **Review** tab. Open a few, read every answer, and fix what is wrong. Nothing is sent.

**5. Move up one step at a time.**

- **Review everything** — the agent does all the work, you click approve. About ten seconds per job.
- **Submit above your thresholds** — unattended submission when the match score and fill confidence both clear your bars. Start at a match of 80 and a confidence of 0.9, with the daily cap at 5, and read the audit log each evening.
- **Submit everything** — no thresholds. A wrong answer reaches a real recruiter with no undo.

---

## How it decides what to fill in

Each field falls through four tiers, cheapest first, and anything that reaches the bottom is parked for you rather than guessed at:

1. **Your overrides** — a selector you mapped by hand for a domain
2. **Vendor adapter** — that ATS's own field naming (`#first_name` on Greenhouse, `_systemfield_email` on Ashby, `data-automation-id` on Workday)
3. **Canonical matcher** — the eighty percent of questions everyone asks, answered straight from your profile
4. **Answer bank** — anything you have answered before, matched exactly and then fuzzily
5. **The model** — genuinely novel questions, batched into one call per page
6. **Park** — unresolved, or answered with low confidence

Tiers 1–4 are free and instant. **The answer bank grows on its own**: every answer that survived a submitted application is remembered, so the agent gets cheaper and faster the longer you use it. Settings → **Answer bank** is where you correct a recurring wrong answer once, everywhere.

## How it decides whether to submit

One function, [`src/runner/autonomy-gate.ts`](src/runner/autonomy-gate.ts), makes that call. Every check is a veto and nothing overrides a veto:

- the site is enabled, the daily cap is not spent, and the clock is inside your active hours
- the mode allows submitting at all
- no required field is unanswered, and no required field rejected its value
- in gated mode, the match score and the fill confidence both clear your thresholds

Anything that fails lands in the review queue with its whole fill plan intact, so approving replays that plan exactly — an edit you make there is exactly what the employer receives.

---

## What it will not do

- **Invent anything about you.** Employers, titles and dates come from your profile and are never model output. A tailored bullet may not introduce a number absent from your profile; one that tries is rejected and the original is used instead. Invented metrics are the fabrication that actually happens, and they fall apart in an interview.
- **Answer a question it cannot answer honestly.** A field the profile does not cover is parked, not guessed.
- **Run at 3am.** Applications sent at strange hours look exactly like what they are. The active-hours window exists for that reason and pacing between fields and applications is randomised.
- **Fill in demographic questions.** EEO questions are declined by default, using the form's own decline option. You can opt in per field in Settings → Profile.

---

## Where your data lives

Everything stays on this machine: profile and settings in Chrome's extension storage, and jobs, applications, generated PDFs and the audit log in the extension's IndexedDB. **None of it is encrypted at rest** — anyone with access to your Chrome profile can read it. The only data that leaves your machine is what the agent sends to your chosen model and what it types into application forms.

Settings → **Advanced** exports your settings, profile and searches as a JSON file.

---

## When something breaks

**"DeepSeek needs you to sign in."** Open the tab from the banner in the side panel and log in. The session expires periodically; this is normal.

**The model test fails, or replies stop arriving.** DeepSeek changed their page structure. This is the most fragile part of the system, and it is deliberately confined to one file, [`src/content/deepseek-bridge.ts`](src/content/deepseek-bridge.ts). You can repair it without rebuilding: Settings → **Model** → **Bridge selectors**, press *Load current*, and fix the CSS selectors. Turn off *Keep the worker window minimised* first so you can watch the conversation happen. If you would rather not maintain this, switch the driver to an API key — every other part of the system is unchanged by that.

**A site fills badly.** Settings → **Advanced** → *Try a single form*. It opens the URL, fills what it can, leaves the window open and outlines in amber anything it could not answer. Nothing is submitted. If a field is labelled confusingly, map it by hand in *Field overrides*.

**The resume import got things wrong.** Re-import with *Replace what I have* to let the resume win over what is there. If it consistently misreads a section, the prompt is editable: Settings → **Prompts** → *Reading a resume into the profile*. Scanned or image-only PDFs have no text to extract at all — paste the text instead.

**An application says "submitted but not confirmed".** The form was clicked but no confirmation appeared — almost always a validation error. The application is in the review queue with the page's own complaint attached.

**Workday asks for an account.** It needs one per employer, with an email confirmation the extension cannot read. Workday is off by default for that reason; applications there are parked with a clear explanation rather than failing halfway through.

**Nothing is being found.** Check the *Filtered out* tab first — hard filters run before anything is scored, and a single over-tight rule (a minimum salary, a 7-day recency window, a title keyword) can reject an entire board.

---

## Development

```bash
npm run dev        # hot-reloading build
npm run build      # typecheck, then production build into dist/
npm test           # unit and fixture tests
npm run typecheck
```

### Layout

```
src/
  background/    service worker (message router, alarms) and the agent loop
  llm/           driver interface, DeepSeek web driver, API drivers, JSON repair
  storage/       zod schemas, IndexedDB repos, settings, the answer bank
  discovery/     board APIs and tab-driven scrapers
  matching/      deterministic prefilter, then model scoring
  form/          harvester, resolver, filler, selector generation, canonical fields
  sites/         one adapter per ATS, plus a generic fallback
  runner/        the apply state machine and the autonomy gate
  documents/     resume tailoring, fabrication screening, PDF rendering
  ui/            side panel, options page, popup
  content/       the two scripts that run inside pages
tests/fixtures/  real ATS form markup, one directory per vendor
```

### Adding support for a new ATS

1. Save its application form's HTML into `tests/fixtures/<vendor>/application.html`.
2. Write the adapter in `src/sites/<vendor>/index.ts` — `detect`, `canonicalKey`, submit and success selectors — and register it in `src/sites/registry.ts` ahead of the generic adapter.
3. Add a block to `tests/harvester.test.ts` asserting which question each control is asking and which profile field answers it.

Those fixture tests are what catch adapter rot: when a vendor changes their markup, the suite fails before a user finds out by having an application filled in wrongly. Every production failure is worth turning into a new fixture.

### A note on the two content scripts

All judgement happens in the service worker; the content scripts only describe the page and execute a plan they are given. That keeps the risky, site-specific code small and the decision-making code testable without a browser — which is why the gate, the resolver, the prefilter and the fabrication screen all have real unit tests while the DOM layer is covered by fixtures.

---

## Terms of service

Greenhouse, Lever, Ashby, Workable and SmartRecruiters publish their boards openly and place no restriction on applying programmatically on your own behalf. **Indeed's terms prohibit automated interaction and it actively fingerprints for it** — it ships disabled, capped low, and is best used as a discovery source whose listings redirect to a real ATS. Naukri is more permissive. Driving the DeepSeek web UI is a grey area in their terms; the API-key drivers exist partly for that reason.

You are the one applying. Read what goes out, at least until you trust it.
