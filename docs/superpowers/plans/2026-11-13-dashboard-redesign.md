# Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every dashboard tab match the Claude Design mockup (restyle first, then full structural match) without changing anything outside `sellbird/web/` except tests.

**Architecture:** Plain HTML/CSS/JS in `sellbird/web/`, no build step. Phase 1 swaps tokens, font, component styles and adds a top bar, almost all in `app.css`. Phase 2 adds a small "UI kit" of pure render functions (data → HTML string) to `app.js` and rebuilds each tab with them. Every pure render function is a top-level `function` so tests can extract and run it under node, the pattern the suite already uses.

**Tech Stack:** Vanilla JS (ES2020), CSS custom properties, FastAPI static serving (unchanged), pytest + node 22 for render tests, Playwright with installed Chrome (`channel="chrome"`) for screenshots.

**Spec:** `docs/superpowers/specs/2026-11-13-dashboard-redesign-design.md`

## Global Constraints

- Only files under `sellbird/web/` and `tests/` change, plus docs. `sellbird/dashboard.py`, every `/api/*` route and response, agents, integrations, config and DB schema stay byte-identical.
- No build step, no framework, no npm dependency, no React. Never copy `_ds_bundle.css`, `_ds_bundle.js` or `support.js` from the export.
- No request to any host other than the dashboard's own origin. Fonts self-hosted in `sellbird/web/fonts/`.
- `auth.js` does not change. `app.js` never calls `fetch(` directly (only `api()` / `authFetch()`), never writes `href="' + escHtml(` (use `safeHref`).
- Brand: teal `#003c3a`, hover `#0b5350`, tints `#8fbab7` / `#d6e8e6` / `#eef5f4`, orange accent `#f86a24`. Font Ubuntu Sans. Base text 12px, page title 20/28, section title 15/20, card title 13/18, table rows 34px high, table header/captions/badges 11/14. Radii 4/6/8/12. Values for greys, status colours and shadows come from `design-screens/new/extracted/_ds/*/_ds_bundle.css` (read values, don't copy the file).
- Status is always a badge with a word, never colour alone. Empty values render as an em dash.
- Existing test hooks in `app.js` stay as they are: the top-level functions `escHtml`, `jsq`, `own`, `safeHref`, `formatDate`, `icon`, `brainCallChips`, `quotaCardHtml`, `optOutPanel`, `convoActions`, `sendingModeBanner`, `sendingModeCard`, the constant `OPT_OUT_RULES`, the `STATUS` object, and the source order `lockIfRefused` < `showLock` and `runCohort` < `exportCohort` < `pageCohort` (tests slice between them). Strings those tests assert (e.g. "Approval mode", "Turn on autopilot…") stay. In `index.html`: `/static/auth.js` before `/static/app.js`, `downloadCsv('/api/export/prospects.csv'`, `value="accelerator"`, `value="funding"`.
- The repo is public. No real person or business name, email or domain in code, tests, docs or commits. The mockup's sample copy has real names: never copy it. Use `example.com` data in tests. `design-screens/` stays uncommitted.
- Work only in the worktree from Task 1. Never run anything against `/Users/sabarishnair/outreach agent/data/sellbird.db` and never use the main checkout's `.venv` in the worktree. Never press the top bar's start switch against the dev copy.
- A redesign may not drop any feature. If a mockup element needs data no endpoint returns, show what can be counted with an honest label ("last 25") or leave it out and add it to `docs/dashboard-redesign-left-out.md`.

## Review Focus

1. **Keyboard shortcuts while typing.** A/R/E/J/K in the Outbox email page must do nothing when focus is in an input, textarea, select or contenteditable, so editing a draft never approves or rejects it. Test in Task 8.
2. **Scraped text in new render functions.** Company names, subjects, URLs and notes come from websites and replies. Every new render function escapes text with `escHtml` and links with `safeHref`. `<b>x</b>` must render as text and `javascript:` links must render no `href`. Test in Task 6 (kit) and in each tab task's render test.
3. **A fresh install with no data.** Every tab and detail page must show an empty state, never "undefined", "NaN" or a blank card, when the endpoint returns empty lists or zero counts. Test in Task 6 (`uiTable` empty, `uiMetricStrip` with missing values) and in each tab's render test.
4. **API failure or lock mid-session.** If `start`/`stop` fails, the running switch returns to its previous position and shows a toast. A 401 still shows the lock screen, and an offline API shows `offlineState()`, not an empty table. Test in Task 4.
5. **Phone width with long values.** At 390px, long emails, company names and 300-row tables must not cause horizontal page scroll; wide tables scroll inside their card. Checked by the screenshot run in every tab task, with a test in Task 3 that `.ui-table-wrap` has `overflow-x: auto`.

---

## File Structure

| File | Responsibility |
|---|---|
| `sellbird/web/app.css` | Tokens (light + dark), base type, every component style. Keeps its current single-file shape. |
| `sellbird/web/index.html` | Shell: sidebar, new top bar, one `<section>` per tab. |
| `sellbird/web/app.js` | Gains a `// ── UI kit ──` section (pure render helpers) right after `// ── Small render helpers ──`; each tab's loader/renderer is rebuilt in place, in its existing section. |
| `sellbird/web/fonts/ubuntu-sans.woff2`, `fonts/OFL-ubuntu-sans.txt` | Self-hosted font and its licence. |
| `sellbird/web/sellbird-logo.png` | New logo (from `design-screens/new/extracted/assets/sellbird-logo.png`). |
| `tests/test_dashboard_ui.py` | New: node-harness tests for every new render function, the token contrast test, and the static checks. |
| `docs/dashboard-redesign-left-out.md` | New: mockup elements left out and why. |
| `design-screens/shoot_dashboard.py` | Screenshot script (uncommitted). Gains `--root`, `--port`, `--out`. |

Node harness used by every render test (put once at the top of `tests/test_dashboard_ui.py`):

```python
def run_js(names, call, prelude=""):
    """Extract top-level functions/consts by name from app.js and run `call` under node."""
    # for each name: re.search(rf"^(?:async )?function {n}\(.*?^}}\n|^const {n} = .*?^}};?\n", src, re.S | re.M)
    # skip when shutil.which("node") is None; return stdout of `node -e prelude + parts + call`
```

---

## Phase 1: Restyle

### Task 1: Isolated build copy

**Files:**
- Create (outside git): `.worktrees/ui-redesign/` worktree on branch `ui-redesign`
- Modify (uncommitted): `design-screens/shoot_dashboard.py`
- Commit: `docs/superpowers/specs/2026-11-13-dashboard-redesign-design.md`, this plan

**Interfaces:**
- Produces: dev dashboard at `http://127.0.0.1:5556`, worktree path `WT=/Users/sabarishnair/outreach agent/.worktrees/ui-redesign`, screenshot command `python design-screens/shoot_dashboard.py --root "$WT" --port 5556 --out design-screens/after/<label>`.

- [ ] **Step 1:** Use superpowers:using-git-worktrees. Add `.worktrees/` to `.git/info/exclude`, then `git worktree add .worktrees/ui-redesign -b ui-redesign main`.
- [ ] **Step 2:** In the worktree: `/opt/homebrew/bin/python3.13 -m venv .venv && .venv/bin/pip install -e .`
- [ ] **Step 3:** Copy data without keys. Run `.venv/bin/python -c "import sqlite3; s=sqlite3.connect('file:/Users/sabarishnair/outreach agent/data/sellbird.db?mode=ro', uri=True); d=sqlite3.connect('data/sellbird.db'); s.backup(d)"` (after `mkdir data`). Copy `sellbird.local.yaml` and `skills/` from the main checkout. Create `.env` containing only the non-secret host lines: `SMTP_HOST`, `SMTP_PORT`, `IMAP_HOST`, `IMAP_PORT`. No usernames, passwords or API keys.
- [ ] **Step 4: Verify isolation.** `SELLBIRD_HOME="$WT" .venv/bin/python -c "from sellbird.paths import PROJECT_ROOT; print(PROJECT_ROOT)"` prints the worktree path. `grep -cE 'KEY|PASSWORD|USERNAME|SECRET|TOKEN' .env` prints `0`.
- [ ] **Step 5:** Start the dev dashboard in the background from the worktree: `SELLBIRD_HOME="$WT" .venv/bin/sellbird dashboard --port 5556`. Never print its URL.
- [ ] **Step 6:** Give `shoot_dashboard.py` `--root` (default main checkout), `--port` (default 5555) and `--out` arguments. It gets the URL from `<root>/.venv/bin/sellbird dashboard --url --port <port>` with `SELLBIRD_HOME=<root>`, and never prints it. Run it against 5556 into `design-screens/after/baseline`. Expected: 45 PNGs matching `design-screens/desktop-light` etc.
- [ ] **Step 7:** Run `.venv/bin/pytest -q` in the worktree. Expected: all pass (about 3,700). Record the count.
- [ ] **Step 8: Commit** the spec and this plan on `ui-redesign`: `git commit -m "Docs: dashboard redesign design and plan"`.

### Task 2: Tokens, font and logo

**Files:**
- Modify: `sellbird/web/app.css` (the `@font-face` blocks and the `:root` / dark token blocks, lines ~20–130)
- Modify: `sellbird/web/index.html` (sidebar brand)
- Create: `sellbird/web/fonts/ubuntu-sans.woff2`, `sellbird/web/fonts/OFL-ubuntu-sans.txt`, `sellbird/web/sellbird-logo.png`
- Test: `tests/test_dashboard_ui.py`

**Interfaces:**
- Produces CSS tokens later tasks use (keep the existing token names so current rules keep working; add new ones):
  `--brand #003c3a`, `--brand-hover #0b5350`, `--brand-300 #8fbab7`, `--brand-100 #d6e8e6`, `--brand-50 #eef5f4`, `--accent-orange #f86a24`. Existing `--accent`, `--accent-hover`, `--accent-soft`, `--accent-line` map to these. Status tokens `--good/--wait/--bad/--active/--note` (+ `-bg`, `-line`) remap to the mockup's green/yellow/red/blue/purple badge colours. `--sans: 'Ubuntu Sans', -apple-system, …`. `--fs-*` follow the type sizes in Global Constraints.

- [ ] **Step 1: Write failing tests:**
  - `test_web_assets_are_self_hosted`: `app.css` and `index.html` contain no `http://` or `https://` URL and no `@import`. `fonts/ubuntu-sans.woff2` and `fonts/OFL-ubuntu-sans.txt` exist, and `app.css` has `font-family: 'Ubuntu Sans'` in an `@font-face`.
  - `test_brand_tokens`: `app.css` `:root` has `--brand: #003c3a` and `--accent-orange: #f86a24`.
  - `test_logo_served`: `GET /static/sellbird-logo.png` with the test client returns 200 `image/png`, and `index.html` references it.
- [ ] **Step 2:** Run `pytest tests/test_dashboard_ui.py -v`. Expected: FAIL.
- [ ] **Step 3:** Fetch Ubuntu Sans (variable woff2) and its OFL licence from the official upstream release at `github.com/canonical/Ubuntu-Sans-fonts`. Save them to `sellbird/web/fonts/`. If the release has no woff2, convert the TTF with `fonttools` in a scratch venv. Don't add fonttools to the project. Copy the logo.
- [ ] **Step 4:** Rewrite the light and dark token blocks. The dark palette is ours: a near-black surface with a cool tint, teal lifted for contrast (primary buttons on dark keep white text on a teal of at least `#0b5350`), orange unchanged.
- [ ] **Step 5:** Run the tests, then the full suite. Expected: PASS.
- [ ] **Step 6:** Screenshot to `design-screens/after/task2`. Compare `01-today` with `design-screens/mockup/01-today.png`.
- [ ] **Step 7: Commit:** `UI: brand tokens, Ubuntu Sans and new logo`

### Task 3: Component restyle and dark mode

**Files:**
- Modify: `sellbird/web/app.css` (component rules)
- Test: `tests/test_dashboard_ui.py`

**Interfaces:**
- Produces CSS classes for Phase 2 (styled here, used later): `.ui-card`, `.ui-card__head`, `.ui-card__title`, `.ui-metrics` / `.ui-metric` (`__label`, `__value`, `__sub`), `.ui-table-wrap`, `.ui-table`, `.ui-badge` with `.is-success/.is-danger/.is-warning/.is-info/.is-neutral`, `.ui-tabs` / `.ui-tab[aria-selected]` / `.ui-tab__count`, `.ui-chips` / `.ui-chip[aria-pressed]`, `.ui-switch`, `.ui-pager`, `.ui-menu`, `.ui-crumbs`, `.ui-pagehead` (`__title`, `__sub`, `__actions`), `.ui-banner`, `.ui-empty`. Existing classes (`.card`, `.btn`, `.btn-primary`, tables, `.badge`, nav, toasts, modals, `kbd`) are restyled to the same look so Phase 1 changes every tab.

- [ ] **Step 1: Write failing tests:**
  - `test_contrast_meets_aa`: parse the hex tokens from the `:root` block and from the dark block. For both, the WCAG contrast of each pair must be ≥ 4.5: `--text` on `--surface`; `--text-muted` (or the existing muted token) on `--surface`; `#ffffff` on `--brand`; and each status `--good/--wait/--bad/--active/--note` on its `-bg`.
  - `test_wide_tables_scroll_inside_card`: `app.css` has a `.ui-table-wrap` rule with `overflow-x: auto`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Restyle to the mockup:
  - Sidebar 244px with nav groups.
  - Flat cards: 1px `--line`, 8px radius, no heavy shadow.
  - Dense tables: 34px rows, 11px uppercase-free headers in muted text.
  - One teal primary button, secondary buttons as white with a border.
  - Tinted pill badges, metric strip, inputs, toasts, modals, kbd.
  - Dark versions of all of these.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5:** Screenshot all three variants to `design-screens/after/task3`. Check every tab in light, dark and 390px. Every tab must read cleanly in the new look, with no horizontal page scroll at 390px.
- [ ] **Step 6: Commit:** `UI: restyle components to the new design, light and dark`

### Task 4: Top bar

**Files:**
- Modify: `sellbird/web/index.html` (add `<header class="ui-topbar">` above the sections; move the theme switch into it; keep the sidebar "Sellbird is running" footer only if the top bar is hidden at 390px)
- Modify: `sellbird/web/app.js` (Controls section, near `loadSellbirdStatus` line ~1412)
- Test: `tests/test_dashboard_ui.py`

**Interfaces:**
- Consumes: existing `startSellbird()`, `stopSellbird()`, `loadSellbirdStatus()`, `/api/sellbird/status` (`{running: bool, …}`), `/api/today`.
- Produces:
  - `function topbarHtml(state)`: `state = {running: bool|null, busy: bool, waiting: number}` → HTML string. Contains a `.ui-switch` labelled "Sellbird running" (disabled when `busy` or `running === null`), a Refresh button calling the existing `loadCurrentTab()`, and a bell button `aria-label="Notifications"` that calls `goTab('today')`. The bell gets class `has-dot` when `waiting > 0`.
  - `async function setRunning(on)`: calls `startSellbird()` or `stopSellbird()`. On failure it restores the previous switch state and calls `showToast(msg, 'error')`.

- [ ] **Step 1: Write failing tests** (node harness on `topbarHtml`):
  - `{running:true, busy:false, waiting:0}` → contains `Sellbird running`, the switch is `checked`, and there's no `has-dot`.
  - `{running:false, busy:false, waiting:3}` → switch not checked, `has-dot` present.
  - `{running:null, busy:false, waiting:0}` → switch `disabled`.
  - `test_running_switch_reverts_on_failure`: run `setRunning(true)` under node with `startSellbird` stubbed to resolve `{error:'x'}` and `showToast` recorded. Afterwards the rendered state is `running:false` and one error toast was recorded.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Render the top bar on load and after each status poll, and get `waiting` from the data `loadToday()` already fetches. Don't add a second poll.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5:** On 5556, check by looking only: the switch reflects the copy's status, the bell dot matches Today's waiting count, Refresh reloads the tab. **Don't toggle the switch** against the copy.
- [ ] **Step 6: Commit:** `UI: top bar with running switch, refresh and notifications`

### Task 5: Phase 1 checkpoint

- [ ] **Step 1:** Full suite passes. Screenshot all variants into `design-screens/after/phase1`.
- [ ] **Step 2: Network check.** Load every tab on 5556 in a Playwright page with `page.on("request")` recording URLs. Expected: every URL starts with `http://127.0.0.1:5556`.
- [ ] **Step 3:** Show the user before/after for Today, Outbox and Signals (light + dark). **Stop and wait for approval.**
- [ ] **Step 4 (on approval):**
  - Merge `ui-redesign` into `main` in the main checkout with `git merge --ff-only ui-redesign`. If main has moved, use a normal merge.
  - Tell the user to reload their 5555 dashboard.
  - Don't restart `sellbird run`, and don't push unless asked.

---

## Phase 2: Full match

Every tab task follows the same pattern:
1. Open the mockup screen. Serve `design-screens/new/extracted` with `python3 -m http.server 8765 --bind 127.0.0.1` and open `/Sellbird.dc.html`, or look at `design-screens/mockup/NN-*.png`. Compare it with today's tab and list the differences.
2. Write failing render tests for the new pure functions, with `example.com` data, an empty-data case and an escaping case.
3. Implement.
4. Pass the full suite.
5. Screenshot that tab in all three variants and compare with the mockup.
6. Click through every action on the tab against 5556. The copy has no keys, so actions that need a provider fail gracefully; check they show a clear error, not a broken page.
7. Commit `UI: <tab> matches the new design`.

Tab tasks only restate what is specific to them.

### Task 6: UI kit

**Files:**
- Modify: `sellbird/web/app.js` (new `// ── UI kit ──` section after `// ── Small render helpers ──`)
- Test: `tests/test_dashboard_ui.py`

**Interfaces (Produces, all top-level pure functions returning HTML strings; `js` arguments are inline-handler source strings built with `jsq`, matching the file's existing `onclick` style):**
- `uiBadge(tone, text, iconName = '')`. `tone` is one of `'success'|'danger'|'warning'|'info'|'neutral'`; anything else is treated as `'neutral'`.
- `uiPageHead({title, sub = '', crumbs = [], actions = ''})`, where `crumbs: [{label, js}]`.
- `uiMetricStrip(items)`, where `items: [{label, value, sub = '', delta = ''}]`. A missing or null `value` renders `—`.
- `uiTabs(items, activeKey, onSelect)`, where `items: [{key, label, count}]` and `onSelect: (key) => js`.
- `uiChips(items, onToggle)`, where `items: [{key, label, on}]`.
- `uiSwitch({id, checked, label = '', disabled = false, onChange})`, where `onChange: js`.
- `uiTable({columns, rows, rowKey, onRow = null, empty = 'Nothing here yet', visible = null})`, where `columns: [{key, header, align = 'left', render = (row) => escHtml(row[key])}]` and `onRow: (row) => js`. Output is wrapped in `.ui-table-wrap`. `visible` is an array of column keys to show.
- `uiPager({total, offset, size, onPage})`, where `onPage: (newOffset) => js`. It shows "N results" plus Previous/Next, disabled at the ends.
- `uiRowMenu(items)`, where `items: [{label, js, danger = false}]`.
- `uiEmpty(title, desc = '', actionHtml = '')`.
- `uiColumns(tableKey, columns, visible, onChange)`. A column picker; `onChange: (keys) => js`.
- `loadColumns(tableKey, defaults)` / `saveColumns(tableKey, keys)` use `localStorage` key `sellbird-cols-<tableKey>`. Every access is wrapped in try/catch, and failures fall back to `defaults`.
- `pageSlice(rows, offset, size)` → `rows.slice(offset, offset + size)` with offset clamped to `[0, max(0, len - size)]` rounded down to a multiple of `size`.

- [ ] **Step 1: Write failing tests**, one per function. Must include:
  - `uiBadge('bogus','X')` has class `is-neutral`.
  - `uiBadge('success','<b>x</b>')` contains `&lt;b&gt;x&lt;/b&gt;`.
  - `uiTable` with `rows: []` contains `Nothing here yet`.
  - `uiTable` with a row `{name:'<img src=x onerror=1>'}` contains no `<img`.
  - `uiTable` with `visible:['a']` renders only column `a`.
  - `uiMetricStrip([{label:'Sent'}])` contains `—` and not `undefined`.
  - `uiPager({total:120, offset:100, size:50})` has Next disabled; `offset:0` has Previous disabled.
  - `pageSlice` of 5 rows, offset 99, size 2 → the last page (offset 4).
  - `uiPageHead` with crumbs renders `.ui-crumbs` and escapes labels.
  - `loadColumns` under node with a `localStorage` that throws → returns `defaults`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement with `escHtml` for all text and `safeHref` for any link.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5: Commit:** `UI: render kit for the new design`

### Task 7: Today

**Files:** `app.js` Today section (`loadToday`, `loadLiveStatus`, `renderFigures`, `loadFunnel`, `loadRuns`, `loadTodayActivity`, `loadSetupStatus`, `warmupServiceActions`), `index.html` `#today`.

**Interfaces:**
- Produces:
  - `todaySummary(stats, today)` → `uiMetricStrip` of Contacts found (with `+N` badge), Emails sent, Conversations, Waiting on you.
  - `todayNext(today)`: the "Next" bar. It holds the next action and its Go button (the existing `next` data from `/api/live-status`).
  - `todayNeedsYou(items)`: waiting items as banner rows, each with its existing action link. Returns '' when empty; the Next bar then says "Nothing needs you right now…".
  - `pipelineTable(live)`: rows Find businesses, Read their websites, Find emails, Check emails are real, Write first emails, Sent, Replies. Columns are Step (with its sub-line), Status badge (Done / In progress / Waiting) and Progress "N of M". The cost shows "USD 0.02 so far".
  - `stageGrid(funnel)`: the 3×2 grid of stage, count and percentage.
  - `runsTable(runs)` and `activityTable(actions)`.
- The setup checklist and the TrulyInbox warmup step (`connectTrulyInbox`, `useOtherWarmup`) keep their behaviour as `.ui-card`s, shown only when they apply. The trend chart moves into the summary strip as sparkline cells if the mockup shows none; otherwise it goes into the left-out list.

- [ ] **Steps (tab pattern).** Required test cases:
  - `pipelineTable` with all zeros shows Waiting badges and no `NaN`.
  - `todayNeedsYou([])` returns ''.
  - `todayNeedsYou` with a subject `<b>x</b>` escapes it.
  - `stageGrid` with total 0 shows `0%`.

### Task 8: Outbox

**Files:** `app.js` Outbox section (`loadOutbox`, `renderDesk`, `deskEdit`, `deskKeep`, `deskSave`, `deskGo`, `outboxAct`, `outboxApproveAll`, `sendingToggle`, `heldReason`, `renderDeskContext`), `index.html` `#outbox`.

**Interfaces:**
- Consumes: `/api/outbox` as it is today (pending, scheduled, recent sent, and failed/rejected/cancelled items), `sendingModeBanner` (unchanged).
- Produces:
  - `outboxBuckets(data)` → `{review, scheduled, sent, didnt}`. `didnt` holds the rejected, failed and cancelled items.
  - `outboxSummary(b, data)`: a strip of To review, Scheduled ("next sends …"), Sent ("last N" when the endpoint caps it), and Didn't send.
  - `outboxTable(rows, kind)`: To, status badge, Step "Email N", Subject, Sends/Sent, and a row menu. Clicking a row opens `openOutboxEmail(id)`.
  - `outboxEmailPage(item, ctx, pos)`: a breadcrumb "Outbox › <to>", the full email, held reason, prospect context, and Reject / Edit / Approve buttons (Approve is the primary). `pos = {index, count}` shows "2 of 10".
  - `outboxKey(e)`: the A/R/E/J/K handler. It returns early when `e.target` is an input, textarea or select, or `isContentEditable`.
- Tabs: To review / Scheduled / Sent / Didn't send, built with `uiTabs`. Paginate with `uiPager` at 25 per page. "Approve all" and "Pause all sending" stay.

- [ ] **Steps (tab pattern).** Required test cases:
  - `outboxBuckets` puts `failed` and `cancelled` into `didnt`.
  - `outboxEmailPage` escapes the subject and body.
  - `test_shortcuts_ignored_while_typing`: under node, call `outboxKey({key:'a', target:{tagName:'TEXTAREA'}})` with `outboxAct` stubbed. Expect zero calls. With `target:{tagName:'BODY'}` while viewing a pending item, expect one approve call.
  - J and K at the first and last pending item don't wrap past the ends.

### Task 9: Signals

**Files:** `app.js` Signals and Cohort sections (`loadSignals`, `sigRow`, `setSignals`, `renderCohortBuilder` … `pageCohort`, keeping their order), `index.html` `#signals`.

**Interfaces:**
- Produces:
  - `signalsSummary(data)`: a strip of Confirmed, Waiting on you, Turned off, and Companies scored.
  - `signalGroups(signals)` → the groups Discovery, Profile, People, Contactability, mapped from each signal's existing `category`. Any unmapped category goes to Profile.
  - `signalRow(sig)`: label, `code`, description, cost badge ("Paid" when the cost note is not free), "seen on N companies so far", and a status badge.
    - A proposed signal shows Confirm / Skip buttons, which call `setSignals([code], 'confirmed'|'rejected')`.
    - A confirmed or rejected signal shows a `uiSwitch` (on = confirmed). Flipping it calls `setSignals([code], on ? 'confirmed' : 'rejected')`.
  - Each group keeps "Confirm all N" / "Skip all N" for its proposed signals only.
  - The Cohort builder becomes the fifth sub-tab, using the existing functions restyled.

- [ ] **Steps (tab pattern).** Required test cases:
  - `signalRow` for a proposed signal has Confirm and Skip buttons and no switch.
  - A confirmed signal has a checked switch; a rejected one has an unchecked switch.
  - A description containing `<script>` is escaped.
  - The existing cohort tests in `test_dashboard_signals.py` still pass, unedited.

### Task 10: Your company

**Files:** `app.js` Your company section (`loadCompany`, `saveCompanySection`, offer functions), `index.html` `#company`.

**Interfaces:**
- Produces:
  - `companySummary(c)`: a strip of Sections complete, Objections answered, Trained from, and Sender.
  - `companySectionsTable(c)`: rows Offer, What you sell, Who you sell to, Who it's from, Objections and answers, What Sellbird learned from your site. Each row has a status badge (Set / Missing / Trained), the current value and when it was updated. Clicking a row opens `openCompanySection(key)`, which shows that section's existing edit form under a breadcrumb "Your company › <section>".
  - "Preview an email" in the page header uses the existing `previewOffer`.
- Every existing edit, save, suggest, propose and use-offer action keeps working from inside the section page.

- [ ] **Steps (tab pattern).** Required test cases:
  - A section with no value shows the Missing badge and `—`.
  - A value with `<b>` is escaped.

### Task 11: Companies

**Files:** `app.js` Companies section (`loadCompanies`, `renderCompaniesPage`, `companyInfoCard`, `showCompanyContacts`, feedback helpers), `index.html` `#companies`.

**Interfaces:**
- Produces:
  - `companiesFilter(rows, {q, chips})`: client-side search over name and domain. The chips are built from fields `/api/companies` already returns: has website / no website, has contact, has a confirmed signal, and contacted.
  - The companies table uses `uiTable` with `uiColumns` (key `companies`), `uiPager` at 50 per page, and a row menu (View contacts, Open website, Export).
  - `companyDetailPage(company, profile, contacts)` replaces the drill-in with a breadcrumb page. It shows the profile card, signals and contacts table.
- Server paging: if `/api/companies` pages server-side today, keep using its paging and send the search to it only if it accepts a query parameter. Otherwise filter only the loaded page and label the result "on this page".

- [ ] **Steps (tab pattern).** Required test cases:
  - `companiesFilter` matching is case-insensitive.
  - The empty-result state reads `No companies match`.
  - A website `javascript:x` renders with no href.

### Task 12: Contacts

**Files:** `app.js` Contacts section (`loadProspects`, `contactMatches`, `setContactFilter`, `renderContacts`, opt-out functions), `index.html` `#prospects`.

**Interfaces:**
- Produces:
  - `contactsFilter(rows, {q, status, emailStatus})` builds on the existing `contactMatches`.
  - The search box and filter chips cover the email status values (verified / risky / guess / invalid) and the stage. The table uses `uiColumns` (key `contacts`) and `uiPager`.
  - `contactDetailPage(p, extras)` shows the breadcrumb "Contacts › <name>", details list, email status badge, the sequence and its outbox items, and the existing `optOutPanel(p)`, which is embedded unchanged. "Export" buttons stay.

- [ ] **Steps (tab pattern).** Required test cases:
  - `contactsFilter` by `emailStatus:'verified'`.
  - `contactDetailPage` includes the output of `optOutPanel`.
  - An email `<x@example.com>` is escaped.

### Task 13: Campaigns

**Files:** `app.js` Campaigns section (`campaignProgress`, `loadCampaigns`, `fillMergeVars`, `openInGmail`, `markSent`), `index.html` `#campaigns`.

**Interfaces:**
- Produces:
  - `campaignsTable(campaigns)`: name, status badge, contacts, progress and a row menu.
  - `campaignDetailPage(c)`: breadcrumb, summary strip, a steps table (Email 1–3 with subject and body preview), and the contacts table with the existing "Open in Gmail" / "Mark sent" actions.
- Leave out the "New campaign" wizard (it has no endpoint) and add it to `docs/dashboard-redesign-left-out.md`.

- [ ] **Steps (tab pattern).** Required test cases:
  - `campaignDetailPage` with zero contacts shows an empty state.
  - Merge vars in a preview are filled with escaped values.

### Task 14: Discover

**Files:** `app.js` Discover section (`loadDiscoverProviders` … `renderDiscoverResult`), `index.html` `#discover` (keep `value="accelerator"` and `value="funding"`).

**Interfaces:**
- Produces:
  - `sourcesTable(providers)`: Source, cost, free tier, keys needed (a badge for Ready or Needs key) and a row menu.
  - `sourceDetailPage(p)`: breadcrumb, description, pricing, the run form (preset, cities, max spend), and the existing Estimate / Run / Stop buttons and result card.
  - The profile card (`renderProfileCard`, `runProfile`) is restyled in place.

- [ ] **Steps (tab pattern).** Required test cases:
  - A provider with missing keys shows the "Needs key" badge.
  - The estimate result has no `NaN` when the cost is 0.

### Task 15: Inboxes

**Files:** `app.js` Inboxes section (`inboxBadge` … `submitAddInbox`), `index.html` `#inboxes`.

**Interfaces:**
- Produces:
  - `inboxesTable(inboxes)` built with `uiTable`.
  - `inboxDetailPage(ib)` replaces the `inboxDialog` modal for viewing one inbox. It shows the breadcrumb, a status badge, the warmup meter (`inboxMeter`) and the existing actions (rename, cap, pause or resume, test, remove), still posting through `inboxPost`.
  - The add-inbox flows (`openAddInbox`, `connectMainMailbox`, `submitAddInbox`) can stay modal if the mockup shows them as dialogs. Otherwise they become a page.

- [ ] **Steps (tab pattern).** Required test cases:
  - An inbox with no warmup data shows `—`, not `NaN%`.
  - A name with `<b>` is escaped.

### Task 16: Conversations and Activity

**Files:** `app.js` Conversations (`loadConversations`, `renderConversations`, `convoCard`, keeping `convoActions` unchanged, `setConvoStatus`) and Activity (`loadActivity`), `index.html` `#conversations`, `#activity`.

**Interfaces:**
- Produces:
  - `convoTable(convos)`: filter tabs from the existing `_convoFilter` values, plus a table of contact, stage badge, last message and when.
  - `convoDetailPage(c)`: breadcrumb, message thread, and the existing `convoActions(c)` output.
  - `activityFeed(actions)`: `uiTable` with time, event (`actionText`), and an agent badge. It has filter chips by agent and `uiPager`.

- [ ] **Steps (tab pattern).** Required test cases:
  - The existing tests in `test_dashboard_conversations.py` pass unedited.
  - `activityFeed([])` shows an empty state.

### Task 17: Usage, Controls, Settings, Help

**Files:**
- `app.js`: Usage (`loadUsage`, keeping `quotaCardHtml` and `brainCallChips` unchanged), Controls (`loadSellbirdStatus`, `loadLogs`), Settings (`loadSettings`, save functions, `sendingModeCard` unchanged, `renderSendingModeCard`).
- `index.html`: `#usage`, `#controls`, `#settings`, `#help`.

**Interfaces:**
- Produces:
  - Usage: `usageTabs` (by agent / by model / by day) over the existing `/api/usage` data, with a `uiTable` for each.
  - Controls: a status card, Start/Stop (the same functions the top bar uses), and the logs in a monospace card.
  - Settings: grouped `.ui-card` sections (Sending, Mailboxes, Verification, Discovery, Optional) matching the mockup. Every existing field, test button and `saveEnv` call stays, and the autopilot confirm flow (type `autopilot`) is unchanged.
  - Help: a static restyle.

- [ ] **Steps (tab pattern).** Required test cases:
  - The existing tests in `test_sending_mode.py` and `test_brain_provider.py` pass unedited.
  - A settings field that holds a secret still renders masked (assert on the existing mask behaviour).

### Task 18: Finish and hand over

- [ ] **Step 1:** Write `docs/dashboard-redesign-left-out.md`, one line per mockup element left out and why. Include the New campaign wizard plus anything collected along the way.
- [ ] **Step 2:** Run the full suite. The pass count must be ≥ the Task 1 count plus the new tests.
- [ ] **Step 3:** Run the screenshot script for all 45 shots into `design-screens/after/final`. Repeat the network check from Task 5, now including the detail pages.
- [ ] **Step 4:** Click through every flow listed under the spec's anti-goals on 5556:
  - Outbox approve, reject and edit
  - Autopilot switch
  - Pause and resume sending
  - Signal confirm and reject
  - Cohort builder and export
  - Discovery estimate, run and stop (fails cleanly without keys)
  - TrulyInbox connect step
- [ ] **Step 5:** Show the user before/after for every tab. **Stop and wait for approval.**
- [ ] **Step 6 (on approval):** Merge `ui-redesign` into `main`, tell the user to reload 5555, stop the 5556 dashboard, and remove the worktree. Don't push unless asked.
