# Refocusing AutoApply on Indeed, for unattended overnight runs

Date: 2026-09-14

## Goal

Run unattended for hours overnight and apply to every remote role matching the
user's profile — lead, engineer, developer and architect families — with Indeed
as the primary surface.

## Why the extension could not already do this

The extension was built to avoid Indeed deliberately, and separately could not
survive an unattended night. Four findings, all verified in the code before any
change was made:

1. **The service worker died at every gap between applications.** Manifest V3
   evicts a worker after roughly 30 seconds without extension API activity, and
   a pending `setTimeout` does not count as activity. `Orchestrator.applyOne`
   waited out `delayBetweenApplicationsMs` — 45 to 180 seconds — through a bare
   `sleep()`. Every inter-application gap was therefore a guaranteed kill. The
   apply machine's `finally { closeTab }` never ran, leaking a minimized window
   each time, and nothing restarted the run until the next periodic alarm up to
   thirty minutes later.
2. **Run state lived only in memory.** `running` and `startedAt` were fields on
   a singleton discarded with the worker, so a replacement worker read itself as
   idle rather than as interrupted.
3. **Caps stopped the run early.** `maxApplicationsPerDay` defaulted to 15 (25
   under autopilot) and `perSiteDailyCap.indeed` was 5.
4. **Indeed was switched off by design.** `enabledSites.indeed` was `false`,
   autopilot's `APPLYABLE_SOURCES` excluded it and actively disabled any Indeed
   recipe, `setUpSearchesFromProfile` never created one, and the adapter was a
   discovery-only stub that treated the job advert as if it were the form.

## Design

### Durability

`src/shared/keepalive.ts` provides `durableSleep` (sleep in chunks under the
eviction window, touching an extension API across every boundary) and
`startHeartbeat` (an interval for open-ended stretches, such as the model driver
waiting on a reply in another tab). Both take their ticker as an argument so
they are testable without Chrome, and both swallow ticker failures: a keepalive
that can fail the thing it is keeping alive is worse than none.

`src/background/run-state.ts` persists `{running, startedAt, manual, lastBeatAt}`
to `chrome.storage.local` — local rather than session so a run survives Chrome
restarting itself for an update. `manual` is carried across eviction so a run
started by hand keeps ignoring the active-hours window. The orchestrator's
heartbeat ticker is `beat()`, which writes that record and thereby doubles as
the API call that resets the idle timer.

The orchestrator gains `resumeIfInterrupted()`, called at service worker module
scope, on `onStartup`, and from the cycle alarm. It reaps orphaned worker
windows before resuming. `start()` now drives `runForever()` — sweep after
sweep with a one-minute gap — rather than a single cycle leaning on a
thirty-minute alarm, and that alarm drops to one minute as a safety net.

### Volume mode

The model driver is a single serialised chat session, so every call sits on the
critical path of the whole run. At default settings one job costs up to four —
score, answer fields, tailor resume, write cover letter — which is two to four
minutes of model time before a page loads, and caps a night at a couple of dozen
applications.

`autonomy.volumeMode` skips the LLM scorer entirely. The deterministic
prefilter already enforces the user's title, location, work-mode and blocklist
rules; scoring can only subtract from a list the user asked to apply to in full.
Autopilot additionally turns off resume tailoring and cover letters, which
leaves the resume PDF still rendered locally from the profile, just not
rewritten per posting. With a warm answer bank, most Easy Apply forms then cost
no model call at all.

Work is ordered Easy Apply first (`byCheapestFirst`), because those are
prefilled from the user's Indeed account and finish in seconds.

### Indeed discovery

`src/discovery/sources/indeed.ts`. Remote is enforced in the query rather than
filtered afterwards — both the `sc=0kf:attr(DSQF7);` attribute filter that backs
Indeed's own Remote checkbox and `l=Remote` as a fallback — so the expensive
part, opening each job page, is never spent on ineligible listings. One URL per
role phrase per domain per page across `www.indeed.com` and `in.indeed.com`;
concatenating phrases into one query is read by Indeed as a conjunction and
matches almost nothing, which is the bug the Naukri builder already had to fix.

The card scraper records the Easy Apply badge and the `data-jk` job key, which
is the only identifier stable across Indeed's concurrent card layouts. A
Cloudflare or bot-check interstitial is detected explicitly and backed off from,
because a challenge page is a valid page with zero job cards and is otherwise
indistinguishable from "no remote jobs today".

Hydration resolves each listing's real apply destination into `job.applyUrl`, so
a listing that redirects to a company ATS is opened at that form directly
instead of landing on an advert.

### Indeed apply

`src/sites/indeed.ts`. Indeed drives every wizard step with one relabelled
`ia-continueButton`, so "the submit button is present" is as true on the contact
page as on the final review and no selector can tell them apart. The
`SiteAdapter` contract gains an optional `canSubmit(doc, url)` veto, checked by
the content script's `clickableSubmit()`; Indeed permits submission only on the
review step, or where a button literally says it submits. Without it the runner
would press continue on step one, see no confirmation, and record a
"submitted but not confirmed" application having sent nothing.

The apply machine now follows the application into a tab the page opens itself
(`adoptNewTab`), since Indeed's apply button is as likely to open a new tab as
to navigate, and tracks those windows for cleanup. `MAX_WIZARD_STEPS` rises from
8 to 14 to reach submit on postings with long questionnaires.

## Testing

58 new unit tests across `keepalive`, `run-state`, `indeed-urls` and
`indeed-adapter`, alongside the 161 existing tests. The URL tests pin the remote
filter on every generated URL and that phrases are never concatenated; the
adapter tests pin the submit veto per step and that host matching cannot be
fooled by `indeed.com.evil.test`.

## Known limits

- Selectors were written from known Indeed markup, not captured live: the
  Claude-in-Chrome extension was not connected and the Playwright MCP server
  failed to connect. They are layered (stable `data-testid`, then older
  semantic class, then structural fallback) to survive rotation, but a live
  verification pass is still owed.
- Realistic throughput is roughly 60–150 applications overnight, not several
  hundred; the ceiling is the serialised model session and page load times.
- Automated applying is against Indeed's terms of service. The realistic
  failure mode at this volume is account rate-limiting or suspension.
- Confirmation emails arrive for Indeed Easy Apply and some ATSes; a share of
  redirect-applies confirm on-page only.
