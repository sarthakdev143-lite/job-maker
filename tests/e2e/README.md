# End-to-end apply harness

This runs the **real extension** — service worker, worker window, content
scripts and all — against a local application form, from a queued job to a
confirmed submission. It is the only test in this repository that exercises
document upload, wizard advance, submit and verification.

It earned its place. Four hundred and fifty unit tests were green while three
separate defects made every company-hosted multi-step form unfinishable:

1. `readyToSubmit` defaulted to `true` for any site without an adapter opinion,
   so the runner was told the first page was the last one;
2. the generic adapter hard-coded `multiStep: false`, so it never advanced;
3. documents were generated only if the *first* page carried a file input, so a
   wizard that asks for a resume on page two never got one attached — and could
   not get past its own required upload.

Each one is invisible to a fixture test and obvious within seconds here.

## Running it

Needs a Chromium-family browser on disk and `playwright-core`:

```sh
npm install --no-save playwright-core
npm run build
node tests/e2e/run-mock-apply.mjs <profile-dir> tests/e2e/mock-ats.html
```

Edit `BRAVE` at the top of the runner to point at whichever Chromium build is
installed (Chrome, Brave, Edge — any of them works).

Two setup steps the script cannot do for itself:

- **Host permission.** The mock is served from `https://localhost:8443`, which
  the shipped manifest does not list. Add `https://localhost/*` to
  `host_permissions` and to both non-DeepSeek `content_scripts` entries in
  `dist/manifest.json` after building. Patch the build output, never the source.
- **A certificate.** Generate a self-signed pair next to the runner, which
  launches the browser with `--ignore-certificate-errors`:

  ```sh
  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 2 -nodes -subj "//CN=localhost"
  ```

## What the mock is

`mock-ats.html` is a three-step wizard built to be awkward in the ways real ones
are: a react-select country picker whose input is a search box rather than the
value, per-step validation that refuses to advance while anything required is
blank, a required file upload on page two, a button that relabels itself from
"Continue" to "Next", and later steps that are genuinely absent from the
document until reached. It posts every validation result and every event that
reaches a step button back to the runner, so a click that never lands is
distinguishable from one that lands and is refused.

## A passing run

```
wizard: advanced: (text: Continue)
attach: Aarav_Sharma_Resume.pdf: attached
wizard: advanced: (text: Next)
wizard: reached the final step
submit: button[type="submit"] Submit application
verify: success_text: Your application has been submitted
status: submitted
```

The model tier is deliberately stubbed with an invalid API key: the driver's
`health()` only checks that a key and model are set, so the agent starts and
every completion fails. What the run proves is that the profile, canonical and
guess tiers can carry an application to submission with no model reachable at
all.
