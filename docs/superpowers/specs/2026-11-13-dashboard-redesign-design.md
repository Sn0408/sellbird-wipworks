# Dashboard redesign: design

Date: 2026-11-13
Status: awaiting approval

## Why

This fork exists to turn Sellbird into something a customer can use without
reading the code. We are testing it on our own business first. The engine
(agents, API, integrations, database) already works; what stands between it
and a customer is the dashboard. So this project changes how the dashboard
looks and behaves and nothing else.

The new look was designed in Claude Design. The export is the visual source
of truth for every screen.

## Source of truth

- `design-screens/new/extracted/Sellbird.dc.html`: the interactive mockup of
  all 15 screens. It is built on a React component library, so it doesn't run
  from `file://`. Serve the folder with `python3 -m http.server` and open it.
  Its inline `<style>` block holds our brand overrides: teal `#003c3a`, hover
  `#0b5350`, teal tints `#8fbab7` / `#d6e8e6` / `#eef5f4`, and orange accent
  `#f86a24`.
- `design-screens/new/extracted/_ds/.../_ds_bundle.css`: the base tokens the
  mockup inherits (greys, status colours, radii, shadows, type sizes). Read
  values from it. Never copy the file.
- `design-screens/new/extracted/assets/sellbird-logo.png`: the new logo.
- `design-screens/desktop-light/` and `desktop-dark/`: screenshots of the
  dashboard as it is today, for before/after comparison.

`design-screens/` is in `.git/info/exclude`. It holds real prospect data and
must never be committed.

## Goals

1. Every one of the 15 tabs matches the mockup in layout, components, colour,
   type and spacing, at 1440px desktop width.
2. The dashboard stays usable at phone width (390px), as it is today.
3. Dark mode keeps working, with a teal-and-orange dark palette that we derive
   ourselves (the mockup is light only).
4. Everything the dashboard can do today, it can still do afterwards: every
   button, form, keyboard shortcut, drill-down, modal and export.

## Non-goals

- Backend changes of any kind. `sellbird/dashboard.py`, the `/api/*` routes and
  their responses, the agents, integrations, config and database stay exactly
  as they are. If a screen in the mockup needs data no current endpoint
  returns, the builder derives it from existing responses in the browser or
  leaves that element out and lists it for us. The builder doesn't add an
  endpoint.
- New product features. Anything in the mockup that is mock-only goes on the
  "left out" list.
- Upstreaming this to the original project.

## Anti-goals (failure even if it looks right)

- Any lost feature or broken flow, especially Outbox approve/reject/edit, the
  autopilot switch, sending pause/resume, signal confirm/reject, the cohort
  builder, discovery estimate/run/stop and the TrulyInbox connect step.
- The dashboard token leaking anywhere new: a URL, a log, an external request.
  `auth.js` doesn't change.
- Any request to a third-party host. Today the dashboard loads nothing from
  the internet, and that stays true. That includes fonts.
- Shipping the mockup's design-system code (`_ds_bundle.css/js`,
  `support.js`) or any React. That library recreates another company's
  product UI. We take spacing, sizing and structure from it and write our own
  CSS in our own brand colours.
- Adding a build step, a framework or an npm dependency.

## Constraints

- Plain HTML, CSS and JS in `sellbird/web/`, served from disk, no build step.
- The engine stays identical to upstream, so we can keep pulling fixes for the
  engine. `sellbird/web/` is ours to change freely; future upstream changes to
  it will be merged by hand.
- The existing test suite (about 3,700 tests) must pass. Several tests read
  `sellbird/web/app.js` and `index.html` for labels, element ids and function
  names (`tests/test_dashboard_*.py`, `test_sending_mode.py`,
  `test_writer_require_tip.py`, `test_accelerators_funding.py`,
  `test_brain_provider.py`, `test_packaging.py`). Where a redesign renames
  something a test checks, keep the old hook or update the test's expected
  string. A test that checks behaviour must not be weakened to pass.
- The repo is public. No real person or business in code, tests, docs or
  commits, and no screenshots with real data committed.

## How it gets made

Two phases, each ending in a working dashboard we can use.

### Phase 1: restyle (CSS first)

Change the whole look across all 15 tabs, mostly through `app.css`:

- **Tokens.** Replace the colour, type, radius and shadow tokens in `:root`
  (light) and the dark block with the new palette. Primary actions, active nav
  and toggles use teal; orange is the small accent (logo, notification dot).
  The status colours (good/wait/bad/active/note) remap to the mockup's tinted
  badge colours.
- **Font.** Ubuntu Sans (SIL Open Font License), self-hosted as woff2 in
  `sellbird/web/fonts/` next to the current fonts, with its licence file. The
  mockup's base text is 12px with 20px page titles, so the type scale tokens
  follow that. Monospace stays a system stack.
- **Components.** Restyle what already exists to the mockup's look: sidebar
  and nav groups, cards (flat, 1px border, 8px radius), tables (dense 34px
  rows, quiet headers), buttons (one teal primary per view), inputs, badges
  (tinted pill with a word, never colour alone), metric tiles, empty states,
  toasts, modals, kbd hints.
- **Top bar.** Add the mockup's top bar to `index.html`: the "Sellbird
  running" switch (wired to the existing `/api/sellbird/status`, `start` and
  `stop` calls the Controls tab already makes), Refresh, and a bell whose dot
  shows when Today has something waiting. Move the theme switch out of the
  sidebar footer to wherever it fits the new layout.
- **Logo.** Swap in the new logo.

At the end of phase 1, every tab has the new look on its current layout.

### Phase 2: full match (tab by tab)

Restructure each tab's markup and the JS that renders it until it matches the
mockup, in this order: Today, Outbox, Signals, Your company, then the
remaining 11. The structural changes we already know of:

- **Today:** a 4-number summary strip, the "Next" bar with a Go button, the
  pipeline as a table (step, status badge, progress), "Contacts by stage" as
  a compact grid, collector runs and recent activity as tables.
- **Outbox:** summary numbers, To review / Scheduled / Sent / Rejected tabs
  above the table, status badges, row menus, pagination. The review card and
  its A/R/E/J/K shortcuts must keep working.
- **Signals:** sub-tabs (Discovery, Profile, People, Contactability, Cohort
  builder), each signal a row with label, code, description, cost note,
  "seen on N companies", a status badge and an on/off switch that calls the
  existing confirm/reject endpoint.
- **Your company:** a summary table, one row per section with a "Set" badge,
  that opens the existing edit form for that section.

The builder compares every other tab against its mockup screen and makes it
match.

Each tab is done when it matches its mockup screen at 1440px, works at 390px
and in dark mode, and all its existing actions still work against the live
API.

## Protecting the live setup

Sellbird is already running for real: a warmup in progress, approved emails
scheduled, a heartbeat every 15 minutes. The build must not touch any of it.

- **Separate copy.** All work happens in a git worktree on its own branch,
  not in the main checkout. The running `sellbird run` and the dashboard on
  port 5555 keep serving the untouched files until we merge.
- **Separate data.** The worktree gets a copy of `data/sellbird.db` and the
  local config, so clicking Approve, Reject, Confirm or Discover while testing
  changes only the copy. The real database, outbox and schedule are never
  written by the build.
- **No way to send.** The worktree's `.env` holds no mailbox, verifier,
  discovery or warmup keys, so nothing in the copy can send email, read the
  inbox, spend credits or talk to TrulyInbox. The test dashboard runs on
  another port (e.g. 5556). Never press the top bar's start switch against
  the copy without first confirming it has no keys.
- **Config untouched.** Warmup settings (`channels.email.warmup`), daily
  limits, quiet hours, approval mode and the TrulyInbox connection live in
  config and `.env`, which this project doesn't change. The new dashboard
  reads and writes them through the same API calls as today.
- **Switching over.** When a phase is approved, it's merged into `main`. The
  live dashboard picks it up on a page reload; `sellbird run` needs no
  restart because it doesn't use these files.

## Decisions on the gaps (made by Claude, flagged for review)

- **Scope.** Build every mockup element that needs no backend change: search
  and filters, column picker, detail pages for a contact, campaign, discovery
  source and inbox, row menus, pagination. (User's decision.)
- **Outbox review.** Mockup style: each email opens on its own page with
  Reject / Edit / Approve, and the A/R/E/J/K shortcuts work there, J/K moving
  to the next or previous pending email. (Claude's default; the user can
  switch to keeping the current review card.)

- **Signal switches.** Undecided (proposed) signals keep Confirm / Skip
  buttons instead of a switch, so "not decided" never looks like "off". Once
  decided, the switch shows confirmed (on) or rejected (off) and flipping it
  calls the existing status endpoint. The per-group "Confirm all N" /
  "Skip all N" buttons stay and still never undo a decision.
- **Today when something is waiting.** Waiting items (emails to approve,
  offers accepted and so on) render as a list in the "Needs you" area above
  the pipeline, styled like the mockup's banner rows. The setup checklist and
  the TrulyInbox warmup step each get a card in the same style, shown only
  when they apply. The live status line, trend and figures stay, restyled to
  the mockup's metric strip and card look.
- **Failed and cancelled emails.** The Outbox's fourth tab is "Didn't send"
  and holds rejected, failed and cancelled emails, each with its own status
  badge, so a stuck send is never hidden.
- **Counts the API can't give exactly.** Where a mockup number can't be
  computed from what an endpoint returns (the Outbox returns only the last 25
  sent), show what can be counted and label it honestly ("last 25"), or leave
  the number out. Never show a guess as a fact.
- **Screenshot script.** `design-screens/shoot_dashboard.py` (gitignored,
  next to the screenshots) is the script that made the "before" captures. It
  reads the dashboard link itself and never prints it. Comparison runs use it
  against the real local database, and the captures stay in the gitignored
  folder.
- **Sample copy in the mockup** contains real names. None of it goes into
  code, tests or docs; use the live data or `example.com` placeholders.

## How we check it

- After each phase and each restructured tab: screenshot the real dashboard
  (light, dark, mobile) with `design-screens/shoot_dashboard.py` and compare
  against the mockup. Click through every action on that tab.
- Full test suite passes.
- The browser's network panel shows no request leaving `127.0.0.1`.

## Left to the builder

- Exact dark-mode colours, as long as contrast meets WCAG AA and teal and
  orange still read as the brand.
- How to split `app.css` and `app.js` (or not), and how to structure the new
  markup. Prefer small render helpers over a framework.
- Phone-width layout for the new structures (the mockup is desktop only).
- How to page tables client-side when an endpoint returns everything at once.
- Wording of any label the mockup doesn't show.
