let currentTab = 'today';
let companyDrill = false;      // true while viewing a single company's contacts
let _companies = [], _prospects = [], _campaigns = [];
let _signals = null;           // last /api/signals payload, for the cohort builder
let _desk = { items: [], i: 0, open: null };

// ── Appearance ──
//
// Three states, not two: "auto" follows the OS and is the default, so the
// dashboard matches the rest of your machine until you deliberately override
// it. Stored per-browser; nothing is sent anywhere.

const THEMES = ['auto', 'light', 'dark'];

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  document.querySelectorAll('[data-theme-opt]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.themeOpt === mode)));
}

function setTheme(mode) {
  try { localStorage.setItem('sellbird-theme', mode); } catch { /* private mode */ }
  applyTheme(mode);
}

(function initTheme() {
  let saved = 'auto';
  try {
    // Carry the choice over from Harvey, Sellbird's old name.
    const legacy = localStorage.getItem('harvey-theme');
    if (legacy && !localStorage.getItem('sellbird-theme')) localStorage.setItem('sellbird-theme', legacy);
    if (legacy) localStorage.removeItem('harvey-theme');
    saved = localStorage.getItem('sellbird-theme') || 'auto';
  } catch { /* ignore */ }
  applyTheme(THEMES.includes(saved) ? saved : 'auto');
})();

// ── Utilities ──

function escHtml(s) {
  if (s === null || s === undefined || s === '') return '';
  return String(s).replace(/[&<>"']/g, ch => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]
  ));
}

// A value placed inside an onclick handler as a JS string: JSON-quote it,
// then escape for the attribute (escHtml alone is undone before the JS runs).
function jsq(v) {
  return escHtml(JSON.stringify(String(v ?? '')));
}

// The reason a failed action gave, or a fallback when it gave none.
function failMsg(data, fallback) {
  return (data && (data.message || data.error || data.detail)) || fallback;
}

// Lookup tables keyed by stored strings: "constructor" must not hit Object's.
function own(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// Links built from collected data (websites, profiles) open only as http(s):
// a javascript: URL from a scraped page must never run in the dashboard.
function safeHref(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? escHtml(s) : '';
}

// ── One status vocabulary ──
//
// Sellbird's tables each carry their own words for state: a prospect is `new`,
// a campaign is `draft`, an email is `pending_review`, a signal is `proposed`.
// Five of those mean "waiting on you" and the old dashboard styled every one
// differently. Everything now resolves through this map, so a status reads the
// same way no matter which table it came out of.
//
// tone: waiting (needs a human) | active (in flight) | good | bad | idle
const STATUS = {
  // prospects
  new:            ['New', 'active'],
  contacted:      ['Contacted', 'active'],
  replied:        ['Replied', 'good'],
  accepted_offer: ['Said yes to your offer', 'good'],
  interested:     ['Interested', 'good'],
  meeting:        ['Meeting booked', 'note'],
  not_interested: ['Not interested', 'bad'],
  bounced:        ['Bounced', 'bad'],
  write_failed:   ["Couldn't write", 'bad'],
  no_tip:         ['Nothing to write about yet', 'idle'],
  queued:         ['Queued', 'active'],
  opted_out:      ['Opted out', 'bad'],
  // campaigns
  draft:          ['Draft', 'waiting'],
  active:         ['Active', 'good'],
  completed:      ['Completed', 'idle'],
  paused:         ['Paused', 'bad'],
  // conversations
  open:           ['Open', 'active'],
  closed:         ['Closed', 'idle'],
  closed_won:     ['Won', 'good'],
  closed_lost:    ['Lost', 'bad'],
  objection:      ['Objection', 'waiting'],
  question:       ['Question', 'active'],
  ooo:            ['Out of office', 'idle'],
  wrong_person:   ['Wrong person', 'waiting'],
  unsubscribe:    ['Unsubscribed', 'bad'],
  escalate:       ['Needs a human', 'bad'],
  needs_human:    ['Needs you', 'waiting'],
  // outbox
  pending_review: ['Waiting on you', 'waiting'],
  approved:       ['Approved', 'good'],
  sending:        ['Sending now', 'active'],
  scheduled:      ['Scheduled', 'active'],
  sent:           ['Sent', 'good'],
  awaiting_reply: ['Awaiting reply', 'active'],
  failed:         ['Failed', 'bad'],
  rejected:       ['Rejected', 'idle'],
  cancelled:      ['Cancelled', 'idle'],
  // signals
  proposed:       ['Waiting on you', 'waiting'],
  confirmed:      ['Confirmed', 'good'],
  // email deliverability
  verified:       ['Verified', 'good'],
  risky:          ['Catch-all', 'waiting'],
  guess:          ['Unverified', 'idle'],
  invalid:        ['Invalid', 'bad'],
  // runs
  running:        ['Running', 'active'],
  stale:          ['Stale', 'bad'],
  stalled:        ['Stopped', 'bad'],
};

function statusMeta(status) {
  const key = String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const hit = own(STATUS, key);
  if (hit) return { label: hit[0], tone: hit[1] };
  const label = String(status || 'unknown').replace(/_/g, ' ');
  return { label: label.charAt(0).toUpperCase() + label.slice(1), tone: 'idle' };
}

function badge(status) {
  const m = statusMeta(status);
  return '<span class="badge t-' + m.tone + '">' + escHtml(m.label) + '</span>';
}

function formatDate(d) {
  if (!d) return '';
  try {
    let t = String(d).trim().replace(' ', 'T');
    if (/^\d{4}-\d\d-\d\dT/.test(t) && !/[zZ]$|[+-]\d\d:?\d\d$/.test(t)) t += 'Z';  // stored UTC
    const dt = new Date(t);
    if (isNaN(dt)) return escHtml(d);
    return dt.toLocaleString('en-US', {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  } catch { return escHtml(d); }
}

// ── Small render helpers ──

// The sprite in index.html holds every icon; this just references one.
function icon(name, cls) {
  return '<svg class="icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
}

function initials(first, last) {
  const a = String(first || '').trim(), b = String(last || '').trim();
  const ch = x => Array.from(x)[0] || '';  // whole characters, not UTF-16 halves
  const s = (ch(a) + ch(b)) || '?';
  return escHtml(s.toUpperCase());
}

// Stored times are UTC, often without a zone ("2026-10-21 03:07:57").
function parseTs(d) {
  let t = String(d || '').trim().replace(' ', 'T');
  if (t && !/[zZ]$|[+-]\d\d:?\d\d$/.test(t)) t += 'Z';
  return new Date(t);
}

// "3m ago", "5h ago", "Yesterday", then a date: recent things read faster.
function relTime(d) {
  if (!d) return '';
  const dt = parseTs(d);
  if (isNaN(dt)) return escHtml(d);
  const mins = Math.round((Date.now() - dt) / 60000);
  if (mins < -1 && mins > -60) return 'in ' + -mins + 'm';
  if (mins < -1 && mins > -60 * 24) return 'in ' + Math.round(-mins / 60) + 'h';
  if (mins >= -1 && mins < 1) return 'just now';
  if (mins >= 1 && mins < 60) return mins + 'm ago';
  if (mins >= 60 && mins < 60 * 24) return Math.round(mins / 60) + 'h ago';
  if (mins >= 60 * 24 && mins < 60 * 48) return 'Yesterday';
  const opts = {month: 'short', day: 'numeric'};
  if (dt.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return dt.toLocaleDateString('en-US', opts);
}

function dayLabel(d) {
  const dt = parseTs(d);
  if (isNaN(dt)) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(dt); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return dt.toLocaleDateString('en-US', {weekday: 'long', month: 'short', day: 'numeric'});
}

function timeOfDay(d) {
  const dt = parseTs(d);
  return isNaN(dt) ? '' : dt.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'});
}

// Columns of a tiny bar chart; the last day is "today".
function sparkBars(values, title) {
  const vals = (values || []).map(v => Number(v) || 0);
  if (!vals.length) return '';
  const max = Math.max(...vals, 1);
  return '<span class="spark" role="img" aria-label="' + escHtml(title || 'trend') + '">' +
    vals.map((v, i) => '<i class="' + (v ? 'on' : '') + '" style="height:' +
      Math.max(2, Math.round(v / max * 28)) + 'px" title="' + v + '"></i>').join('') + '</span>';
}

// A segmented meter, 0-100.
function meterHtml(pct, segments) {
  const n = segments || 10;
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  const on = Math.round(v / 100 * n);
  return '<span class="meter-row"><span class="meter" role="meter" aria-valuemin="0" ' +
    'aria-valuemax="100" aria-valuenow="' + v + '">' +
    Array.from({length: n}, (_, i) => '<i class="' + (i < on ? 'on' : '') + '"></i>').join('') +
    '</span><span class="v">' + v + '</span></span>';
}

const SOURCE_LABELS = {
  company_website: 'Team page', known_company_backfill: 'Team page',
  scraped_mailto: 'Published address', hunter_domain_search: 'Hunter', linkedin_search: 'LinkedIn',
  job_board: 'Job board', web_search: 'Web search', company_inbox: 'Company inbox',
  osm: 'OpenStreetMap', dataforseo_listings: 'DataForSEO', dataforseo_serp: 'DataForSEO SERP', dataforseo_maps: 'DataForSEO Maps',
  serper: 'Serper', tinyfish: 'TinyFish', scavio_maps: 'Scavio Maps', scavio_search: 'Scavio Search',
};
function sourceLabel(s) {
  if (!s) return '';
  return escHtml(Object.prototype.hasOwnProperty.call(SOURCE_LABELS, s) ? SOURCE_LABELS[s]
    : String(s).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()));
}

const AGENT_ICONS = {scout: 'discover', writer: 'pen', sender: 'campaigns', handler: 'message',
                     analyst: 'usage', user: 'contacts', main: 'refresh'};
// One plain sentence per logged action, from the details each agent records.
function actionText(a) {
  const d = a.details || {};
  const who = escHtml(d.prospect_email || d.prospect || d.to || '');
  const camp = escHtml(d.campaign_name || d.campaign || '');
  const intent = d.intent ? ' · ' + escHtml(String(d.intent).replace(/_/g, ' ')) : '';
  const n = (v, one, many) => (Number(v) || 0) + ' ' + ((Number(v) || 0) === 1 ? one : many);
  switch (a.action_type) {
    case 'prospect': return 'Found ' + n(d.prospects_found, 'new contact', 'new contacts');
    case 'write_campaign': return 'Wrote “' + camp + '” for ' + n(d.prospect_count, 'contact', 'contacts');
    case 'write_failed': return 'Couldn’t write for some contacts' + (camp ? ' in “' + camp + '”' : '');
    case 'stage_campaign': return 'Queued ' + n(d.staged, 'email', 'emails') + ' from “' + camp + '”' +
      (d.mode ? ' · ' + escHtml(d.mode) : '');
    case 'send_campaign': return 'Sent “' + camp + '” to Instantly · ' + n(d.leads_added, 'lead', 'leads');
    case 'email_sent': return d.kind === 'reply' ? 'Sent a reply to ' + who
      : 'Sent email ' + escHtml(String(d.step || 1)) + ' to ' + who;
    case 'reply': return 'Answered ' + who + intent;
    case 'reply_queued': return 'Drafted a reply to ' + who + intent;
    case 'opt_out': return who + ' opted out' + (d.why ? ' · ' + escHtml(d.why) : '');
    case 'opt_out_undone': return 'You undid ' + (who || 'a contact') + '’s opt-out';
    case 'reply_after_opt_out': return who + ' wrote again after opting out · no reply sent';
    case 'escalation': return 'Flagged ' + who + ' for you' + (d.reason ? ' · ' + escHtml(d.reason) : '');
    case 'bounce': return 'Email to ' + who + ' bounced';
    case 'manual_send': return 'You marked a contact as emailed by hand';
    case 'manual_send_undone': return 'You undid a hand-sent mark';
    case 'outbox_edited': return 'You edited a draft';
    case 'conversation_status':
      return d.to === 'closed' ? 'You closed a conversation'
        : d.from === 'needs_human' ? 'You handed a conversation back to Sellbird' : 'You reopened a conversation';
  }
  const text = escHtml(String(a.action_type || '').replace(/_/g, ' '));
  return a.agent === 'main' ? 'Heartbeat: ' + text : text;
}

function emptyState(glyph, title, copy) {
  return '<div class="empty"><div class="glyph">' + glyph + '</div>' +
    '<div class="title">' + title + '</div>' +
    '<div class="copy">' + copy + '</div></div>';
}

function offlineState() {
  return emptyState('&#9888;', 'Dashboard can\'t reach the server',
    'The dashboard process may have stopped. Restart it with <b>sellbird dashboard</b> and refresh this page.');
}

async function api(path, opts) {
  try {
    const r = await authFetch(path, opts);
    if (await lockIfRefused(r)) return null;
    if (!r.ok) {
      // An action the server refused says why ("a run is already going");
      // pass that body on so the toast can show it. Reads stay null.
      if (!opts || !opts.method || opts.method === 'GET') return null;
      const body = await r.json().catch(() => null);
      return body && typeof body === 'object' ? {success: false, ...body} : null;
    }
    return await r.json();
  } catch {
    return null;
  }
}

// ── UI kit: the redesign's shared parts ──
// Pure functions: data in, HTML string out. Every text value goes through
// escHtml and every link through safeHref; `js` arguments are inline-handler
// source built with jsq, like the rest of this file.

function uiDash(v) {
  return (v === null || v === undefined || v === '') ? '<span class="ui-dash">—</span>' : escHtml(v);
}

function uiBadge(tone, text, iconName = '') {
  const t = ['success', 'danger', 'warning', 'info', 'neutral'].includes(tone) ? tone : 'neutral';
  return '<span class="ui-badge is-' + t + '">' + escHtml(text) + (iconName ? icon(iconName) : '') + '</span>';
}

function uiPageHead({title, sub = '', crumbs = [], actions = ''}) {
  const trail = crumbs.length
    ? '<nav class="ui-crumbs" aria-label="Breadcrumb">' + crumbs.map(c => c.js
        ? '<a href="#" onclick="' + c.js + ';return false">' + escHtml(c.label) + '</a>'
        : '<span>' + escHtml(c.label) + '</span>').join(icon('chevron', 'ui-crumbs__sep')) + '</nav>'
    : '';
  return '<div class="ui-pagehead"><div class="ui-pagehead__text">' + trail
    + '<h2 class="ui-pagehead__title">' + escHtml(title) + '</h2>'
    + (sub ? '<div class="ui-pagehead__sub">' + escHtml(sub) + '</div>' : '') + '</div>'
    + (actions ? '<div class="ui-pagehead__actions">' + actions + '</div>' : '') + '</div>';
}

// A card. `title` is text; `action` and `body` are HTML the caller built.
function uiCard({title = '', action = '', body = '', cls = ''}) {
  const head = (title || action)
    ? '<div class="ui-card__head">' + (title ? '<h3 class="ui-card__title">' + escHtml(title) + '</h3>' : '<span></span>')
      + (action ? '<div class="ui-card__action">' + action + '</div>' : '') + '</div>'
    : '';
  return '<section class="ui-card' + (cls ? ' ' + cls : '') + '">' + head + body + '</section>';
}

function uiMetricStrip(items) {
  return '<div class="ui-metrics">' + items.map(m =>
    '<div class="ui-metric"><div class="ui-metric__label">' + escHtml(m.label)
    + (m.delta ? ' ' + uiBadge('success', m.delta) : '') + '</div>'
    + '<div class="ui-metric__value">' + uiDash(m.value) + '</div>'
    + (m.sub ? '<div class="ui-metric__sub">' + escHtml(m.sub) + '</div>' : '')
    + '</div>').join('') + '</div>';
}

function uiTabs(items, activeKey, onSelect) {
  return '<div class="ui-tabs" role="tablist">' + items.map(t =>
    '<button type="button" class="ui-tab" role="tab" aria-selected="' + (t.key === activeKey) + '" onclick="'
    + onSelect(t.key) + '">' + escHtml(t.label)
    + (t.count !== undefined && t.count !== null ? '<span class="ui-tab__count">' + escHtml(t.count) + '</span>' : '')
    + '</button>').join('') + '</div>';
}

function uiChips(items, onToggle) {
  return '<div class="ui-chips">' + items.map(c =>
    '<button type="button" class="ui-chip" aria-pressed="' + !!c.on + '" onclick="' + onToggle(c.key) + '">'
    + icon(c.on ? 'check' : 'plus') + escHtml(c.label) + '</button>').join('') + '</div>';
}

function uiSwitch({id, checked, label = '', disabled = false, onChange}) {
  return '<label class="ui-switch"' + (id ? ' for="' + escHtml(id) + '"' : '') + '>'
    + (label ? '<span>' + escHtml(label) + '</span>' : '')
    + '<input type="checkbox" role="switch"' + (id ? ' id="' + escHtml(id) + '"' : '')
    + (checked ? ' checked' : '') + (disabled ? ' disabled' : '')
    + ' onchange="' + onChange + '"></label>';
}

function uiTable({columns, rows, rowKey = null, onRow = null, empty = 'Nothing here yet', visible = null}) {
  const cols = visible ? columns.filter(c => visible.includes(c.key)) : columns;
  const align = c => (c.align && c.align !== 'left') ? ' class="' + c.align + '"' : '';
  const head = '<thead><tr>' + cols.map(c => '<th' + align(c) + '>' + escHtml(c.header) + '</th>').join('') + '</tr></thead>';
  const body = rows.length
    ? rows.map((r, i) => '<tr' + (rowKey ? ' data-key="' + escHtml(rowKey(r, i)) + '"' : '')
        + (onRow ? ' class="ui-row-link" tabindex="0" onclick="' + onRow(r, i) + '"' : '') + '>'
        + cols.map(c => '<td' + align(c) + '>' + (c.render ? c.render(r, i) : uiDash(r[c.key])) + '</td>').join('')
        + '</tr>').join('')
    : '<tr class="ui-empty-row"><td colspan="' + cols.length + '">' + escHtml(empty) + '</td></tr>';
  return '<div class="ui-table-wrap"><table class="ui-table">' + head + '<tbody>' + body + '</tbody></table></div>';
}

function uiPager({total, offset, size, onPage}) {
  const prev = offset <= 0, next = offset + size >= total;
  return '<div class="ui-pager"><span>' + escHtml(total) + ' results</span><div class="ui-pager__btns">'
    + '<button type="button" class="btn btn-sm"' + (prev ? ' disabled' : '') + ' onclick="' + onPage(Math.max(0, offset - size)) + '">Previous</button>'
    + '<button type="button" class="btn btn-sm"' + (next ? ' disabled' : '') + ' onclick="' + onPage(offset + size) + '">Next</button>'
    + '</div></div>';
}

function uiRowMenu(items) {
  return '<details class="ui-menu" onclick="event.stopPropagation()"><summary aria-label="More actions">⋯</summary>'
    + '<div class="ui-menu__list">' + items.map(m =>
      '<button type="button"' + (m.danger ? ' class="danger"' : '') + ' onclick="this.closest(\'details\').open=false;' + m.js + '">'
      + escHtml(m.label) + '</button>').join('') + '</div></details>';
}

function uiEmpty(title, desc = '', actionHtml = '') {
  return '<div class="ui-empty"><div class="ui-empty__title">' + escHtml(title) + '</div>'
    + (desc ? '<div class="ui-empty__desc">' + escHtml(desc) + '</div>' : '') + actionHtml + '</div>';
}

// A full-width notice: an icon, a bold title, a line of text, actions on the right.
function uiBanner({title = '', body = '', actions = '', tone = '', iconName = 'arrow'}) {
  return '<div class="ui-banner' + (tone ? ' is-' + tone : '') + '">' + icon(iconName)
    + '<div class="ui-banner__text">' + (title ? '<div class="ui-banner__title">' + escHtml(title) + '</div>' : '')
    + (body ? '<div>' + escHtml(body) + '</div>' : '') + '</div>'
    + (actions ? '<div class="ui-banner__actions">' + actions + '</div>' : '') + '</div>';
}

// "Edit columns": a checkbox per column; onChange gets the JS for the new key list.
function uiColumns(tableKey, columns, visible, onChange) {
  return '<details class="ui-menu ui-colpick"><summary class="btn btn-sm">Edit columns</summary><div class="ui-menu__list">'
    + columns.map(c => '<label class="check-line"><input type="checkbox" value="' + escHtml(c.key) + '"'
      + (visible.includes(c.key) ? ' checked' : '')
      + ' onchange="' + onChange + '">' + escHtml(c.header || c.key) + '</label>').join('')
    + '</div></details>';
}

function loadColumns(tableKey, defaults) {
  try {
    const v = JSON.parse(localStorage.getItem('sellbird-cols-' + tableKey) || 'null');
    return Array.isArray(v) && v.length ? v : defaults;
  } catch (e) { return defaults; }
}

function saveColumns(tableKey, keys) {
  try { localStorage.setItem('sellbird-cols-' + tableKey, JSON.stringify(keys)); } catch (e) { /* private window */ }
}

function pageSlice(rows, offset, size) {
  const last = Math.max(0, rows.length - 1);
  const o = Math.min(Math.max(0, offset), last);
  const start = Math.floor(o / size) * size;
  return rows.slice(start, start + size);
}

// ── Locked: no token, a wrong one, or the server can't load its own ──

let _locked = false;

async function lockIfRefused(r) {
  if (r.status !== 401 && r.status !== 503) {
    if (r.ok && _locked) hideLock();
    return false;
  }
  let why = '';
  if (r.status === 503) {
    try { why = ((await r.json()) || {}).message || ''; } catch { /* ignore */ }
  }
  showLock(r.status === 503
    ? 'The dashboard server can\'t use its token file, so it is refusing every request. ' + why
    : authToken()
      ? 'The saved token was not accepted (the dashboard may have a new one).'
      : 'This tab doesn\'t have the dashboard token yet.');
  return true;
}

function showLock(reason) {
  _locked = true;
  const el = document.getElementById('lock-screen');
  if (!el) return;
  document.getElementById('lock-reason').textContent = reason;
  el.style.display = 'flex';
  const dot = document.getElementById('header-dot');
  const text = document.getElementById('header-status-text');
  if (dot) dot.className = 'status-dot offline';
  if (text) text.textContent = 'Locked';
}

function hideLock() {
  _locked = false;
  const el = document.getElementById('lock-screen');
  if (el) el.style.display = 'none';
}

function unlockWithToken(event) {
  event.preventDefault();
  const input = document.getElementById('lock-token');
  const value = (input.value || '').trim();
  input.value = '';
  if (!setAuthToken(value)) {
    document.getElementById('lock-reason').textContent =
      'That doesn\'t look like a dashboard token. Copy it again from the link or data/dashboard-token.';
    return;
  }
  hideLock();
  loadCurrentTab();
  loadSellbirdStatus();
}

// Downloads go through the same authorised fetch and are handed to the
// browser as a local blob, so no download URL ever carries the token.
async function downloadCsv(path, filename, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await authFetch(path);
    if (await lockIfRefused(r)) return;
    if (!r.ok) { showToast('Export failed.', 'error'); return; }
    const href = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  } catch {
    showToast('Export failed — is the dashboard still running?', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function showToast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function toggleVisibility(inputId) {
  const el = document.getElementById(inputId);
  el.type = el.type === 'password' ? 'text' : 'password';
}

// ── Tabs ──

function showTab(id, btn) {
  currentTab = id;
  if (id === 'companies') companyDrill = false;
  if (id === 'prospects') _contactOpen = null;
  if (id === 'conversations') _convoOpen = null;
  if (id === 'inboxes' && !_mainPoll) _inboxOpen = null;
  if (id === 'discover') _discoverView = null;
  if (id === 'outbox' && !_desk.editing) _desk.open = null;
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (btn) btn.classList.add('active');
  loadCurrentTab();
}

function loadCurrentTab() {
  switch (currentTab) {
    case 'today': loadLiveStatus(); loadRenameNotice(); loadToday(); loadTrend(); loadFunnel(); loadSetupStatus(); loadRuns(); loadTodayActivity(); break;
    case 'signals': loadSignals(); break;
    case 'discover': loadDiscoverProviders(); break;
    case 'companies': if (!companyDrill) loadCompanies(); break;
    case 'prospects': loadProspects(); break;
    case 'campaigns': loadCampaigns(); break;
    case 'outbox': loadOutbox(); break;
    case 'conversations': loadConversations(); break;
    case 'activity': loadActivity(); break;
    case 'inboxes': loadInboxes(); break;
    case 'usage': loadUsage(); break;
    case 'settings': loadSettings(); loadSendingModeCard(); break;
    case 'company': loadCompany(); break;
    case 'controls': loadSellbirdStatus(); loadLogs(); break;
  }
}

// ── Today: what needs a human ──

let _todayItems = 0;
let _todayLive = null;

async function loadToday() {
  const data = await api('/api/today');
  const el = document.getElementById('today-queue');
  if (!data) { el.innerHTML = offlineState(); return; }
  if (data.error) {
    // A failed check must never read as "Nothing needs you".
    el.innerHTML = uiBanner({tone: 'danger', iconName: 'alert', title: 'Couldn\'t check what needs you',
      body: 'The dashboard hit an error reading Sellbird\'s data: ' + data.error});
    return;
  }

  navCount('nav-today', (data.items || []).filter(i => i.tone !== 'good').length);
  navCount('nav-outbox', (data.stats || {}).outbox_pending || 0);
  navCount('nav-signals', (data.stats || {}).signals_proposed || 0);
  navCount('nav-conversations', (data.stats || {}).needs_human || 0);
  _todayStats = data.stats || {};
  renderFigures(_todayStats);

  const items = (data.items || []).filter(i => i.tone !== 'good');
  _todayItems = items.length;
  el.innerHTML = todayNeedsYou(items);
  renderTodayNext();
}

// Each thing waiting on you is one banner row with its own way in.
function todayNeedsYou(items) {
  if (!items || !items.length) return '';
  return items.map(it => uiBanner({
    tone: it.tone === 'bad' ? 'danger' : 'warning', iconName: it.tone === 'bad' ? 'alert' : 'flag',
    title: it.title, body: it.detail,
    actions: '<button class="btn btn-secondary btn-sm" onclick="goTab(' + jsq(it.tab) + ')">'
      + escHtml(it.action) + icon('arrow') + '</button>',
  })).join('');
}

// "Next": the one thing to do now, and whether anything needs you.
function todayNext(live, itemsCount) {
  const quiet = itemsCount ? '' : 'Nothing needs you right now. Anything that requires a decision '
    + '(an email to approve, a signal to confirm) shows up here.';
  if (!live || !live.next) {
    return quiet ? uiBanner({tone: 'success', iconName: 'check', title: 'Nothing needs you', body: quiet.replace('Nothing needs you right now. ', '')}) : '';
  }
  return uiBanner({
    title: 'Next · ' + live.next, body: quiet,
    actions: live.next_tab ? '<button class="btn btn-primary btn-sm" onclick="goTab(' + jsq(live.next_tab) + ')">Go</button>' : '',
  });
}

function renderTodayNext() {
  const el = document.getElementById('today-next');
  if (el) el.innerHTML = todayNext(_todayLive, _todayItems);
}

// ── Live status: the "what's happening?" answer, kept on screen ──

function stepBadge(state) {
  if (state === 'done') return uiBadge('success', 'Done', 'check');
  if (state === 'running') return uiBadge('info', 'In progress');
  if (state === 'partial') return uiBadge('info', 'Partly done');
  return uiBadge('neutral', 'Waiting');
}

function pipelineTable(live) {
  const steps = (live && live.steps) || [];
  return uiTable({
    columns: [
      {key: 'label', header: 'Step', render: s => '<span class="ui-cell-main">' + escHtml(s.label) + '</span>'
        + (s.detail ? '<span class="ui-cell-sub">' + escHtml(s.detail) + '</span>' : '')},
      {key: 'state', header: 'Status', render: s => stepBadge(s.state)},
      {key: 'progress', header: 'Progress', align: 'right',
        render: s => s.total ? escHtml((Number(s.done) || 0) + ' of ' + (Number(s.total) || 0)) : uiDash('')},
    ],
    rows: steps, empty: 'Nothing to show yet',
  });
}

async function loadLiveStatus() {
  const el = document.getElementById('live-status');
  if (!el) return;
  const d = await api('/api/live-status');
  if (!d || !Array.isArray(d.steps)) {
    // Keep the last good numbers on screen, but never let them pass for live.
    const flag = el.querySelector('.live-flag');
    if (flag) flag.textContent = "Can't reach Sellbird right now — numbers below may be old.";
    else el.innerHTML = uiCard({title: 'Pipeline right now',
      body: '<p class="muted live-flag">Can\'t reach Sellbird right now. Is the dashboard window still open?</p>'});
    return;
  }
  _todayLive = d;
  renderTodayNext();
  const jobName = r => r.stage === 'profile' ? 'Reading websites'
    : r.stage === 'discover' ? 'Searching for businesses (' + (r.provider || '') + ')'
    : String(r.stage || 'Job');
  const running = (d.running || []).map(r => uiBanner({iconName: 'refresh',
    title: jobName(r) + ' · ' + r.elapsed_min + ' min' + (r.eta_text ? ' · ' + r.eta_text : '')})).join('');
  const stopped = (d.stopped || []).length
    ? uiBanner({tone: 'danger', iconName: 'alert',
        title: (d.stopped || []).map(jobName).join(', ') + ' stopped before finishing.'})
    : '';
  el.innerHTML = uiCard({
    title: 'Pipeline right now',
    action: 'USD ' + Number(d.cost_usd || 0).toFixed(2) + ' so far',
    body: running + stopped + pipelineTable(d) + '<span class="live-flag" hidden></span>',
  });
}

// The summary strip. Totals come from /api/today; "this week" from /api/trend.
function todaySummary(stats, trend) {
  const s = stats || {}, t = trend || {};
  const sum = a => (a || []).reduce((x, y) => x + (Number(y) || 0), 0);
  const week = sum((t.found || []).slice(-7));
  const waiting = (s.outbox_pending || 0) + (s.needs_human || 0);
  const waitNote = [
    s.outbox_pending ? s.outbox_pending + ' to approve' : '',
    s.needs_human ? s.needs_human + ' handed to you' : '',
  ].filter(Boolean).join(' · ') || 'nothing to approve';
  // Instantly sends from its own servers, so the Outbox never sees them.
  const sent = s.email_provider === 'instantly'
    ? {label: 'Emails sent', value: null, sub: 'Instantly tracks sends'}
    : {label: 'Emails sent', value: trend ? sum(t.sent) : null, sub: 'last 14 days · ' + (s.outbox_approved || 0) + ' scheduled'};
  return uiMetricStrip([
    {label: 'Contacts found', value: s.prospects || 0, delta: week ? '+' + week : '', sub: 'this week'},
    sent,
    {label: 'Conversations', value: s.open_conversations || 0, sub: (trend ? sum(t.replies) : 0) + ' new in 14 days'},
    {label: 'Waiting on you', value: waiting, sub: waitNote},
  ]);
}

function renderFigures(stats) {
  const el = document.getElementById('today-kpis');
  if (el) el.innerHTML = todaySummary(stats, _trend);
  const chip = document.getElementById('today-companies');
  if (chip) chip.textContent = (stats.companies || 0) + ' companies';
}

let _todayStats = {};
let _trend = null;

async function loadTrend() {
  const t = await api('/api/trend?days=14&tz=' + -new Date().getTimezoneOffset());
  if (t && Array.isArray(t.days)) { _trend = t; renderFigures(_todayStats); }
}

// Contacts by stage: label, count and share, two columns.
function stageGrid(pipe, total) {
  const p = pipe || {};
  const stages = [['To write', p.to_write], ['Contacted', p.contacted], ['Replied', p.replied],
    ['Interested', p.interested], ['Ready to meet', p.ready_to_meet], ['Closed out', p.closed_out]];
  return '<div class="stage-grid">' + stages.map(([label, n]) => {
    const v = Number(n) || 0;
    return '<div class="ui-kv"><span>' + label + '</span><span><b>' + v + '</b> <span class="muted">'
      + (total ? Math.round(100 * v / total) : 0) + '%</span></span></div>';
  }).join('') + '</div>';
}

async function loadFunnel() {
  const el = document.getElementById('today-figures');
  if (!el) return;
  const data = await api('/api/stats');
  if (!data) return;  // offline: keep the last numbers; Today's queue says so
  const action = '<span id="today-companies">' + (_todayStats.companies || 0) + ' companies</span>';
  if (data.error) { el.innerHTML = uiCard({title: 'Contacts by stage', action, body: '<p class="muted">Couldn\'t read the pipeline.</p>'}); return; }
  const total = (data.prospects || {}).total || 0;
  el.innerHTML = uiCard({title: 'Contacts by stage', action, body: total
    ? stageGrid(data.pipeline, total)
    : uiEmpty('No contacts yet', 'Scout adds them as it finds people.')});
}

function activityWhen(d) {
  const day = dayLabel(d);
  return (day && day !== 'Today' ? day.replace(/^\w+day, /, '') + ' · ' : '') + timeOfDay(d);
}

function activityTable(actions) {
  return uiTable({
    columns: [
      {key: 'created_at', header: 'Time', render: a => escHtml(activityWhen(a.created_at))},
      {key: 'event', header: 'Event', render: a => '<span class="ui-strong-text">' + actionText(a) + '</span>'},
      {key: 'agent', header: 'Agent', align: 'right', render: a => uiBadge('neutral', a.agent)},
    ],
    rows: actions || [], empty: 'Nothing yet. Every action Sellbird takes shows up here.',
  });
}

async function loadTodayActivity() {
  const el = document.getElementById('today-activity');
  if (!el) return;
  const data = await api('/api/activity');
  if (!Array.isArray(data)) return;  // offline: Today's queue says so
  // Heartbeats are noise here; the Activity tab keeps them.
  el.innerHTML = uiCard({title: 'Recent activity',
    action: '<a href="#" onclick="goTab(\'activity\');return false">See all</a>',
    body: activityTable(data.filter(a => a.agent !== 'main').slice(0, 8))});
}

function navCount(id, n) {
  if (id === 'nav-today') { _topbar = {..._topbar, waiting: n}; renderTopbar(); }
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = n > 0 ? n : '';
  el.className = 'nav-count' + (n > 0 ? ' on' : '');
}

// Jump to a tab from a link that isn't itself a nav button.
function goTab(id) {
  const btns = [...document.querySelectorAll('nav button')];
  const btn = btns.find(b => (b.getAttribute('onclick') || '').includes("'" + id + "'"));
  showTab(id, btn);
}

function runBadge(status) {
  const s = String(status || '');
  if (s === 'completed' || s === 'done') return uiBadge('success', 'Completed', 'check');
  if (s === 'running') return uiBadge('info', 'Running');
  if (s === 'failed' || s === 'stopped' || s === 'error') return uiBadge('danger', s.charAt(0).toUpperCase() + s.slice(1));
  return uiBadge('neutral', s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Unknown');
}

function runsTable(runs) {
  return uiTable({
    columns: [
      {key: 'stage', header: 'Run', render: r => '<span class="ui-strong">' + escHtml(String(r.stage || '').replace(/^./, c => c.toUpperCase())) + '</span>'},
      {key: 'status', header: 'Status', render: r => runBadge(r.status)},
      {key: 'records', header: 'Result', render: r => escHtml((r.records || 0) + ' records · '
        + (r.cost_usd ? 'USD ' + Number(r.cost_usd).toFixed(3) : 'free'))},
      {key: 'started_at', header: 'When', align: 'right', render: r => escHtml(relTime(r.started_at))},
    ],
    rows: runs || [], empty: 'Nothing has run yet',
  });
}

async function loadRuns() {
  const el = document.getElementById('today-runs');
  if (!el) return;
  const runs = await api('/api/runs');
  if (!Array.isArray(runs) || !runs.length) { el.innerHTML = ''; return; }
  el.innerHTML = uiCard({title: 'Collector runs', body: runsTable(runs.slice(0, 5))});
}

// ── Setup checklist (lives on Today, and disappears once it's done) ──

// Shown once after an upgrade from Harvey moved this install's files.
async function loadRenameNotice() {
  const el = document.getElementById('today-renamed');
  if (!el) return;
  const data = await api('/api/rename-notice');
  if (!data || !data.show) { el.innerHTML = ''; return; }
  el.innerHTML =
    '<div class="card rename-card">' +
      '<div><h3>Harvey is now Sellbird</h3>' +
        '<p class="muted">Same project, new name. Your settings, data and sign-in came with you. ' +
        'The <code>harvey</code> command still works for now; use <code>sellbird</code> from here on.</p></div>' +
      '<div class="rename-actions">' +
        '<a class="btn btn-ghost" href="https://github.com/ethanplusai/sellbird#upgrading-from-harvey" target="_blank" rel="noopener">What changed</a>' +
        '<button class="btn btn-secondary" onclick="dismissRenameNotice()">Got it</button>' +
      '</div></div>';
}

async function dismissRenameNotice() {
  document.getElementById('today-renamed').innerHTML = '';
  await api('/api/rename-notice/dismiss', {method: 'POST'});
}

async function loadSetupStatus() {
  const el = document.getElementById('today-setup');
  if (!el) return;
  const data = await api('/api/setup-status');
  if (!data || !data.checks) { el.innerHTML = ''; return; }

  const pct = data.percent || 0;
  // Finished setup disappears completely rather than greeting you forever.
  if (pct === 100) { el.innerHTML = ''; return; }

  // The first unfinished required step is the one to do now.
  const next = data.checks.find(c => c.required && !c.done);
  const renderCheck = (c, optional) =>
    '<div class="check-item' + (c === next ? ' current' : '') + '">' +
      (c.done ? '<span class="check-icon done">' + icon('check') + '</span>'
              : '<span class="check-icon pending"></span>') +
      '<div class="check-info">' +
        '<div class="check-label ' + (c.done ? 'done' : '') + '">' + escHtml(c.label) +
          (optional ? '<span class="optional-tag">optional</span>' : '') + '</div>' +
        (!c.done ? '<div class="check-help">' + escHtml(c.help) + '</div>' : '') +
        (!c.done && c.id === 'warmup_service' ? warmupServiceActions(c) : '') +
      '</div></div>';

  const required = data.checks.filter(c => c.required);
  const optional = data.checks.filter(c => !c.required);
  const done = required.filter(c => c.done).length;

  el.innerHTML =
    '<section class="ui-card setup-card">' +
      '<div class="ui-card__head"><div><h3 class="ui-card__title">Finish setting up Sellbird</h3>' +
        '<div class="ui-card__meta">Sellbird starts finding prospects and sending once these are done.</div></div>' +
        uiBadge('neutral', done + ' of ' + required.length + ' done') + '</div>' +
      '<div class="bar thick" style="margin-bottom:8px"><span style="width:' + pct + '%;background:var(--accent)"></span></div>' +
      required.map(c => renderCheck(c, false)).join('') +
      (optional.length
        ? '<details style="margin-top:10px"><summary class="muted" ' +
          'style="font-size:12px">' + optional.length + ' optional</summary>' +
          '<div style="margin-top:6px">' +
          optional.map(c => renderCheck(c, true)).join('') + '</div></details>'
        : '') +
    '</section>';
}

// The warmup step: get TrulyInbox, paste its key, or say you use another service.
function warmupServiceActions(c) {
  return '<div class="btn-group warmup-actions">' +
      '<a class="btn btn-primary btn-sm" href="' + safeHref(c.link) + '" target="_blank" ' +
        'rel="noopener sponsored">Get TrulyInbox</a>' +
      '<input class="form-input" id="trulyinbox-key" type="password" autocomplete="off" ' +
        'placeholder="Paste your TrulyInbox API key" aria-label="TrulyInbox API key" ' +
        'onkeydown="if (event.key === \'Enter\') connectTrulyInbox()">' +
      '<button class="btn btn-secondary btn-sm" id="trulyinbox-go" onclick="connectTrulyInbox()">Connect</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="useOtherWarmup()">I use another service</button>' +
    '</div>';
}

async function connectTrulyInbox() {
  const input = document.getElementById('trulyinbox-key');
  const go = document.getElementById('trulyinbox-go');
  if (!input || !input.value.trim()) return;
  if (go) go.disabled = true;
  const data = await api('/api/trulyinbox/connect', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({key: input.value.trim()}),
  });
  if (go) go.disabled = false;
  if (data && data.success) {
    input.value = '';
    showToast(data.message || 'TrulyInbox connected', 'success');
    loadSetupStatus();
  } else {
    showToast((data && data.message) || 'Could not connect TrulyInbox', 'error');
  }
}

async function useOtherWarmup() {
  const data = await api('/api/trulyinbox/other', {method: 'POST'});
  if (data && data.success) loadSetupStatus();
}

// ── Signals: Sellbird proposes, you confirm ──

let _sigTab = null;

async function loadSignals() {
  const data = await api('/api/signals');
  const sumEl = document.getElementById('signals-summary');
  const grpEl = document.getElementById('signals-groups');
  if (!data || data.error) { grpEl.innerHTML = offlineState(); sumEl.innerHTML = ''; return; }
  _signals = data;

  navCount('nav-signals', (data.summary || {}).proposed || 0);
  sumEl.innerHTML = signalsSummary(data);

  const groups = signalGroups(data.groups || []);
  // Open on the first tab with something to decide; then stay where you are.
  if (!_sigTab) {
    const waiting = groups.find(g => g.signals.some(s => s.status === 'proposed'));
    _sigTab = waiting ? waiting.key : 'discovery';
  }
  renderSignalTab(groups);
  renderCohortBuilder();
}

function renderSignalTab(groups) {
  groups = groups || signalGroups((_signals || {}).groups || []);
  const tabsEl = document.getElementById('signals-tabs');
  const grpEl = document.getElementById('signals-groups');
  const cohortEl = document.getElementById('signals-cohort');
  if (tabsEl) tabsEl.innerHTML = signalTabsFor(groups, _sigTab);
  const isCohort = _sigTab === 'cohort';
  if (cohortEl) cohortEl.hidden = !isCohort;
  const g = groups.find(x => x.key === _sigTab);
  grpEl.innerHTML = isCohort ? '' : (g ? signalGroupCard(g) : '');
}

function pickSignalTab(key) {
  _sigTab = key;
  renderSignalTab();
}

// Category → sub-tab. Anything the dashboard doesn't know yet lands in Profile.
function signalGroups(groups) {
  // The four sub-tabs, keyed by the catalog's own category.
  const tabs = [['discovery', 'Discovery'], ['profile', 'Profile'], ['people', 'People'], ['verification', 'Contactability']];
  const out = tabs.map(([key, tab]) => ({key, tab, title: tab, blurb: '', signals: []}));
  const byKey = Object.fromEntries(out.map(g => [g.key, g]));
  (groups || []).forEach(g => {
    const home = byKey[g.key];
    if (home && g.label) { home.title = String(g.label).replace(/\s+—\s+/, ': '); home.blurb = g.blurb || ''; }
    (g.signals || []).forEach(s => (byKey[s.category] || byKey[g.key] || byKey.profile).signals.push(s));
  });
  return out;
}

function signalTabsFor(groups, active) {
  const items = (groups || []).map(g => {
    const waiting = (g.signals || []).filter(s => s.status === 'proposed').length;
    return {key: g.key, label: g.tab, count: waiting || null};
  });
  items.push({key: 'cohort', label: 'Cohort builder'});
  return uiTabs(items, active, k => 'pickSignalTab(' + jsq(k) + ')');
}

function signalsSummary(data) {
  const s = (data && data.summary) || {};
  const confirmed = s.confirmed || 0, proposed = s.proposed || 0, rejected = s.rejected || 0;
  const total = confirmed + proposed + rejected;
  const pct = n => total ? Math.round(100 * n / total) + '%' : '0%';
  const seen = ((data && data.groups) || []).flatMap(g => g.signals || [])
    .reduce((m, x) => Math.max(m, Number(x.companies) || 0), 0);
  return uiMetricStrip([
    {label: 'Confirmed', value: confirmed, sub: pct(confirmed) + ' of signals'},
    {label: 'Waiting on you', value: proposed, sub: proposed ? 'to confirm or skip' : 'nothing to decide'},
    {label: 'Turned off', value: rejected, sub: pct(rejected)},
    {label: 'Companies scored', value: seen, sub: 'on the most-collected signal'},
  ]);
}

function signalGroupCard(g) {
  const sigs = g.signals || [];
  const on = sigs.filter(s => s.status === 'confirmed').length;
  // Only the undecided ones: "Confirm all" must never re-enable a signal
  // you turned off (or "Skip all" turn off one you confirmed).
  const pendingCodes = sigs.filter(s => s.status === 'proposed').map(s => s.code);
  const pending = escHtml(JSON.stringify(pendingCodes));
  const bulk = pendingCodes.length
    ? '<button class="btn btn-primary btn-sm" onclick="setSignals(' + pending + ', \'confirmed\')">Confirm all '
        + pendingCodes.length + '</button>'
      + '<button class="btn btn-secondary btn-sm" onclick="setSignals(' + pending + ', \'rejected\')">Skip all '
        + pendingCodes.length + '</button>'
    : '';
  const action = '<span class="sig-card-action">' + bulk + '<span>' + sigs.length + ' signal' + (sigs.length === 1 ? '' : 's')
    + ' · ' + on + ' on</span></span>';
  const body = (g.blurb ? '<p class="sig-blurb">' + escHtml(g.blurb) + '</p>' : '')
    + (sigs.length ? '<div class="sig-list">' + sigs.map(signalRow).join('') + '</div>'
                   : uiEmpty('No signals in this group yet'));
  return uiCard({title: g.title || g.tab, action, body, cls: 'sig-card'});
}

function signalRow(sig) {
  const note = sig.cost_note || '';
  const paid = !/free|included/i.test(note) && /\$|credit|paid/i.test(note);
  const n = Number(sig.companies) || 0;
  const seen = n ? 'seen on ' + n + (n === 1 ? ' company' : ' companies') + ' so far' : 'not collected yet';
  const floor = sig.confidence_floor > 0
    ? '<span>·</span><span>only recorded above ' + Math.round(sig.confidence_floor * 100) + '% confidence</span>' : '';
  const code = jsq(sig.code);

  let decide;
  if (sig.status === 'confirmed' || sig.status === 'rejected') {
    const on = sig.status === 'confirmed';
    decide = (on ? uiBadge('success', 'Confirmed', 'check') : uiBadge('neutral', 'Off'))
      + uiSwitch({checked: on, onChange: 'setSignals([' + code + '], this.checked ? \'confirmed\' : \'rejected\')'})
        .replace('<input ', '<input aria-label="' + escHtml(sig.label || sig.code) + '" ');
  } else {
    // Undecided is not "off": it gets explicit buttons, never a switch.
    decide = uiBadge('warning', 'Waiting on you')
      + '<button class="btn btn-primary btn-sm" onclick="setSignals([' + code + '],\'confirmed\')">Confirm</button>'
      + '<button class="btn btn-secondary btn-sm" onclick="setSignals([' + code + '],\'rejected\')">Skip</button>';
  }

  return '<div class="sig-row' + (sig.status === 'rejected' ? ' is-off' : '') + '">'
    + '<div class="sig-main">'
      + '<div class="sig-label"><span class="sig-name">' + escHtml(sig.label || sig.code) + '</span>'
        + '<span class="sig-code">' + escHtml(sig.code) + '</span></div>'
      + '<p class="sig-desc">' + escHtml(sig.description || '') + '</p>'
      + '<div class="sig-meta">' + (paid ? uiBadge('warning', 'Paid') : '')
        + '<span>' + uiDash(note) + '</span><span>·</span><span>' + seen + '</span>' + floor + '</div>'
    + '</div>'
    + '<div class="sig-decide">' + decide + '</div>'
  + '</div>';
}

async function setSignals(codes, status) {
  const data = await api('/api/signals/status', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({codes: codes, status: status}),
  });
  if (data && data.success) {
    showToast(
      status === 'confirmed'
        ? 'Confirmed ' + data.changed + ' signal' + (data.changed === 1 ? '' : 's') +
          ' — Sellbird will collect ' + (data.changed === 1 ? 'it' : 'them') + ' from now on.'
        : data.changed + ' signal' + (data.changed === 1 ? '' : 's') + ' turned off.',
      'success');
  } else {
    showToast(failMsg(data, 'Could not update that signal.'), 'error');
  }
  loadSignals();
}

// ── Discover: pick a source, price it, then run it ──

let _provider = null;
let _discoverPoll = null;
let _discoverView = null;   // null: the sources table; a provider key: that source's page
let _discoverData = null;
let _discoverRuns = [];

async function loadDiscoverProviders() {
  const el = document.getElementById('discover-providers');
  const [data, runs] = await Promise.all([api('/api/discover/providers'), api('/api/runs')]);
  if (!data || !data.providers) { el.innerHTML = offlineState(); return; }
  _discoverData = data;
  _discoverRuns = Array.isArray(runs) ? runs : [];

  _provider = _provider || data.selected || data.default;
  renderDiscover();

  const running = data.running;
  // Reading sites can't be stopped part-way; only a discovery run can.
  document.getElementById('disc-stop').style.display = running && data.running_kind !== 'profile' ? '' : 'none';
  renderProfileCard(data.unprofiled || 0, running);
  if (running && !_discoverPoll) {
    _discoverPoll = setInterval(loadDiscoverProviders, 4000);
  } else if (!running && _discoverPoll) {
    clearInterval(_discoverPoll);
    _discoverPoll = null;
    // A finished run leaves the button stuck on "Running…" otherwise.
    const btn = document.getElementById('disc-run');
    btn.disabled = true;
    btn.textContent = 'Estimate first';
    showToast(data.running_kind === 'profile' ? 'Finished reading websites.' : 'Discovery finished.', 'success');
  }
  renderDiscoverResult(data.last_report, running);
}

// The list page or one source's page, from the data already loaded.
function renderDiscover() {
  const data = _discoverData;
  if (!data) return;
  const providers = data.providers || [];
  const p = _discoverView ? providers.find(x => x.key === _discoverView) : null;
  if (_discoverView && !p) _discoverView = null;
  document.getElementById('discover-list').hidden = !!p;
  document.getElementById('discover-detail').hidden = !p;
  const head = document.getElementById('discover-head');
  if (p) {
    const page = sourceDetailPage(p);
    head.innerHTML = page.head;
    document.getElementById('discover-about').innerHTML = page.side;
    return;
  }
  head.innerHTML = uiPageHead({
    title: 'Discover',
    sub: 'Find businesses matching your ICP. Pick a source, see what it will cost, then run it. '
      + 'Nothing is called until you press the button.',
    actions: '<button class="btn btn-primary" onclick="openSource(_provider)">Run discovery</button>',
  });
  document.getElementById('discover-summary').innerHTML =
    discoverSummary(providers, _discoverRuns, (typeof _todayStats === 'object' && _todayStats) ? _todayStats.companies : undefined)
    + (data.running ? uiBanner({tone: 'warning', iconName: 'flag', title: 'Running now',
        body: 'Results land in Companies as they come in.',
        actions: '<button class="btn btn-secondary btn-sm" onclick="openSource(_provider)">Open</button>'}) : '');
  document.getElementById('discover-providers').innerHTML = sourcesTable(providers, _discoverRuns);
}

function openSource(key) {
  _discoverView = key;
  if (key && key !== _provider) { pickProvider(key); return; }
  renderDiscover();
  window.scrollTo(0, 0);
}

function closeSource() {
  _discoverView = null;
  renderDiscover();
}

// The most recent discovery run, for one source or any.
function lastDiscoverRun(runs, key) {
  return (runs || []).filter(r => r && r.stage === 'discover' && (!key || r.provider === key))
    .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))[0] || null;
}

function discoverSummary(providers, runs, companies) {
  providers = providers || [];
  const ready = providers.filter(p => p.configured).length;
  const need = providers.length - ready;
  const last = lastDiscoverRun(runs);
  const label = last ? ((providers.find(p => p.key === last.provider) || {}).label || last.provider || '') : '';
  const spent = (runs || []).filter(r => r && r.stage === 'discover')
    .reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  return uiMetricStrip([
    {label: 'Sources ready', value: ready, sub: need ? need + ' need a key' : 'all set up'},
    {label: 'Companies found', value: (companies === undefined || companies === null) ? null : companies, sub: 'all time'},
    {label: 'Last run', value: last ? (relTime(last.started_at) || '—') : 'never',
      sub: last ? label + ' · ' + (Number(last.records) || 0) + ' records' : 'no discovery run yet'},
    {label: 'Spent', value: '$' + spent.toFixed(2), sub: 'last 25 runs'},
  ]);
}

function sourceBadge(p) {
  return p.configured ? uiBadge('success', 'Ready', 'check') : uiBadge('warning', 'Needs a key');
}

function sourcesTable(providers, runs) {
  const short = p => String(p.blurb || '').split('. ')[0].replace(/\.$/, '');
  const columns = [
    {key: 'label', header: 'Source', render: p => '<span class="ui-cell-main">' + escHtml(p.label) + '</span>'
      + '<span class="ui-cell-sub disc-short">' + escHtml(short(p)) + '</span>'},
    {key: 'status', header: '', render: sourceBadge},
    {key: 'cost', header: 'Cost', render: p => '<span class="disc-wrap">' + uiDash(p.cost_note) + '</span>'},
    {key: 'free', header: 'Free tier', render: p => '<span class="disc-wrap muted">' + uiDash(p.free_tier) + '</span>'},
    {key: 'last', header: 'Last run', align: 'right', render: p => {
      const r = lastDiscoverRun(runs, p.key);
      return '<span class="muted">' + (r ? (relTime(r.started_at) || '—') : 'never') + '</span>';
    }},
  ];
  return uiTable({columns, rows: providers || [], rowKey: p => p.key,
    onRow: p => 'openSource(' + jsq(p.key) + ')', empty: 'No discovery sources available'});
}

// One source: its head, and what sits beside the run form.
function sourceDetailPage(p) {
  const head = uiPageHead({
    crumbs: [{label: 'Discover', js: 'closeSource()'}, {label: p.label}],
    title: p.label, sub: p.blurb, actions: sourceBadge(p),
  });
  const keys = (p.env_keys || []).length
    ? '<code>' + escHtml(p.env_keys.join(', ')) + '</code> in .env'
      + (safeHref(p.signup_url) ? ' · <a href="' + safeHref(p.signup_url) + '" target="_blank" rel="noopener noreferrer">get a key</a>' : '')
    : 'None';
  const row = (k, v) => '<div><dt>' + escHtml(k) + '</dt><dd>' + v + '</dd></div>';
  const side = uiCard({title: 'About this source', body: '<dl class="ui-details">'
      + row('Cost', uiDash(p.cost_note)) + row('Free tier', uiDash(p.free_tier))
      + row('Setup', keys) + row('Status', p.configured ? 'Ready to run' : 'Needs a key before it can run') + '</dl>'})
    + (p.caveat ? uiBanner({tone: 'warning', iconName: 'flag', title: 'Worth knowing', body: p.caveat}) : '');
  return {head, side};
}

function pickProvider(key) {
  _provider = key;
  document.getElementById('disc-run').disabled = true;
  document.getElementById('disc-run').textContent = 'Estimate first';
  document.getElementById('discover-estimate').innerHTML = '';
  const chip = document.getElementById('disc-estimate-chip');
  if (chip) chip.textContent = 'Estimate before you run';
  loadDiscoverProviders();
}

function discoverBody() {
  const raw = document.getElementById('disc-cities').value.trim();
  return {
    provider: _provider,
    // Semicolons or newlines, never commas: "Denver, CO" is one city.
    cities: raw ? raw.split(/[;\n]/).map(c => c.trim()).filter(Boolean) : [],
    depth: Number(document.getElementById('disc-depth').value) || 30,
    limit: Number(document.getElementById('disc-limit').value) || 100,
    max_spend: Number(document.getElementById('disc-cap').value) || 1,
    preset: (document.getElementById('disc-preset') || {}).value || '',
  };
}

// The priced plan: amount, query count, cap check and the queries themselves.
function estimateHtml(data, cap) {
  const cost = Number(data.estimated_cost) || 0;
  const n = Number(data.query_count) || 0;
  const queries = Array.isArray(data.queries) ? data.queries : [];
  cap = Number(cap) || 0;
  const over = cost > cap;
  return '<div class="estimate-box">'
    + '<div class="amount ' + (data.free ? 'free' : 'paid') + '">' + (data.free ? 'Free' : '$' + cost.toFixed(4)) + '</div>'
    + '<div class="estimate-sub">' + n + ' quer' + (n === 1 ? 'y' : 'ies')
      + (data.free ? '' : ' · cap is $' + cap.toFixed(2)) + '</div>'
    + (over ? uiBanner({tone: 'danger', iconName: 'alert', title: 'Over your cap', body: 'Raise the cap or narrow the search.'}) : '')
    + (queries.length ? '<div class="query-list">' + queries.slice(0, 40).map(escHtml).join('<br>')
      + (queries.length > 40 ? '<br>… and ' + (queries.length - 40) + ' more' : '') + '</div>' : '')
    + '</div>';
}

async function estimateDiscovery() {
  const el = document.getElementById('discover-estimate');
  el.innerHTML = '<p class="muted" style="font-size:12px">Pricing it…</p>';
  const data = await api('/api/discover/estimate', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(discoverBody()),
  });
  if (!data || data.error) {
    el.innerHTML = uiBanner({tone: 'danger', iconName: 'alert', title: 'Could not estimate',
      body: (data && data.error) || 'The server did not answer.'});
    return;
  }

  const cap = discoverBody().max_spend;
  const cost = Number(data.estimated_cost) || 0;
  const over = cost > cap;
  el.innerHTML = estimateHtml(data, cap);
  const chip = document.getElementById('disc-estimate-chip');
  if (chip) chip.textContent = data.free ? 'Free · ' + (data.query_count || 0) + ' queries'
    : 'Estimated $' + cost.toFixed(2) + ' for ' + (data.query_count || 0) + ' queries';

  const btn = document.getElementById('disc-run');
  btn.disabled = over;
  btn.textContent = over ? 'Over cap'
    : (data.free ? 'Run — free' : 'Run — spend up to $' + cost.toFixed(2));
}

async function runDiscovery() {
  const btn = document.getElementById('disc-run');
  btn.disabled = true;
  btn.textContent = 'Running…';
  const data = await api('/api/discover/run', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(discoverBody()),
  });
  if (data && data.success) {
    showToast('Discovery started — ' + data.queries + ' queries.', 'success');
  } else {
    showToast((data && data.message) || 'Could not start.', 'error');
    btn.disabled = false;
  }
  loadDiscoverProviders();
}

async function stopDiscovery() {
  const data = await api('/api/discover/stop', {method: 'POST'});
  showToast(data && data.success ? 'Stopping after the current query.'
                                 : failMsg(data, 'Could not stop.'), data && data.success ? 'success' : 'error');
  loadDiscoverProviders();
}

// Companies found but not looked at: reading their sites is free and
// model-free, and it is what makes an email specific.
function profileCard(pending, running) {
  if (!pending) return '';
  return uiBanner({
    iconName: 'flag',
    title: pending + ' compan' + (pending === 1 ? 'y' : 'ies') + ' not looked at yet',
    body: 'Free, no account needed. Sellbird reads each site for who their agency is, what they are missing, '
      + 'and whether they run ads. Up to 200 per run.',
    actions: '<button class="btn btn-primary btn-sm" onclick="runProfile(this)"' + (running ? ' disabled' : '') + '>'
      + (running ? 'Busy…' : 'Read their sites') + '</button>',
  });
}

function renderProfileCard(pending, running) {
  const el = document.getElementById('discover-profile');
  if (!el) return;
  el.innerHTML = profileCard(pending, running);
}

async function runProfile(btn) {
  btn.disabled = true;
  btn.textContent = 'Starting…';
  const data = await api('/api/profile/run', {method: 'POST'});
  if (data && data.success) {
    showToast(data.pending ? 'Reading ' + Math.min(data.pending, 200) + ' websites.' : 'Every site is already read.', 'success');
    if (data.pending && !_discoverPoll) _discoverPoll = setInterval(loadDiscoverProviders, 4000);
  } else {
    showToast(failMsg(data, 'Could not start.'), 'error');
  }
  loadDiscoverProviders();
}

function renderDiscoverResult(report, running) {
  const el = document.getElementById('discover-result');
  if (running) {
    el.innerHTML = uiCard({title: 'Running…', body: '<p class="sig-blurb">Sellbird is working through the '
      + 'queries. Results land in Companies, and the run log is on Today.</p>'});
    return;
  }
  if (!report) {
    el.innerHTML = uiCard({title: 'Last run', body: '<p class="sig-blurb">Nothing run since the dashboard started. '
      + 'The full run log is on Today.</p>'});
    return;
  }
  const money = v => v ? '$' + (Number(v) || 0).toFixed(4) : 'Free';
  const stopped = report.stopped ? uiBanner({tone: 'danger', iconName: 'alert', title: 'Stopped early', body: report.stopped}) : '';
  if (report.profiled_companies !== undefined && report.new_companies === undefined) {
    el.innerHTML = uiCard({title: 'Last run', cls: 'disc-last', body: uiMetricStrip([
      {label: 'Websites read', value: report.profiled_companies || 0},
      {label: 'Facts recorded', value: report.profile_observations || 0},
      {label: 'Cost', value: 'Free'}]) + stopped});
    return;
  }
  const items = [
    {label: 'New companies', value: report.new_companies || 0},
    {label: 'Already known', value: report.known_companies || 0},
    {label: 'Observations', value: report.observations || 0},
    {label: 'Filtered as junk', value: report.junk || 0}];
  if (report.profiled_companies) items.push({label: 'Websites read', value: report.profiled_companies});
  items.push({label: 'Actual cost', value: money(report.actual_cost)});
  el.innerHTML = uiCard({title: 'Last run', cls: 'disc-last', body: uiMetricStrip(items) + stopped
    + ((report.errors || []).length
      ? '<div class="disc-problems"><div class="ui-card__title">Problems</div>'
        + (report.errors || []).slice(0, 8).map(e => '<div class="check-help">' + escHtml(e) + '</div>').join('') + '</div>'
      : '')});
}

// ── Cohort builder: a prospect list is a query ──

let _cohort = { require: new Set(), exclude: new Set(), ranges: {} };
let _cohortOffset = 0;
let _cohortGeneration = 0;
const COHORT_PAGE = 50;

function renderCohortBuilder() {
  const el = document.getElementById('cohort-builder');
  if (!el || !_signals) return;

  const confirmed = (_signals.groups || [])
    .flatMap(g => g.signals)
    .filter(s => s.status === 'confirmed');

  if (!confirmed.length) {
    el.innerHTML = uiCard({body: uiEmpty('No confirmed signals yet',
      'Confirm some signals on the other tabs and they become the building blocks here.')});
    document.getElementById('cohort-result').innerHTML = '';
    return;
  }

  const col = (title, key, hint) => uiCard({title, action: '<span>' + escHtml(hint) + '</span>',
    body: '<div class="cohort-grid">' + confirmed.map(s =>
      '<label class="cohort-pick"><input type="checkbox" ' +
        (_cohort[key].has(s.code) ? 'checked ' : '') +
        'onchange="toggleCohort(\'' + key + '\',' + jsq(s.code) + ',this.checked)">' +
        '<span class="cohort-name">' + escHtml(s.label || s.code) + '</span>' +
        '<span class="n">' + (Number(s.companies) || 0) + '</span></label>'
    ).join('') + '</div>'});

  // Numeric signals (ranks, ratings) take a range: "organic rank 11-30".
  const numeric = confirmed.filter(s => s.value_type === 'num');
  const bound = (code, side) => {
    const v = (_cohort.ranges[code] || {})[side];
    return '<input type="number" class="form-input cohort-bound" placeholder="' + side + '" ' +
      'value="' + (v === undefined || v === null ? '' : escHtml(String(v))) + '" ' +
      'aria-label="' + escHtml(code) + ' ' + side + '" ' +
      'onchange="setCohortRange(' + jsq(code) + ',' + jsq(side) + ',this.value)">';
  };
  const rangeCol = numeric.length ? uiCard({title: 'In range', action: '<span>e.g. organic rank 11 to 30; leave a side blank for no limit</span>',
    body: '<div class="cohort-ranges">' + numeric.map(s =>
      '<div class="cohort-range"><span class="cohort-name">' + escHtml(s.label || s.code) + '</span>' +
        bound(s.code, 'min') + '<span class="muted">to</span>' + bound(s.code, 'max') + '</div>'
    ).join('') + '</div>'}) : '';

  el.innerHTML = col('Must have', 'require', 'every company in the cohort carries all of these') +
    col('Must not have', 'exclude', 'disqualifiers') + rangeCol;
}

function setCohortRange(code, side, value) {
  const r = _cohort.ranges[code] || {min: null, max: null};
  r[side] = value === '' || isNaN(Number(value)) ? null : Number(value);
  if (r.min === null && r.max === null) delete _cohort.ranges[code];
  else _cohort.ranges[code] = r;
  _cohortOffset = 0;
  runCohort();
}

function toggleCohort(key, code, on) {
  if (on) _cohort[key].add(code); else _cohort[key].delete(code);
  // A company can't be both required and excluded on the same signal.
  const other = key === 'require' ? 'exclude' : 'require';
  if (on) _cohort[other].delete(code);
  _cohortOffset = 0;  // a new cohort starts on its first page
  runCohort();
  renderCohortBuilder();
}

async function runCohort() {
  const generation = ++_cohortGeneration;
  const offset = _cohortOffset;
  const el = document.getElementById('cohort-result');
  if (!el) return;
  const require = [..._cohort.require], exclude = [..._cohort.exclude];
  const ranges = _cohortRanges();
  if (!require.length && !ranges.length) { el.innerHTML = ''; return; }
  // Remove the prior export button as soon as its criteria become stale.
  el.innerHTML = '<p class="muted cohort-loading">Loading cohort…</p>';

  const data = await api('/api/cohort', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({require: require, exclude: exclude, ranges: ranges,
                          offset: offset, limit: COHORT_PAGE}),
  });
  if (generation !== _cohortGeneration) return;
  if (!data || data.error) {
    el.innerHTML = data ? '<div class="test-result error">' + escHtml(data.error) + '</div>' : '';
    return;
  }

  let html = '<section class="ui-card cohort-card"><div class="ui-card__head"><h3 class="ui-card__title">Matching companies</h3></div>' +
    '<div class="cohort-size">' + data.size + '</div>' +
    '<div class="cohort-size-sub">compan' +
      (data.size === 1 ? 'y matches' : 'ies match') + ' this cohort right now</div>';

  if (data.companies && data.companies.length) {
    html += '<div class="ui-table-wrap"><table class="ui-table"><thead><tr>' +
      '<th>Company</th><th>Domain</th><th>Industry</th><th>Location</th>' +
      '</tr></thead><tbody>' +
      data.companies.map(c =>
        '<tr><td class="ui-strong">' + (escHtml(c.name) || '—') + '</td><td>' + (escHtml(c.domain) || '—') + '</td>' +
        '<td>' + (escHtml(c.industry) || '—') + '</td>' +
        '<td>' + (escHtml(c.location) || '—') + '</td></tr>'
      ).join('') + '</tbody></table></div>';

    const first = data.offset + 1, last = data.offset + data.companies.length;
    const hasPrev = data.offset > 0, hasNext = last < data.size;
    html += '<div class="ui-pager"><span>Showing ' + first + '&ndash;' + last +
        ' of ' + data.size + '</span><div class="ui-pager__btns">' +
      '<button class="btn btn-sm" onclick="pageCohort(-1)"' +
        (hasPrev ? '' : ' disabled') + '>Previous</button>' +
      '<button class="btn btn-sm" onclick="pageCohort(1)"' +
        (hasNext ? '' : ' disabled') + '>Next</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="exportCohort(this)">Export CSV</button>' +
      '</div></div>';
  } else if (data.size === 0) {
    html += '<p class="sig-blurb">' +
      'No company carries all of those yet. Either loosen the cohort, or run ' +
      'prospecting to collect more.</p>';
  } else if (_cohortOffset > 0) {
    // The cohort shrank under us (a re-profile, a delete): back to page one.
    _cohortOffset = 0;
    return runCohort();
  }
  el.innerHTML = html + '</section>';
}

function _cohortRanges() {
  return Object.entries(_cohort.ranges || {})
    .filter(([, r]) => r.min !== null || r.max !== null)
    .map(([code, r]) => ({code: code, min: r.min, max: r.max}));
}

async function exportCohort(button) {
  const qs = new URLSearchParams({require: [..._cohort.require].join(','),
                                  exclude: [..._cohort.exclude].join(',')});
  // Ranges travel as "CODE:min:max", a blank side meaning no limit.
  const ranges = Object.entries(_cohort.ranges || {})
    .map(([code, r]) => code + ':' + (r.min ?? '') + ':' + (r.max ?? ''));
  if (ranges.length) qs.set('ranges', ranges.join(','));
  button.disabled = true;
  button.textContent = 'Exporting…';
  let url;
  let link;
  try {
    const response = await authFetch('/api/cohort.csv?' + qs);
    if (await lockIfRefused(response)) throw new Error('Dashboard authorization required');
    if (!response.ok) throw new Error('Export failed (HTTP ' + response.status + ')');
    url = URL.createObjectURL(await response.blob());
    link = document.createElement('a');
    link.href = url;
    link.download = 'cohort.csv';
    document.body.appendChild(link);
    link.click();
    button.textContent = 'Export CSV';
  } catch (error) {
    button.textContent = 'Export failed — retry';
  } finally {
    if (link) link.remove();
    // Give the browser time to start consuming the download before revoking.
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    button.disabled = false;
  }
}

function pageCohort(dir) {
  _cohortOffset = Math.max(0, _cohortOffset + dir * COHORT_PAGE);
  runCohort();
}

// ── Settings ──

let _settingsData = null, _settingsTab = 'sending';
const PROVIDER_LABELS = {
  gmail: 'Gmail', microsoft: 'Microsoft 365', smtp: 'SMTP', instantly: 'Instantly',
};

// The four facts over the Settings tabs. `s` is /api/settings, `m` /api/sending-mode.
function settingsSummary(s, m) {
  const st = s || {};
  const prov = st.provider || '';
  const who = prov === 'smtp' ? st.smtp_username
    : prov === 'gmail' ? (st.gmail_authorized ? 'signed in' : st.gmail_client_id ? 'not signed in yet' : 'not set up')
    : prov === 'microsoft' ? (st.m365_authorized ? 'signed in' : st.m365_client_id ? 'not signed in yet' : 'not set up')
    : prov === 'instantly' ? (st.instantly_api_key_set ? 'API key saved' : 'no API key') : '';
  const verifiers = [['Reoon', st.reoon_api_key_set], ['ZeroBounce', st.zerobounce_api_key_set], ['Hunter', st.hunter_api_key_set]]
    .filter(v => v[1]).map(v => v[0]);
  const optional = [st.linkedin_email || st.linkedin_password_set, st.cloudflare_account_id || st.cloudflare_api_token_set]
    .filter(Boolean).length;
  const auto = m && m.mode === 'autopilot';
  return uiMetricStrip([
    {label: 'Sending mode', value: m ? (auto ? 'Autopilot' : 'Approval') : null,
     sub: m ? (auto ? 'Sellbird sends on its own' : 'you approve every email') : ''},
    {label: 'Email provider', value: s ? (own(PROVIDER_LABELS, prov) || prov || null) : null, sub: who || ''},
    {label: 'Verifiers', value: s ? verifiers.length + ' set' : null, sub: verifiers.join(', ') || (s ? 'none yet' : '')},
    {label: 'Optional services', value: s ? optional + ' of 2' : null, sub: 'LinkedIn, Cloudflare'},
  ]);
}

function renderSettingsSummary() {
  const el = document.getElementById('settings-summary');
  if (el) el.innerHTML = settingsSummary(_settingsData, _sendingMode);
}

// Every panel stays in the page (each field keeps its id); the tabs only show one.
function showSettingsTab(key, btn) {
  _settingsTab = key;
  document.querySelectorAll('#settings [data-settings-panel]').forEach(p => { p.hidden = p.dataset.settingsPanel !== key; });
  document.querySelectorAll('#settings .ui-tab[data-tab]').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === key)));
}

async function loadSettings() {
  const data = await api('/api/settings');
  if (!data) return;
  _settingsData = data;
  renderSettingsSummary();

  // Active provider indicator
  const prov = data.provider || 'instantly';
  const provEl = document.getElementById('active-provider');
  if (provEl) provEl.textContent = own(PROVIDER_LABELS, prov) || prov;
  document.querySelectorAll('#settings [data-provider-active]').forEach(b => { b.hidden = b.dataset.providerActive !== prov; });

  // Secret fields never echo a value — show a "saved" placeholder instead.
  const savedPh = (id, isSet, base) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = '';
    el.placeholder = isSet ? 'Saved — enter new value to change' : base;
  };
  const tag = (id, ok, okLabel) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'ui-badge ' + (ok ? 'is-success' : 'is-neutral');
    el.textContent = ok ? okLabel : 'Not set';
  };

  // Non-secret values repopulate
  document.getElementById('gmail-id').value = data.gmail_client_id || '';
  document.getElementById('smtp-host').value = data.smtp_host || '';
  document.getElementById('smtp-port').value = data.smtp_port || '';
  document.getElementById('smtp-user').value = data.smtp_username || '';
  document.getElementById('imap-host').value = data.imap_host || '';
  document.getElementById('imap-port').value = data.imap_port || '';
  document.getElementById('imap-user').value = data.imap_username || '';
  document.getElementById('m365-client').value = data.m365_client_id || '';
  document.getElementById('m365-tenant').value = data.m365_tenant_id || '';
  document.getElementById('linkedin-email').value = data.linkedin_email || '';
  document.getElementById('cf-account-id').value = data.cloudflare_account_id || '';

  savedPh('gmail-secret', data.gmail_client_secret_set, 'Enter client secret');
  savedPh('smtp-pass', data.smtp_password_set, 'Enter password / app password');
  savedPh('imap-pass', data.imap_password_set, 'Same as SMTP password');
  document.getElementById('imap-same-pass').checked = !data.imap_password_set;
  savedPh('instantly-key', data.instantly_api_key_set, 'Enter your Instantly API key');
  savedPh('reoon-key', data.reoon_api_key_set, '600 free/mo — reoon.com/email-verifier');
  savedPh('zerobounce-key', data.zerobounce_api_key_set, '100 free/mo — best for M365/Workspace catch-alls');
  savedPh('hunter-key', data.hunter_api_key_set, '50 free/mo + email-pattern lookup');
  savedPh('linkedin-password', data.linkedin_password_set, 'Enter password');
  savedPh('cf-api-token', data.cloudflare_api_token_set, 'Your Cloudflare API Token');

  // Gmail auth status chip
  const g = document.getElementById('gmail-status');
  if (g) {
    const realId = /^\d+-[0-9a-z]+\.apps\.googleusercontent\.com$/.test((data.gmail_client_id || '').trim());
    if (data.gmail_client_id && !realId) { g.className = 'ui-badge is-danger'; g.textContent = 'client ID isn\'t real'; }
    else if (data.gmail_authorized) { g.className = 'ui-badge is-success'; g.textContent = 'authorized'; }
    else if (data.gmail_client_secret_set) { g.className = 'ui-badge is-warning'; g.textContent = 'sign in on Inboxes'; }
    else { g.className = 'ui-badge is-neutral'; g.textContent = 'Not set up'; }
  }
  const m = document.getElementById('m365-status');
  if (m) {
    const realM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((data.m365_client_id || '').trim());
    if (data.m365_client_id && !realM) { m.className = 'ui-badge is-danger'; m.textContent = 'client ID isn\'t real'; }
    else if (data.m365_authorized) { m.className = 'ui-badge is-success'; m.textContent = 'authorized'; }
    else if (data.m365_client_id) { m.className = 'ui-badge is-warning'; m.textContent = 'sign in on Inboxes'; }
    else { m.className = 'ui-badge is-neutral'; m.textContent = 'Not set up'; }
  }
  tag('reoon-status', data.reoon_api_key_set, 'Set');
  tag('zerobounce-status', data.zerobounce_api_key_set, 'Set');
  tag('hunter-status', data.hunter_api_key_set, 'Set');
}

function saveGmail() {
  const payload = {GMAIL_CLIENT_ID: document.getElementById('gmail-id').value.trim()};
  const sec = document.getElementById('gmail-secret').value;
  if (sec) payload.GMAIL_CLIENT_SECRET = sec;
  saveEnv(payload, 'Saved. Now sign in on the Inboxes tab.').then(loadSettings);
}

function saveSmtp() {
  const payload = {
    SMTP_HOST: document.getElementById('smtp-host').value.trim(),
    SMTP_PORT: document.getElementById('smtp-port').value.trim(),
    SMTP_USERNAME: document.getElementById('smtp-user').value.trim(),
  };
  const pass = document.getElementById('smtp-pass').value;
  if (pass) payload.SMTP_PASSWORD = pass;
  // Blank IMAP fields fall back to the SMTP ones. A typed IMAP password wins;
  // otherwise the checkbox clears it back to the SMTP one, and an unticked
  // empty box keeps whatever IMAP password is saved.
  payload.IMAP_HOST = document.getElementById('imap-host').value.trim();
  payload.IMAP_PORT = document.getElementById('imap-port').value.trim();
  payload.IMAP_USERNAME = document.getElementById('imap-user').value.trim();
  const imapPass = document.getElementById('imap-pass').value;
  if (imapPass) payload.IMAP_PASSWORD = imapPass;
  else if (document.getElementById('imap-same-pass').checked) payload.IMAP_PASSWORD = '';
  saveEnv(payload, 'SMTP settings saved.').then(loadSettings);
}

function saveMicrosoft() {
  const client = document.getElementById('m365-client').value.trim();
  if (!client) { showToast('Paste the Application (client) ID first.', 'error'); return; }
  saveEnv({M365_CLIENT_ID: client, M365_TENANT_ID: document.getElementById('m365-tenant').value.trim()},
          'Saved. Now sign in on the Inboxes tab.').then(loadSettings);
}

function saveVerifiers() {
  const payload = {};
  const r = document.getElementById('reoon-key').value;
  const z = document.getElementById('zerobounce-key').value;
  const h = document.getElementById('hunter-key').value;
  if (r) payload.REOON_API_KEY = r;
  if (z) payload.ZEROBOUNCE_API_KEY = z;
  if (h) payload.HUNTER_API_KEY = h;
  if (!Object.keys(payload).length) { showToast('Enter at least one key first.', 'error'); return; }
  saveEnv(payload, 'Verification keys saved.').then(loadSettings);
}

async function saveEnv(payload, okMsg) {
  const data = await api('/api/settings/env', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  });
  if (data && data.success) showToast(okMsg, 'success');
  else showToast((data && data.message) || 'Save failed — is the dashboard still running?', 'error');
}

// Secrets are only sent when typed: an empty box means "keep the saved one".
function saveInstantly() {
  const key = document.getElementById('instantly-key').value.trim();
  if (!key) { showToast('Enter a new key first. The saved one is kept.', 'error'); return; }
  saveEnv({INSTANTLY_API_KEY: key}, 'Instantly API key saved.');
}

function saveLinkedIn() {
  const payload = {LINKEDIN_EMAIL: document.getElementById('linkedin-email').value.trim()};
  const pass = document.getElementById('linkedin-password').value;
  if (pass) payload.LINKEDIN_PASSWORD = pass;
  saveEnv(payload, 'LinkedIn credentials saved.');
}

function saveCloudflare() {
  const payload = {CLOUDFLARE_ACCOUNT_ID: document.getElementById('cf-account-id').value.trim()};
  const token = document.getElementById('cf-api-token').value.trim();
  if (token) payload.CLOUDFLARE_API_TOKEN = token;
  saveEnv(payload, 'Cloudflare credentials saved.');
}

async function testInstantly() {
  const key = document.getElementById('instantly-key').value.trim();
  const el = document.getElementById('instantly-test-result');
  el.innerHTML = '<div class="test-result pending">Testing&hellip;</div>';
  const data = await api('/api/settings/test-instantly', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({api_key: key})
  });
  if (!data) {
    el.innerHTML = '<div class="test-result error">Could not reach the dashboard server.</div>';
    return;
  }
  el.innerHTML = '<div class="test-result ' + (data.success ? 'success' : 'error') + '">' + escHtml(failMsg(data, '')) + '</div>';
}

// ── Controls ──

function controlsBadge(data) {
  if (!data) return uiBadge('danger', 'Offline');
  return data.running ? uiBadge('success', 'Running', 'check') : uiBadge('neutral', 'Stopped');
}

// The Agent card: what the loop is doing, and the one button that changes it.
function controlsAgentCard(data) {
  if (!data) {
    return uiCard({title: 'Agent', body: '<p class="usage-note">The dashboard can\'t reach its server, so it can\'t tell whether Sellbird is running.</p>'});
  }
  const running = !!data.running;
  const details = '<dl class="ui-details ui-details--stacked">'
    + '<div><dt>Status</dt><dd>' + controlsBadge(data) + '</dd></div>'
    + '<div><dt>PID</dt><dd class="ctrl-mono">' + uiDash(running && data.pid ? String(data.pid) : '') + '</dd></div>'
    + '<div><dt>Started</dt><dd>' + (running && data.started_at ? formatDate(data.started_at) : uiDash('')) + '</dd></div>'
    + '</dl>';
  const note = running ? '' : '<p class="usage-note">Sellbird wakes every few minutes, does what needs doing, and sleeps.</p>';
  const btn = running
    ? '<button class="btn btn-danger btn-sm" id="btn-stop" onclick="stopSellbird()">Stop Sellbird</button>'
    : '<button class="btn btn-primary btn-sm" id="btn-start" onclick="startSellbird()">Start Sellbird</button>';
  return uiCard({title: 'Agent', body: details + note + '<div class="ctrl-actions">' + btn + '</div>'});
}

async function loadSellbirdStatus() {
  const data = await api('/api/sellbird/status');
  const headerDot = document.getElementById('header-dot');
  const headerText = document.getElementById('header-status-text');

  if (_locked) return;  // the header already says "Locked"
  const badgeEl = document.getElementById('controls-badge');
  const agentEl = document.getElementById('controls-agent');
  if (!data) {
    headerDot.className = 'status-dot offline';
    headerText.textContent = 'Offline';
    if (badgeEl) badgeEl.innerHTML = controlsBadge(null);
    if (agentEl) agentEl.innerHTML = controlsAgentCard(null);
    if (!_topbar.busy) { _topbar = {..._topbar, running: null}; renderTopbar(); }
    return;
  }
  const running = !!data.running;
  if (!_topbar.busy) { _topbar = {..._topbar, running}; renderTopbar(); }

  headerDot.className = 'status-dot ' + (running ? 'running' : 'stopped');
  headerText.textContent = running ? 'Sellbird is running' : 'Sellbird is stopped';
  if (badgeEl) badgeEl.innerHTML = controlsBadge(data);
  if (agentEl) agentEl.innerHTML = controlsAgentCard(data);
}

async function startSellbird() {
  const btn = document.getElementById('btn-start');
  if (btn) btn.disabled = true;
  const data = await api('/api/sellbird/start', {method: 'POST'});
  if (data && data.success) showToast('Sellbird started.', 'success');
  else showToast((data && data.message) || 'Failed to start.', 'error');
  if (btn) btn.disabled = false;
  loadSellbirdStatus();
}

async function stopSellbird() {
  const btn = document.getElementById('btn-stop');
  if (btn) btn.disabled = true;
  const data = await api('/api/sellbird/stop', {method: 'POST'});
  if (data && data.success) showToast('Sellbird stopped.', 'success');
  else showToast((data && data.message) || 'Failed to stop.', 'error');
  if (btn) btn.disabled = false;
  loadSellbirdStatus();
}

// Help: "On this page" scrolls without touching the URL hash (it carries the token).
function helpJump(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({behavior: 'smooth', block: 'start'});
}

// ── Top bar: the running switch, refresh, and what needs you ──

let _topbar = {running: null, busy: false, waiting: 0};

function topbarHtml(state) {
  const off = state.busy || state.running === null || state.running === undefined;
  return '<label class="ui-switch topbar-run">Sellbird running' +
      '<input type="checkbox" role="switch" aria-label="Sellbird running"' +
      (state.running ? ' checked' : '') + (off ? ' disabled' : '') +
      ' onchange="setRunning(this.checked)"></label>' +
    '<button class="btn btn-secondary" onclick="loadCurrentTab()" title="Refresh this page">Refresh</button>' +
    '<button class="topbar-bell' + (state.waiting > 0 ? ' has-dot' : '') + '" aria-label="Notifications"' +
      ' title="' + (state.waiting > 0 ? escHtml(String(state.waiting)) + ' waiting on you' : 'Nothing waiting on you') + '"' +
      ' onclick="goTab(\'today\')">' + icon('bell') + '</button>';
}

function renderTopbar() {
  const el = document.getElementById('topbar-run');
  if (el) el.innerHTML = topbarHtml(_topbar);
}

async function setRunning(on) {
  const before = _topbar.running;
  _topbar = {..._topbar, running: on, busy: true};
  renderTopbar();
  const data = await api(on ? '/api/sellbird/start' : '/api/sellbird/stop', {method: 'POST'});
  const ok = !!(data && data.success);
  _topbar = {..._topbar, running: ok ? on : before, busy: false};
  if (ok) showToast(on ? 'Sellbird started.' : 'Sellbird stopped.', 'success');
  else showToast((data && data.message) || (on ? 'Failed to start.' : 'Failed to stop.'), 'error');
  renderTopbar();
  loadSellbirdStatus();
}

async function loadLogs() {
  const data = await api('/api/sellbird/logs');
  const el = document.getElementById('log-viewer');
  if (data && data.lines && data.lines.length) {
    const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    el.textContent = data.lines.join('\n');
    if (stick) el.scrollTop = el.scrollHeight;
  } else {
    el.textContent = '# No logs yet. Start Sellbird to see activity.';
  }
}

// ── Pipeline data ──

// Calls today per subscription — each labelled with the provider it ran on.
function brainCallChips(data) {
  const chip = (label, n) => '<span class="chip">' + label + ' calls today <b>' + escHtml(String(n || 0)) + '</b></span>';
  const codex = data.codex_calls_today || 0;
  const st = data.brain_status || {};
  // A paused brain must not look healthy: say so, and why.
  const paused = st.status === 'paused'
    ? '<span class="chip" title="' + escHtml(st.reason || '') + '">' +
      escHtml(st.provider === 'codex' ? 'Codex' : 'Brain') + ' <b>paused</b>: ' +
      escHtml((st.reason || '').slice(0, 120)) + '</span>'
    : '';
  if (data.brain_provider === 'codex') {
    return paused + chip('Codex', codex) + (data.claude_calls_today ? chip('Claude', data.claude_calls_today) : '');
  }
  return paused + chip('Claude', data.claude_calls_today) + (codex ? chip('Codex', codex) : '');
}

function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}


function emailTag(p) {
  if (!p.email) return '';
  // Fall back to the legacy boolean for rows predating email_status.
  const status = p.email_status || (p.email_verified ? 'verified' : 'guess');
  if (!own(STATUS, status)) return '';
  const m = statusMeta(status);
  return ' <span class="mini t-' + m.tone + '" title="Email ' + escHtml(m.label.toLowerCase()) + '">' +
    escHtml(m.label) + '</span>';
}

// Quota gauges for the ACTIVE provider only: Claude's are the numbers
// `/usage` shows in Claude Code; Codex's are the ChatGPT plan's limits.
// When they can't be read, say so rather than hiding the card.
function quotaCardHtml(data) {
  const provider = data && data.quota_provider;
  if (!provider) return '';
  const title = provider === 'codex' ? 'Codex (ChatGPT plan) Quota' : 'Claude Subscription Quota';
  const head = '<section class="ui-card usage-quota"><div class="ui-card__head"><h3 class="ui-card__title">'
    + escHtml(title) + '</h3></div>';
  if (!data.quota || !Object.keys(data.quota).length) {
    const why = provider === 'codex'
      ? "Quota unavailable: Sellbird couldn't read your ChatGPT plan's limits (check codex login, the Codex CLI version, and network)."
      : "Quota unavailable: Sellbird couldn't read your Claude subscription's limits (check claude login and network).";
    return head + '<p class="usage-note">' + escHtml(why) + ' Until it can, budgets count Sellbird\'s own calls.</p></section>';
  }
  const labels = {five_hour: '5-hour window', seven_day: 'Weekly', primary: 'Primary window',
                  secondary: 'Secondary window', limit_reached: 'Usage limit reached'};
  let html = '<div class="usage-metrics">';
  for (const [key, w] of Object.entries(data.quota)) {
    const pct = Math.min(100, Math.max(0, Number((w || {}).utilization) || 0));
    const resets = w && w.resets_at ? 'resets ' + formatDate(w.resets_at) : '';
    html += '<div class="ui-metric"><div class="ui-metric__label">' + escHtml(labels[key] || key) + '</div>'
      + '<div class="ui-metric__value' + (pct >= 80 ? ' is-high' : '') + '">' + pct.toFixed(0) + '% used</div>'
      + (resets ? '<div class="ui-metric__sub">' + escHtml(resets) + '</div>' : '') + '</div>';
  }
  return head + html + '</div></section>';
}

// Calls today, this week and this month; tokens as the caption.
function usageCallsCard(totals) {
  const t = totals || {};
  const m = (label, p, sub) => '<div class="ui-metric"><div class="ui-metric__label">' + label + '</div>'
    + '<div class="ui-metric__value">' + ((p || {}).calls || 0) + '</div><div class="ui-metric__sub">' + sub + '</div></div>';
  const io = p => 'out ' + fmtTokens((p || {}).output_tokens) + ' · in ' + fmtTokens((p || {}).input_tokens);
  return uiCard({title: 'Calls', body: '<div class="usage-metrics usage-metrics--3">'
    + m('Today', t.today, io(t.today)) + m('Last 7 days', t.week, io(t.week))
    + m('Last 30 days', t.month, 'cached ' + fmtTokens((t.month || {}).cache_read_tokens)) + '</div>'});
}

// The last 14 calendar days (UTC, as the server groups them), missing days as 0.
function usageDays(byDay, todayIso) {
  const have = {};
  (byDay || []).forEach(d => { if (d && d.day) have[d.day] = d; });
  const end = new Date((todayIso || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
  return Array.from({length: 14}, (_, i) => {
    const day = new Date(end - (13 - i) * 86400000).toISOString().slice(0, 10);
    const d = have[day] || {};
    return {day, output_tokens: Number(d.output_tokens) || 0, calls: Number(d.calls) || 0};
  });
}

function usageDailyCard(byDay, todayIso) {
  const days = usageDays(byDay, todayIso);
  const max = Math.max(...days.map(d => d.output_tokens), 0);
  const label = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', {day: 'numeric', month: 'short', timeZone: 'UTC'});
  const bars = days.map(d => '<span class="usage-bar' + (d.output_tokens ? ' on' : '') + '" style="height:'
    + (d.output_tokens && max ? Math.max(2, Math.round(d.output_tokens / max * 100)) : 2) + '%" title="'
    + escHtml(label(d.day) + ': ' + fmtTokens(d.output_tokens) + ' out, ' + d.calls + ' calls') + '"></span>').join('');
  return uiCard({title: 'Output tokens per day', action: escHtml('Last 14 days · peak ' + fmtTokens(max)),
    body: '<div class="usage-chart" role="img" aria-label="Output tokens per day">' + bars + '</div>'
      + '<div class="usage-axis"><span>' + escHtml(label(days[0].day)) + '</span><span>' + escHtml(label(days[13].day)) + '</span></div>'});
}

// By agent / task / model (and provider, when more than Claude ran).
function usageTabs(data, tab) {
  const d = data || {};
  const providers = d.by_provider || [];
  const tabs = [];
  if (providers.length > 1 || (providers.length === 1 && providers[0].provider !== 'claude'))
    tabs.push({key: 'provider', label: 'By provider'});
  tabs.push({key: 'agent', label: 'By agent'}, {key: 'task', label: 'By task'}, {key: 'model', label: 'By model'});
  const active = tabs.some(t => t.key === tab) ? tab : 'agent';
  const name = active.charAt(0).toUpperCase() + active.slice(1);
  const rows = d['by_' + active] || [];
  const table = rows.length ? uiTable({
    columns: [
      {key: active, header: name, render: r => '<span class="usage-name">' + uiDash(r[active]) + '</span>'},
      {key: 'calls', header: 'Calls', align: 'right', render: r => '<span class="ui-strong">' + (Number(r.calls) || 0) + '</span>'},
      {key: 'input_tokens', header: 'Input', align: 'right', render: r => escHtml(fmtTokens(r.input_tokens))},
      {key: 'output_tokens', header: 'Output', align: 'right', render: r => '<span class="ui-strong">' + escHtml(fmtTokens(r.output_tokens)) + '</span>'},
      {key: 'cache_read_tokens', header: 'Cache read', align: 'right', render: r => escHtml(fmtTokens(r.cache_read_tokens))},
    ],
    rows,
  }) : uiCard({body: uiEmpty('No usage recorded yet',
    'Once Sellbird starts making model calls (Claude or Codex), every one is logged here with exact calls and tokens by provider, agent and task.')});
  return uiTabs(tabs, active, k => 'setUsageTab(' + jsq(k) + ')') + '<div class="usage-table">' + table + '</div>';
}

let _usage = null, _usageTab = 'agent';
function setUsageTab(k) {
  _usageTab = k;
  const el = document.getElementById('usage-tables');
  if (el) el.innerHTML = usageTabs(_usage, _usageTab);
}

async function loadUsage() {
  const data = await api('/api/usage');
  const top = document.getElementById('usage-top');
  if (!data) {
    top.innerHTML = offlineState();
    document.getElementById('usage-daily').innerHTML = '';
    document.getElementById('usage-tables').innerHTML = '';
    return;
  }
  _usage = data;
  // No dollars: on a subscription plan usage isn't billed per token.
  top.innerHTML = quotaCardHtml(data) + usageCallsCard(data.totals);
  document.getElementById('usage-daily').innerHTML = usageDailyCard(data.by_day);
  setUsageTab(_usageTab);
}

// ── Outbox: a decisions desk, not a wall of drafts ──
//
// Approving mail is a queue of one-at-a-time judgements. The list shows what
// is waiting, scheduled, sent and stuck; each email opens on its own page
// with Reject / Edit / Approve, and A/R/E/J/K work there. "Approve all"
// leaves anything Sellbird held for you to read one by one.

const OUTBOX_PAGE = 25;
let _ob = {tab: null, offset: 0, data: null, picked: false};

// Every row lands in one bucket by its status. Rejected, failed and
// cancelled all go under "Didn't send", so a stuck send is never hidden.
function outboxBuckets(data) {
  const d = data || {};
  const b = {review: [], scheduled: [], sent: [], didnt: []};
  const by = {pending_review: 'review', approved: 'scheduled', sending: 'scheduled', sent: 'sent',
              failed: 'didnt', rejected: 'didnt', cancelled: 'didnt'};
  const from = [['pending', 'review'], ['approved', 'scheduled'], ['sent', 'sent'], ['failed', 'didnt']];
  for (const [key, fallback] of from) {
    for (const r of (d[key] || [])) b[own(by, r && r.status) || fallback].push(r);
  }
  return b;
}

function outboxStatusBadge(r) {
  switch (r && r.status) {
    case 'pending_review': return heldReason(r) ? uiBadge('danger', 'Held') : uiBadge('warning', 'To review');
    case 'approved': return uiBadge('info', 'Scheduled');
    case 'sending': return uiBadge('info', 'Sending');
    case 'sent': return uiBadge('success', 'Sent', 'check');
    case 'failed': return uiBadge('danger', 'Failed', 'alert');
    case 'rejected': return uiBadge('neutral', 'Rejected');
    case 'cancelled': return uiBadge('neutral', 'Cancelled');
  }
  return uiBadge('neutral', String((r && r.status) || 'Unknown').replace(/_/g, ' '));
}

function outboxStep(r) {
  if (r && r.kind === 'reply') return 'Reply';
  return r && r.step !== undefined && r.step !== null && r.step !== '' ? 'Email ' + r.step : '';
}

// The numbers above the tabs. The endpoint caps Sent and Didn't send at 25
// rows, so a full list says "last 25" rather than passing for a total.
function outboxSummary(b, data) {
  const n = (rows, cap) => rows.length >= cap ? rows.length + '+' : rows.length;
  const held = b.review.filter(r => heldReason(r)).length;
  const next = b.scheduled.map(r => r.send_at).filter(Boolean).sort()[0];
  const today = new Date().toDateString();
  const sentToday = b.sent.filter(r => r.sent_at && parseTs(r.sent_at).toDateString() === today).length;
  const capped = b.sent.length >= 25;
  return uiMetricStrip([
    {label: 'To review', value: b.review.length,
     sub: !b.review.length ? 'nothing waiting' : held ? held + ' held for you' : 'waiting for your decision'},
    {label: 'Scheduled', value: b.scheduled.filter(r => r.status === 'approved').length >= 50 ? b.scheduled.length + '+' : b.scheduled.length,
     sub: next ? 'next sends ' + formatDate(next) : 'nothing queued'},
    {label: 'Sent', value: n(b.sent, 25),
     sub: (capped && sentToday >= 25 ? '25+' : sentToday) + ' today' + (capped ? ' · last 25 shown' : '')},
    {label: 'Didn’t send', value: n(b.didnt, 25),
     sub: 'rejected, failed or cancelled' + (b.didnt.length >= 25 ? ' · last 25' : '')},
  ]);
}

function outboxTable(rows, kind) {
  const when = {review: ['Sends', 'send_at'], scheduled: ['Sends', 'send_at'],
                sent: ['Sent', 'sent_at'], didnt: ['Updated', 'updated_at']}[kind] || ['Sends', 'send_at'];
  const columns = [
    {key: 'to_email', header: 'To', render: r => '<span class="ui-strong">' + uiDash(r.to_email) + '</span>'},
    {key: 'status', header: '', render: r => outboxStatusBadge(r)},
    {key: 'step', header: 'Step', render: r => uiDash(outboxStep(r))},
    {key: 'subject', header: 'Subject', render: r => '<span class="ob-clip">' + uiDash(r.subject) + '</span>'},
  ];
  if (kind === 'didnt') {
    columns.push({key: 'error', header: 'Reason', render: r => '<span class="ob-clip">' + uiDash(r.error) + '</span>'});
  }
  columns.push({key: 'when', header: when[0], align: 'right',
                render: r => r.status === 'sending' ? 'now' : (formatDate(r[when[1]]) || uiDash(''))});
  columns.push({key: 'menu', header: '', align: 'right', render: r => {
    const id = jsq(r.id);
    const items = [{label: 'Open email', js: 'openOutboxEmail(' + id + ')'}];
    if (r.status === 'pending_review') {
      items.push({label: 'Approve', js: 'outboxAct(' + id + ',\'approve\')'},
                 {label: 'Edit', js: 'openOutboxEmail(' + id + ');deskEdit(' + id + ')'},
                 {label: 'Reject', js: 'outboxAct(' + id + ',\'reject\')', danger: true});
    }
    return uiRowMenu(items);
  }});
  const empty = {review: 'Nothing to review', scheduled: 'Nothing scheduled', sent: 'Nothing sent yet',
                 didnt: 'Nothing failed, was rejected or cancelled'}[kind] || 'Nothing here yet';
  return uiTable({columns, rows, rowKey: r => r.id, empty,
                  onRow: r => 'openOutboxEmail(' + jsq(r.id) + ')'});
}

async function loadOutbox() {
  const [data, mode] = await Promise.all([api('/api/outbox'), api('/api/sending-mode')]);
  _sendingMode = mode && !mode.error ? mode : null;
  const banner = document.getElementById('outbox-banner');
  const list = document.getElementById('outbox-list');
  const parts = ['outbox-summary', 'outbox-tabs'].map(id => document.getElementById(id));
  if (!data || data.error) {
    _ob.data = null;
    _desk.open = null;
    outboxShowList(true);
    parts.forEach(el => { el.innerHTML = ''; });
    // Never let a failed read pass for "Nothing to review".
    list.innerHTML = !data ? offlineState()
      : uiBanner({tone: 'danger', iconName: 'alert', title: 'Couldn\'t read the Outbox', body: data.error});
    return;
  }
  _ob.data = data;
  const b = outboxBuckets(data);
  const pending = b.review;
  _desk.items = pending;
  _desk.footer = data.footer || '';
  // Keep the page on the draft being edited even if the list shifted.
  const editingAt = _desk.editing ? pending.findIndex(p => p.id === _desk.editing) : -1;
  if (editingAt < 0 && _desk.editing) {
    _desk.editing = null;
    _desk.unsaved = null;
  }
  const openAt = _desk.open !== null && _desk.open !== undefined ? pending.findIndex(p => p.id === _desk.open) : -1;
  if (openAt >= 0) _desk.i = openAt;
  if (_desk.i >= pending.length) _desk.i = Math.max(0, pending.length - 1);
  navCount('nav-outbox', pending.length);

  const approvable = pending.length - pending.filter(p => heldReason(p)).length;
  document.getElementById('outbox-actions').innerHTML =
    (pending.length && !data.paused && approvable
      ? '<button class="btn btn-secondary" onclick="outboxApproveAll()" ' +
        'title="Emails Sellbird held are left for you to approve one by one">Approve all ' + approvable + '</button>' : '') +
    (data.paused
      ? '<button class="btn btn-primary" onclick="sendingToggle(\'resume\')">Resume sending</button>'
      : '<button class="btn btn-secondary" onclick="sendingToggle(\'pause\')">Pause all sending</button>');

  // The kill switch gets a banner only when it's actually on — a permanent
  // bar for a thing that isn't happening is just noise.
  banner.innerHTML = sendingModeBanner(_sendingMode) + outboxNotices(data, b);

  if (!_ob.picked || !_ob.tab) {
    _ob.tab = ['review', 'scheduled', 'sent', 'didnt'].find(k => b[k].length) || 'review';
  }
  parts[0].innerHTML = outboxSummary(b, data);
  parts[1].innerHTML = uiTabs([
    {key: 'review', label: 'To review', count: b.review.length},
    {key: 'scheduled', label: 'Scheduled', count: b.scheduled.length},
    {key: 'sent', label: 'Sent', count: b.sent.length},
    {key: 'didnt', label: 'Didn’t send', count: b.didnt.length},
  ], _ob.tab, k => 'outboxTab(' + jsq(k) + ')');
  renderOutboxList(b);
  if (_desk.open !== null && _desk.open !== undefined && outboxFind(b, _desk.open)) renderOutboxEmail();
  else { _desk.open = null; outboxShowList(true); }
}

function outboxNotices(data, b) {
  let html = data.paused ? uiBanner({tone: 'danger', iconName: 'alert', title: 'Sending is paused',
    body: data.paused + '. Approved mail stays queued until you resume.'}) : '';
  // Only once there is mail to warn about: a fresh install sends nothing.
  const anyMail = b.review.length || b.scheduled.length || b.sent.length;
  if (data.compliance_notice && anyMail) {
    html += uiBanner({tone: 'warning', iconName: 'alert', title: 'Add your postal address', body: data.compliance_notice});
  }
  return html;
}

function renderOutboxList(b) {
  const rows = b[_ob.tab] || [];
  if (_ob.offset >= rows.length) _ob.offset = Math.max(0, Math.floor((rows.length - 1) / OUTBOX_PAGE) * OUTBOX_PAGE);
  let html = '';
  if (_ob.tab === 'review' && !rows.length) {
    html = '<div class="ui-card">' + uiEmpty('Nothing to review',
      _sendingMode && _sendingMode.mode === 'autopilot'
        ? 'Autopilot is on, so Sellbird sends on its own. Anything it holds for you shows up here.'
        : 'Every draft Sellbird writes lands here first. Approve one and it sends on schedule.') + '</div>';
  } else {
    html = outboxTable(pageSlice(rows, _ob.offset, OUTBOX_PAGE), _ob.tab)
      + uiPager({total: rows.length, offset: _ob.offset, size: OUTBOX_PAGE, onPage: o => 'outboxPage(' + o + ')'});
  }
  document.getElementById('outbox-list').innerHTML = html;
}

function outboxTab(key) {
  _ob.tab = key;
  _ob.picked = true;
  _ob.offset = 0;
  if (_ob.data) loadOutboxFromCache();
}

function outboxPage(offset) {
  _ob.offset = Math.max(0, offset);
  if (_ob.data) renderOutboxList(outboxBuckets(_ob.data));
}

function loadOutboxFromCache() {
  const b = outboxBuckets(_ob.data);
  document.getElementById('outbox-tabs').innerHTML = uiTabs([
    {key: 'review', label: 'To review', count: b.review.length},
    {key: 'scheduled', label: 'Scheduled', count: b.scheduled.length},
    {key: 'sent', label: 'Sent', count: b.sent.length},
    {key: 'didnt', label: 'Didn’t send', count: b.didnt.length},
  ], _ob.tab, k => 'outboxTab(' + jsq(k) + ')');
  renderOutboxList(b);
}

function outboxFind(b, id) {
  for (const k of ['review', 'scheduled', 'sent', 'didnt']) {
    const hit = b[k].find(r => String(r.id) === String(id));
    if (hit) return hit;
  }
  return null;
}

// The list and the email page share the section; one shows at a time.
function outboxShowList(on) {
  ['outbox-head', 'outbox-banner', 'outbox-summary', 'outbox-tabs', 'outbox-list'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('ob-hide', !on);
  });
  const desk = document.getElementById('outbox-desk');
  if (desk) {
    desk.classList.toggle('ob-hide', on);
    if (on) desk.innerHTML = '';
  }
}

function openOutboxEmail(id) {
  if (!_ob.data || deskBusy()) return;
  const b = outboxBuckets(_ob.data);
  const item = outboxFind(b, id);
  if (!item) return;
  const at = b.review.findIndex(r => String(r.id) === String(id));
  if (at >= 0) _desk.i = at;
  _desk.open = item.id;
  renderOutboxEmail();
  window.scrollTo(0, 0);
}

function closeOutboxEmail() {
  if (deskBusy()) return;
  _desk.open = null;
  outboxShowList(true);
}

function renderOutboxEmail() {
  if (!_ob.data) return;
  const b = outboxBuckets(_ob.data);
  const item = outboxFind(b, _desk.open);
  if (!item) { closeOutboxEmail(); return; }
  const at = b.review.findIndex(r => String(r.id) === String(item.id));
  const pos = at >= 0 ? {index: at, count: b.review.length} : null;
  outboxShowList(false);
  document.getElementById('outbox-desk').innerHTML = outboxEmailPage(item, item.context || null, pos, {
    editing: _desk.editing === item.id, unsaved: _desk.unsaved, footer: _desk.footer,
    paused: _ob.data.paused || '',
  });
}

const CONTACT_SOURCES = {
  known_company_backfill: 'team page on their site',
  company_website: 'team page on their site',
  scraped_mailto: 'address published on their site',
  linkedin_search: 'LinkedIn search',
  hunter_domain_search: 'Hunter domain search',
  job_board: 'job board',
  web_search: 'web search',
};

// What the draft is built on, so every claim can be checked against it:
// a Prospect card and a "What Sellbird used" card.
function renderDeskContext(ctx) {
  if (!ctx) return '';
  const dl = items => '<dl class="ui-details">' + items.map(([k, v]) =>
    '<div><dt>' + escHtml(k) + '</dt><dd>' + (v || uiDash('')) + '</dd></div>').join('') + '</dl>';
  const href = safeHref(ctx.website);
  const site = href
    ? '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' +
        escHtml(String(ctx.website).replace(/^https?:\/\//i, '')) + ' &#8599;</a>'
    : (ctx.website ? escHtml(ctx.website) : '');
  const source = Object.prototype.hasOwnProperty.call(CONTACT_SOURCES, ctx.contact_source)
    ? CONTACT_SOURCES[ctx.contact_source] : ctx.contact_source;
  const prospect = uiCard({title: 'Prospect', body: dl([
    ['Name', escHtml(ctx.contact || '')],
    ['Title', escHtml(ctx.contact_title || '')],
    ['Company', escHtml(ctx.company || '')],
    ['Website', site],
    ['Email status', ctx.email_status ? escHtml(ctx.email_status) : ''],
    ['Fit score', ctx.score ? escHtml(ctx.score) + ' of 100' : ''],
    ['Found via', escHtml(source || '')],
  ])});
  const signals = Object.entries(ctx.signals || {}).map(([k, v]) => ({k, v}));
  const used = uiCard({title: 'What Sellbird used', body:
    uiTable({columns: [{key: 'k', header: 'Signal'}, {key: 'v', header: 'Value', render: r => '<span class="ob-wrap">' + uiDash(r.v) + '</span>'}],
             rows: signals, empty: 'No signals recorded for this company'}) +
    dl([
      ['About', escHtml(ctx.description || '')],
      ['Campaign', ctx.campaign ? escHtml(ctx.campaign) +
        ' <span class="muted">(how they were found, not a fact about them)</span>' : ''],
      ['Writer notes', escHtml(ctx.notes || '')],
    ])});
  return prospect + used;
}

// One email on its own page. `pos` ({index, count}) is set only for an email
// waiting on you; anything else is shown read-only. `opts` carries the edit
// state: {editing, unsaved: {subject, body}, footer, paused}.
function outboxEmailPage(item, ctx, pos, opts) {
  const o = opts || {};
  const pending = item.status === 'pending_review';
  const editing = pending && !!o.editing;
  const id = jsq(item.id);
  const unsaved = (editing && o.unsaved) || {subject: item.subject || '', body: item.body || ''};
  const step = outboxStep(item);
  const whenKey = item.status === 'sent' ? ['Sent', item.sent_at]
    : ['failed', 'rejected', 'cancelled'].includes(item.status) ? ['Updated', item.updated_at] : ['Sends', item.send_at];
  const summary = [step, item.to_email ? 'To ' + item.to_email : '',
                   whenKey[1] ? whenKey[0] + ' ' + formatDate(whenKey[1]) : ''].filter(Boolean).join(' · ');

  let actions = '';
  if (pending && editing) {
    actions = '<button class="btn btn-secondary" onclick="deskEdit(null)">Cancel</button>' +
      '<button class="btn btn-primary" onclick="deskSave(' + id + ')">Save</button>';
  } else if (pending) {
    actions = '<button class="btn btn-secondary" onclick="outboxAct(' + id + ',\'reject\')">Reject <kbd>R</kbd></button>' +
      '<button class="btn btn-secondary" onclick="deskEdit(' + id + ')">Edit <kbd>E</kbd></button>' +
      '<button class="btn btn-primary" onclick="outboxAct(' + id + ',\'approve\')">' + icon('check') + 'Approve <kbd>A</kbd></button>';
  }
  const nav = pos && pos.count
    ? '<div class="ob-pos"><button type="button" class="btn btn-sm btn-secondary" aria-label="Previous email"' +
        (pos.index <= 0 ? ' disabled' : '') + ' onclick="deskGo(' + (pos.index - 1) + ')">&lsaquo;</button>' +
      '<span>' + (pos.index + 1) + ' of ' + pos.count + '</span>' +
      '<button type="button" class="btn btn-sm btn-secondary" aria-label="Next email"' +
        (pos.index >= pos.count - 1 ? ' disabled' : '') + ' onclick="deskGo(' + (pos.index + 1) + ')">&rsaquo;</button></div>'
    : '';
  const head = uiPageHead({
    title: item.subject || '(no subject)', sub: summary,
    crumbs: [{label: 'Outbox', js: 'closeOutboxEmail()'}, {label: item.to_email || 'Email'}],
    actions: nav + actions,
  }).replace('</h2>', ' ' + outboxStatusBadge(item) + '</h2>');

  const why = heldReason(item);
  const held = why ? uiBanner({tone: 'warning', iconName: 'alert', title: 'Sellbird held this instead of sending it',
    body: why + '. Read it before approving: text from a website or an email can try to steer what Sellbird writes.'}) : '';
  const paused = o.paused ? uiBanner({tone: 'danger', iconName: 'alert', title: 'Sending is paused',
    body: o.paused + '. Approved mail stays queued until you resume.'}) : '';

  // A reply keeps its subject: Gmail threads by it.
  const fixedSubject = item.kind === 'reply'
    ? ' readonly title="A reply keeps its subject so it stays in the thread"' : '';
  const footerText = o.footer || '';
  // Cold email leaves with the footer underneath; show it as it will go out.
  // Not added again when the body already ends with it, as in the Sender.
  const added = item.kind === 'sequence' && footerText && !(item.body || '').trimEnd().endsWith(footerText) ? footerText : '';
  const meta = [['To', escHtml(item.to_email || '')], [whenKey[0], formatDate(whenKey[1])],
                ['Campaign', ctx && ctx.campaign ? escHtml(ctx.campaign) : '']];
  if (item.error && !why) meta.push(['Reason', escHtml(item.error)]);
  const body = editing
    ? '<label class="form-label" for="desk-subject">Subject</label>' +
      '<input id="desk-subject" class="desk-edit-subject" value="' + escHtml(unsaved.subject) + '"' + fixedSubject + ' oninput="deskKeep()">' +
      '<label class="form-label" for="desk-body">Body</label>' +
      '<textarea id="desk-body" class="desk-edit-body" rows="14" oninput="deskKeep()">' + escHtml(unsaved.body) + '</textarea>'
    : '<dl class="ui-details ob-meta">' + meta.map(([k, v]) =>
        '<div><dt>' + escHtml(k) + '</dt><dd>' + (v || uiDash('')) + '</dd></div>').join('') + '</dl>' +
      '<div class="ob-body">' + (item.body ? escHtml(item.body) : uiDash('')) + '</div>';
  const footer = added
    ? '<div class="desk-footer" title="Added when it sends (compliance in sellbird.yaml)">' + escHtml(added) + '</div>' : '';
  const cardActions = pending && !editing
    ? '<div class="ob-card-actions"><button class="btn btn-sm btn-ghost" onclick="deskEdit(' + id + ')">Edit</button></div>' : '';
  const email = uiCard({title: 'Email', action: step ? uiBadge('neutral', step) : '', body: body + footer + cardActions});
  const side = ctx ? renderDeskContext(ctx)
    : uiCard({title: 'Prospect', body: uiEmpty('No prospect details here',
        pending ? 'Sellbird didn’t record what this draft was built on.' : 'Prospect details are shown for emails waiting on you.')});
  return '<div class="ui-page">' + head + paused + held +
    '<div class="ui-grid ob-email">' + email + '<div class="ui-stack">' + side + '</div></div></div>';
}

// ── Approval or autopilot ──
// Approval (the default): every email waits in the Outbox for you.
// Autopilot (channels.email.require_approval: false): Sellbird sends on its
// own, and still holds what gate.autopilot_review flags. Turning autopilot
// on takes typing the word; turning it off is one click and works at once.
let _sendingMode = null, _autopilotArmed = false, _modeBusy = false;

function sendingModeBanner(m) {
  if (!m) return '';
  if (m.mode === 'autopilot') {
    return '<div class="banner wait mode-banner">' + icon('alert') + '<div><b>Autopilot is on</b>' +
      '<p>Sellbird sends email on its own. It holds anything that links to a site that isn’t yours or ' +
      'quotes its own instructions; those wait here' + (m.held ? ' (' + m.held + ' now)' : '') + '.</p></div>' +
      '<button class="btn btn-secondary btn-sm" onclick="setSendingMode(\'approval\')"' +
        (_modeBusy ? ' disabled' : '') + '>Turn off autopilot</button></div>';
  }
  const instantly = m.provider === 'instantly';
  return '<div class="banner mode-banner">' + icon('check') + '<div><b>Approval mode</b>' +
    '<p>' + (instantly
      ? 'Instantly can’t hold single emails, so campaigns aren’t sent to Instantly until you turn on autopilot.'
      : 'Every email Sellbird writes waits here until you approve it.') +
    ' <a href="#" onclick="goTab(\'settings\');return false">About autopilot</a></p></div></div>';
}

function sendingModeCard(m) {
  if (!m) return '<div class="card muted">Couldn’t read the sending mode.</div>';
  const auto = m.mode === 'autopilot';
  const instantly = m.provider === 'instantly';
  const domains = (m.your_domains || []).map(escHtml).join(', ') || 'none yet';
  let html = '<div class="ui-card mode-card"><div class="ui-card__head"><h3 class="ui-card__title">Sending mode: ' + (auto ? 'Autopilot' : 'Approval') + '</h3>' +
    '<span class="ui-badge ' + (auto ? 'is-warning' : 'is-success') + '">' + (auto ? 'Autopilot' : 'Approval') + '</span></div>' +
    '<p class="mode-opt' + (auto ? '' : ' is-on') + '"><b>Approval</b> (the default): every email Sellbird writes, first emails, follow-ups and replies, ' +
      'waits in the Outbox until you approve it.' +
      (instantly ? ' On Instantly, which can’t hold single emails, that means campaigns aren’t deployed.' : '') + '</p>' +
    '<p class="mode-opt' + (auto ? ' is-on' : '') + '"><b>Autopilot</b>: Sellbird sends on its own, on schedule, within your daily limit and quiet hours. ' +
      'Opt-outs, bounces and Pause all sending work the same. It still holds an email for you when it links ' +
      'to, or gives an address at, a site that isn’t yours, or quotes Sellbird’s own instructions: text from ' +
      'websites and replies can try to steer what it writes. The first reply after you undo an opt-out waits too.</p>' +
    '<p class="mode-note">Counted as yours: ' + domains + (m.booking_page ? '; your booking page ' + escHtml(m.booking_page) : '') +
      '. Add others under <code>channels.email.link_domains</code> in <code>' + escHtml(m.file) + '</code>.</p>';
  if (auto) {
    html += '<div class="convo-actions"><span class="muted">Turning it off works at once: emails autopilot ' +
      'approved that haven’t gone out come back to the Outbox.' +
      (instantly ? ' Campaigns already on Instantly keep running until you pause them there.' : '') + '</span>' +
      '<button class="btn btn-primary btn-sm" onclick="setSendingMode(\'approval\')"' +
        (_modeBusy ? ' disabled' : '') + '>Turn off autopilot</button></div>';
  } else if (_autopilotArmed) {
    html += '<div class="convo-actions mode-confirm"><span class="muted">Approve a batch or two by hand first ' +
      'and read what Sellbird writes. Type <b>autopilot</b> to turn it on. It starts from Sellbird’s next cycle.</span>' +
      '<input class="form-input" id="autopilot-confirm" autocomplete="off" aria-label="Type autopilot to confirm" ' +
        'oninput="document.getElementById(\'autopilot-go\').disabled = this.value.trim().toLowerCase() !== \'autopilot\'" ' +
        'onkeydown="if (event.key === \'Enter\' && this.value.trim().toLowerCase() === \'autopilot\') setSendingMode(\'autopilot\')">' +
      '<button class="btn btn-primary btn-sm" id="autopilot-go" disabled onclick="setSendingMode(\'autopilot\')">Turn on autopilot</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="_autopilotArmed=false;renderSendingModeCard()">Cancel</button></div>';
  } else {
    html += '<div class="convo-actions"><button class="btn btn-secondary btn-sm" ' +
      'onclick="_autopilotArmed=true;renderSendingModeCard()">Turn on autopilot…</button></div>';
  }
  return html + '</div>';
}

function renderSendingModeCard() {
  const el = document.getElementById('sending-mode-card');
  if (el) el.innerHTML = sendingModeCard(_sendingMode);
  const input = document.getElementById('autopilot-confirm');
  if (input) input.focus();
}

async function loadSendingModeCard() {
  const m = await api('/api/sending-mode');
  _sendingMode = m && !m.error ? m : null;
  renderSendingModeCard();
  renderSettingsSummary();
}

async function setSendingMode(mode) {
  if (_modeBusy) return;
  const body = {mode};
  if (mode === 'autopilot') {
    const input = document.getElementById('autopilot-confirm');
    body.confirm = input ? input.value.trim().toLowerCase() : '';
  }
  _modeBusy = true;
  document.querySelectorAll('.mode-banner button, .mode-card button').forEach(b => { b.disabled = true; });
  try {
    const res = await api('/api/sending-mode', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    if (res && res.success) {
      _autopilotArmed = false;
      showToast(mode === 'autopilot'
        ? 'Autopilot is on from Sellbird’s next cycle. Held emails still wait for you.'
        : 'Autopilot is off. Every email waits for you' +
          (res.requeued ? '; ' + res.requeued + ' queued by autopilot came back to the Outbox.' : '.') +
          (_sendingMode && _sendingMode.provider === 'instantly'
            ? ' Campaigns already on Instantly keep running: pause them in Instantly.' : ''), 'success');
    } else {
      showToast(failMsg(res, 'Couldn’t change the sending mode.'), 'error');
    }
  } finally {
    _modeBusy = false;
  }
  loadSendingModeCard();
  loadOutbox();
}

// Why autopilot sent this back for a human (sender: gate.autopilot_review).
const HELD_PREFIX = 'held for your review: ';   // state.HELD_FOR_REVIEW
function heldReason(item) {
  const e = String((item && item.error) || '');
  const why = e.startsWith(HELD_PREFIX) ? e.slice(HELD_PREFIX.length) : '';
  return why.charAt(0).toUpperCase() + why.slice(1);
}

function deskEdit(id) {
  _desk.editing = id;
  _desk.unsaved = null;
  if (id !== null && id !== undefined) _desk.open = id;
  renderOutboxEmail();
  if (id) document.getElementById('desk-body').focus();
}

// What's typed survives a re-render (switching tabs and back reloads the desk).
function deskKeep() {
  _desk.unsaved = {
    subject: document.getElementById('desk-subject').value,
    body: document.getElementById('desk-body').value,
  };
}

// While a draft is being edited, nothing else on the desk may act on the
// stored version of it: Save or Cancel first.
function deskBusy() {
  if (!_desk.editing) return false;
  showToast('Save or cancel your edit first.', 'error');
  return true;
}

async function deskSave(id) {
  const subject = document.getElementById('desk-subject').value.trim();
  const body = document.getElementById('desk-body').value.trim();
  if (!subject || !body) { showToast('Subject and body are both required.', 'error'); return; }
  let data = null;
  try {
    const r = await authFetch('/api/outbox/' + encodeURIComponent(id) + '/edit', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({subject: subject, body: body}),
    });
    if (await lockIfRefused(r)) return;
    data = await r.json();
  } catch {}
  if (data && data.success) {
    _desk.editing = null;
    _desk.unsaved = null;
    showToast('Saved. Still waiting for your approval.', 'success');
    loadOutbox();
  } else {
    showToast((data && data.message) || 'Save failed.', 'error');
  }
}

// Move to another pending email. Stops at the ends; never wraps.
function deskGo(n) {
  if (n < 0 || n >= _desk.items.length || deskBusy()) return;
  _desk.i = n;
  _desk.open = _desk.items[n].id;
  renderOutboxEmail();
}

// Keyboard review on an email's page: A approve, R reject, E edit, J/K next
// and previous pending email. Nothing happens while typing in a field, so
// editing a draft (or Settings) never approves or rejects it.
function outboxKey(e) {
  if (currentTab !== 'outbox' || e.metaKey || e.ctrlKey || e.altKey) return;
  // A held-down key, or a second press while the first is still sending,
  // would act on the next email before it is on screen.
  if (e.repeat || _desk.acting) return;
  const stop = () => { if (e.preventDefault) e.preventDefault(); };
  const t = e.target || {};
  const typing = /^(input|textarea|select)$/i.test(t.tagName || '') || !!t.isContentEditable;
  const k = String(e.key || '').toLowerCase();
  if (_desk.editing) {
    // Mid-edit, A would approve the stored draft, not what's typed. Only
    // Escape (cancel) works until the edit is saved or cancelled.
    if (e.key === 'Escape') { stop(); deskEdit(null); }
    else if (!typing && 'jkare'.includes(k) && k) { stop(); deskBusy(); }
    return;
  }
  if (typing || !k) return;
  const at = _desk.items.findIndex(p => String(p.id) === String(_desk.open));
  if (at < 0) return;   // only on a pending email's page
  _desk.i = at;
  const cur = _desk.items[at];
  if (k === 'j') { stop(); deskGo(at + 1); }
  else if (k === 'k') { stop(); deskGo(at - 1); }
  else if (k === 'a') { stop(); outboxAct(cur.id, 'approve'); }
  else if (k === 'r') { stop(); outboxAct(cur.id, 'reject'); }
  else if (k === 'e') { stop(); deskEdit(cur.id); }
}

document.addEventListener('keydown', outboxKey);

async function outboxAct(id, action) {
  if (_desk.acting || deskBusy()) return;
  _desk.acting = true;
  // Acting on the open email moves the page on to the next one waiting.
  if (String(_desk.open) === String(id)) {
    const at = _desk.items.findIndex(p => String(p.id) === String(id));
    const next = _desk.items[at + 1] || _desk.items[at - 1];
    _desk.open = next ? next.id : null;
  }
  const data = await api('/api/outbox/' + encodeURIComponent(id) + '/' + action, {method: 'POST'});
  if (data && data.success) showToast(action === 'approve' ? 'Approved — will send on schedule.' : 'Rejected.', 'success');
  else showToast(failMsg(data, 'Action failed.'), 'error');
  try { await loadOutbox(); } finally { _desk.acting = false; }
}

async function outboxApproveAll() {
  if (deskBusy()) return;
  const data = await api('/api/outbox/approve-all', {method: 'POST'});
  if (data && data.success) showToast('Approved ' + data.approved + ' email(s).' + (data.held
    ? ' ' + data.held + ' Sellbird held ' + (data.held === 1 ? 'is' : 'are') + ' left for you to read and approve one by one.'
    : ''), 'success');
  else showToast(failMsg(data, 'Approve-all failed.'), 'error');
  loadOutbox();
}

async function sendingToggle(action) {
  const data = await api('/api/sending/' + action, {method: 'POST'});
  if (data && data.success) showToast(action === 'pause' ? 'Sending paused.' : 'Sending resumed.', 'success');
  else showToast(failMsg(data, action === 'pause' ? 'Could not pause sending.' : 'Could not resume sending.'), 'error');
  loadOutbox();
}

// ── Companies and Contacts: shared list parts ──
// Pure render helpers both list tabs use: a fit/score bar, boxed count tabs,
// filter chips that open a menu of values, the pager and a details list.

function listBar(value, tone) {
  if (value === null || value === undefined || value === '' || isNaN(Number(value))) return uiDash('');
  const v = Math.max(0, Math.min(100, Math.round(Number(value))));
  const t = tone || (v >= 50 ? 'good' : v >= 30 ? 'brand' : 'muted');
  return '<span class="lists-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + v + '">'
    + '<span class="lists-bar__track"><i class="is-' + t + '" style="width:' + v + '%"></i></span>'
    + '<span class="lists-bar__n">' + v + '</span></span>';
}

// Boxed tabs with a count under each label (the design's CountTabs).
function listCountTabs(items, activeKey, onSelect) {
  return '<div class="lists-counts" role="tablist">' + items.map(t =>
    '<button type="button" class="lists-count" role="tab" aria-selected="' + (t.key === activeKey) + '" onclick="'
    + onSelect(t.key) + '">' + escHtml(t.label)
    + '<span class="lists-count__n">' + escHtml(String(Number(t.count) || 0)) + '</span></button>').join('') + '</div>';
}

// A filter chip that opens a short menu of values. Applied, it shows the value.
function listFilterChip({label, value = '', options = [], onPick, clearJs = ''}) {
  const applied = value !== '' && value !== null && value !== undefined;
  const close = 'this.closest(\'details\').open=false;';
  return '<details class="ui-menu lists-filter"><summary class="lists-chip' + (applied ? ' is-applied' : '') + '">'
    + icon(applied ? 'close' : 'plus') + escHtml(label)
    + (applied ? '<span class="lists-chip__sep"></span><span class="lists-chip__value">' + escHtml(value) + '</span>'
      + icon('chevron', 'lists-chip__chev') : '')
    + '</summary><div class="ui-menu__list lists-menu">'
    + (applied && clearJs ? '<button type="button" onclick="' + close + clearJs + '">Any ' + escHtml(String(label).toLowerCase()) + '</button>' : '')
    + options.map(o => '<button type="button"' + (o.on ? ' aria-pressed="true"' : '') + ' onclick="' + close + onPick(o.key) + '">'
      + (o.on ? icon('check') : '') + '<span>' + escHtml(o.label) + '</span>'
      + (o.count !== undefined ? '<span class="lists-menu__n">' + escHtml(String(o.count)) + '</span>' : '') + '</button>').join('')
    + (options.length ? '' : '<div class="lists-menu__empty">Nothing to filter by yet</div>')
    + '</div></details>';
}

// "1–50 of 302 companies · Page 1 of 7", Previous, Next. A null js disables the button.
function listPager(summary, prevJs, nextJs) {
  return '<div class="ui-pager"><span>' + escHtml(summary) + '</span><div class="ui-pager__btns">'
    + '<button type="button" class="btn btn-sm"' + (prevJs ? ' onclick="' + prevJs + '"' : ' disabled') + '>Previous</button>'
    + '<button type="button" class="btn btn-sm"' + (nextJs ? ' onclick="' + nextJs + '"' : ' disabled') + '>Next</button>'
    + '</div></div>';
}

// A label/value list. Values are HTML the caller escaped; empty shows a dash.
function listDetails(items) {
  return '<dl class="ui-details">' + items.map(([k, v]) =>
    '<div><dt>' + escHtml(k) + '</dt><dd>' + (v === '' || v === null || v === undefined ? uiDash('') : v) + '</dd></div>').join('') + '</dl>';
}

function listLink(url, text) {
  const href = safeHref(url);
  return href
    ? '<a href="' + href + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">' + escHtml(text || url) + '</a>'
    : escHtml(text || '');
}

// Any stored status as a badge: the word from STATUS, the design's tone.
function listStatusBadge(status) {
  if (!status) return uiDash('');
  const m = statusMeta(status);
  const tone = {good: 'success', bad: 'danger', waiting: 'warning', active: 'info'}[m.tone] || 'neutral';
  return uiBadge(tone, m.label);
}

function setColumnsFrom(el, key, after) {
  const keys = Array.from(el.closest('details').querySelectorAll('input:checked')).map(i => i.value);
  saveColumns(key, keys);
  after();
}

// ── Companies ──

const COMPANIES_PER_PAGE = 50;
let _companiesPage = 0;
let _companyView = {q: '', chips: {}};
const COMPANY_COLUMNS = [
  {key: 'name', header: 'Company'},
  {key: 'fit', header: 'Fit'},
  {key: 'status', header: 'Status'},
  {key: 'industry', header: 'Industry'},
  {key: 'location', header: 'Location'},
  {key: 'contacts', header: 'Contacts', align: 'right'},
  {key: 'added', header: 'Added', align: 'right'},
];
const COMPANY_DEFAULT_COLUMNS = ['name', 'fit', 'status', 'industry', 'location'];
// Register statuses, in pipeline order, for the count tabs.
const COMPANY_STATUS_ORDER = ['Ready', 'Draft waiting', 'Queued', 'Approved', 'Emailed', 'Replied',
  'Not contacted', 'Not processed yet', 'Opted out', 'Excluded'];

function companyStatusLabel(s) {
  return s === 'Not processed yet' ? 'Not processed' : String(s || '');
}

function companyStatusBadge(s, why) {
  if (!s) return uiDash('');
  const tone = ['Approved', 'Emailed', 'Replied', 'Ready'].includes(s) ? 'success'
    : s === 'Not contacted' ? 'info'
    : ['Draft waiting', 'Queued'].includes(s) ? 'warning'
    : ['Opted out', 'Excluded'].includes(s) ? 'danger' : 'neutral';
  const badgeHtml = uiBadge(tone, companyStatusLabel(s), ['Approved', 'Emailed', 'Replied'].includes(s) ? 'check' : '');
  return why ? '<span title="' + escHtml(why) + '">' + badgeHtml + '</span>' : badgeHtml;
}

// Search (name, domain) and the chips, all on the companies already loaded.
function companiesFilter(rows, {q = '', chips = {}} = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return (rows || []).filter(c => {
    if (needle && ![c.name, c.domain, c.website].join(' ').toLowerCase().includes(needle)) return false;
    if (chips.status && c.register_status !== chips.status) return false;
    if (chips.industry && (c.industry || '') !== chips.industry) return false;
    if (chips.location && (c.location || '') !== chips.location) return false;
    if (chips.fit) {
      const f = Number(c.fit);
      if (typeof c.fit !== 'number') return false;
      if (chips.fit === '50' && f < 50) return false;
      if (chips.fit === '30' && (f < 30 || f >= 50)) return false;
      if (chips.fit === '0' && f >= 30) return false;
    }
    const site = !!(c.website || c.domain);
    if (chips.website === 'yes' && !site) return false;
    if (chips.website === 'no' && site) return false;
    if (chips.contacts && !(Number(c.contact_count) > 0)) return false;
    if (chips.contacted && !['Emailed', 'Replied'].includes(c.register_status)) return false;
    return true;
  });
}

function companiesSummary(rows) {
  rows = rows || [];
  const n = (pred) => rows.filter(pred).length;
  const fits = rows.map(c => c.fit).filter(f => typeof f === 'number');
  const sources = new Set(rows.map(c => String(c.source || '').replace(/^discover:/, '')).filter(Boolean));
  const notContacted = n(c => c.register_status === 'Not contacted');
  return uiMetricStrip([
    {label: 'Companies', value: rows.length,
     sub: sources.size ? 'from ' + sources.size + ' source' + (sources.size === 1 ? '' : 's') : ''},
    {label: 'Approved for outreach', value: n(c => c.register_status === 'Approved'),
     sub: notContacted + ' not contacted'},
    {label: 'Average fit', value: fits.length ? Math.round(fits.reduce((a, b) => a + b, 0) / fits.length) : '',
     sub: 'of 100'},
    {label: 'Websites read', value: n(c => !!c.profile_checked_at),
     sub: n(c => !(c.website || c.domain)) + ' have no site'},
  ]);
}

function companyWebsite(c) {
  return c.website || (c.domain ? 'https://' + c.domain : '');
}

function companiesTableHtml(rows, visible) {
  const columns = COMPANY_COLUMNS.map(col => Object.assign({}, col, {render: {
    name: c => '<span class="ui-cell-main lists-name" title="' + escHtml(c.name) + '">' + uiDash(c.name || c.domain) + '</span><span class="ui-cell-sub lists-name">'
      + listLink(companyWebsite(c), c.domain || String(companyWebsite(c)).replace(/^https?:\/\//i, '')) + '</span>',
    fit: c => '<span title="' + escHtml((c.fit_reasons || []).join(' · ')) + '">'
      + (typeof c.fit === 'number' ? listBar(c.fit) : uiDash('')) + '</span>',
    status: c => companyStatusBadge(c.register_status, c.register_why),
    industry: c => uiDash(c.industry),
    location: c => uiDash(c.location),
    contacts: c => escHtml(String(Number(c.contact_count) || 0)),
    added: c => c.created_at ? '<span class="muted">' + relTime(c.created_at) + '</span>' : uiDash(''),
  }[col.key]}));
  columns.push({key: 'menu', header: '', align: 'right', render: c => uiRowMenu([
    {label: 'View company', js: 'openCompany(' + jsq(c.id) + ')'},
  ].concat(safeHref(companyWebsite(c))
    ? [{label: 'Open website', js: 'window.open(' + jsq(companyWebsite(c)) + ',\'_blank\',\'noopener\')'}] : []))});
  const shown = (visible || COMPANY_DEFAULT_COLUMNS).concat(['menu']);
  return uiTable({columns, rows: rows || [], visible: shown, rowKey: c => c.id,
    onRow: c => 'openCompany(' + jsq(c.id) + ')', empty: 'No companies match'});
}

// Latest value per signal (and per value, for multi-valued signals like roles).
function companyLatestSignals(obs) {
  const latest = {};
  for (const o of obs || []) {
    const key = o.signal_code + '|' + (o.value_text || o.value_num);
    if (!latest[key] && (o.value_text || (o.value_num !== null && o.value_num !== undefined))) latest[key] = o;
  }
  return Object.values(latest);
}

function companySignalsTable(obs) {
  const rows = companyLatestSignals(obs).slice(0, 40);
  return uiTable({rows, empty: 'No signals recorded for this company yet', columns: [
    {key: 'label', header: 'Signal', render: o => '<span class="ui-strong">' + uiDash(o.label || o.signal_code) + '</span>'},
    {key: 'value', header: 'What was found', render: o => '<span class="lists-wrap">'
      + uiDash(o.value_text || (o.value_num === null || o.value_num === undefined ? '' : String(o.value_num))) + '</span>'},
    {key: 'source', header: 'Source', align: 'right', render: o => safeHref(o.evidence_url)
      ? listLink(o.evidence_url, String(o.evidence_url).replace(/^https?:\/\/(www\.)?/i, '').split(/[/?#]/)[0])
      : uiDash('')},
  ]});
}

// Basic facts about one company: where it is, why it fits, what's been done,
// and what Sellbird saw on its own site.
function companyInfoCard(company, profile) {
  const c = (profile && profile.company) || company || {};
  const reg = (profile && profile.register) || {};
  const latest = companyLatestSignals(profile && profile.observations);
  const by = code => latest.filter(o => o.signal_code === code);
  const list = (items, max) => items.slice(0, max).map(o => o.evidence_url && safeHref(o.evidence_url)
    ? listLink(o.evidence_url, o.value_text || String(o.value_num))
    : escHtml(o.value_text || String(o.value_num))).join('<br>');
  const people = by('DECISION_MAKER_TITLE').length ? by('DECISION_MAKER_TITLE') : by('CONTACT_FOUND');
  const form = by('CONTACT_FORM_URL')[0];
  const status = reg.status || company.register_status || '';
  const why = reg.why_not_contacted || company.register_why || '';
  return uiCard({title: 'Details', body: listDetails([
    ['Website', listLink(companyWebsite(c), c.domain || companyWebsite(c))],
    ['Sector', escHtml(c.industry)],
    ['Area', escHtml(c.location)],
    ['Phone', escHtml(c.phone)],
    ['Why selected', escHtml(reg.why_selected || (company.fit_reasons || []).join(' · '))],
    ['Status', status ? companyStatusBadge(status) + (why ? ' <span class="lists-why">' + escHtml(why) + '</span>' : '') : ''],
    ['People named on site', list(people, 8)],
    ['Contact form', form ? listLink(form.value_text, form.value_text) : ''],
    ['Hiring', list(by('HIRING_ROLE'), 6)],
    ['Tech on website', escHtml(by('TECH_STACK').map(o => o.value_text).slice(0, 1).join(''))],
  ])});
}

function companyContactsTable(contacts) {
  // Phone and LinkedIn columns only when someone here has one.
  const has = k => (contacts || []).some(p => p[k]);
  const visible = ['name', 'email'].concat(has('phone') ? ['phone'] : [], has('linkedin_url') ? ['linkedin'] : [], ['stage', 'source']);
  return uiTable({visible, rows: contacts || [], rowKey: p => p.id, onRow: p => 'openContactById(' + jsq(p.id) + ')',
    empty: 'No contacts found at this company yet', columns: [
      {key: 'name', header: 'Contact', render: p => contactName(p)
        ? '<span class="ui-cell-main">' + escHtml(contactName(p)) + '</span><span class="ui-cell-sub">' + uiDash(p.title) + '</span>'
        : '<span class="muted">General inbox</span>'},
      {key: 'email', header: 'Email', render: p => p.email ? '<span class="ui-strong">' + escHtml(p.email) + '</span> ' + contactEmailBadge(p) : uiDash('')},
      {key: 'phone', header: 'Phone', render: p => p.phone ? escHtml(p.phone) + (p.phone_verified ? ' ' + uiBadge('success', 'Verified', 'check') : '') : uiDash('')},
      {key: 'linkedin', header: 'LinkedIn', render: p => safeHref(p.linkedin_url) ? listLink(p.linkedin_url, 'Profile') : uiDash('')},
      {key: 'stage', header: 'Stage', render: p => listStatusBadge(p.status)},
      {key: 'source', header: 'Source', align: 'right', render: p => p.source ? '<span class="muted">' + sourceLabel(p.source) + '</span>' : uiDash('')},
    ]});
}

// One company: header with its status, a strip of numbers, its signals and
// contacts, and the details Sellbird holds on it.
function companyDetailPage(company, profile, contacts) {
  company = company || {};
  const c = (profile && profile.company) || company;
  const people = contacts || [];
  const obs = (profile && profile.observations) || [];
  const codes = new Set(companyLatestSignals(obs).map(o => o.signal_code));
  const verified = people.filter(p => contactEmailStatus(p) === 'verified').length;
  const status = (profile && profile.register && profile.register.status) || company.register_status || '';
  const site = companyWebsite(c);
  const head = uiPageHead({
    title: c.name || c.domain || 'Company',
    sub: [c.domain, c.industry, c.location].filter(Boolean).join(' · '),
    crumbs: [{label: 'Companies', js: 'closeCompany()'}],
    actions: (safeHref(site) ? '<a class="btn btn-secondary btn-sm" href="' + safeHref(site)
      + '" target="_blank" rel="noopener noreferrer">Open website</a>' : '')
      + '<button class="btn btn-secondary btn-sm" onclick="downloadCsv(\'/api/export/companies.csv\', \'company-register.csv\', this)">'
      + icon('download') + 'Export register</button>',
  }).replace('</h2>', (status ? ' ' + companyStatusBadge(status) : '') + '</h2>');
  const source = String(c.source || '').replace(/^discover:/, '');
  return head
    + uiMetricStrip([
      {label: 'Fit score', value: typeof company.fit === 'number' ? company.fit : '', sub: 'of 100'},
      {label: 'Signals found', value: codes.size, sub: 'on its own site and listings'},
      {label: 'Contacts', value: people.length, sub: people.length ? verified + ' verified' : 'none found yet'},
      {label: 'First found', value: c.created_at ? relTime(c.created_at) : '', sub: source ? sourceLabel(source) : ''},
    ])
    + '<div class="ui-grid lists-detail-grid">'
    + uiCard({title: 'Signals found', action: escHtml(codes.size + ' signal' + (codes.size === 1 ? '' : 's')), body: companySignalsTable(obs)})
    + uiCard({title: 'Contacts', action: escHtml(people.length + ' found'), body: companyContactsTable(people)})
    + '<div class="ui-stack">' + companyInfoCard(company, profile)
    + uiCard({title: 'Discovered', body: listDetails([
      ['Found via', c.source_url ? listLink(c.source_url, 'search result') + (source ? ' · ' + sourceLabel(source) : '')
        : (source ? sourceLabel(source) : '')],
      ['First found', escHtml(String(c.created_at || '').slice(0, 10))],
      ['Website read', c.profile_checked_at ? relTime(c.profile_checked_at) : ''],
      ['Contacts looked for', c.prospects_checked_at ? relTime(c.prospects_checked_at) : ''],
    ])})
    + '</div></div>';
}

function showCompanyView(which) {
  const list = document.getElementById('companies-list-view');
  const detail = document.getElementById('companies-detail');
  if (list) list.hidden = which !== 'list';
  if (detail) detail.hidden = which === 'list';
}

async function loadCompanies() {
  companyDrill = false;
  showCompanyView('list');
  const el = document.getElementById('companies-list');
  const data = await api('/api/companies');
  if (!data) { el.innerHTML = offlineState(); return; }
  _companies = data;
  renderCompaniesPage(_companiesPage);
}

function companiesChips() {
  const ch = _companyView.chips;
  const counts = key => {
    const m = {};
    for (const c of _companies) if (c[key]) m[c[key]] = (m[c[key]] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 40)
      .map(([k, n]) => ({key: k, label: k, count: n, on: ch[key] === k}));
  };
  const set = (k, v) => 'setCompanyChip(' + jsq(k) + ',' + jsq(v) + ')';
  const fitLabels = {'50': '50 and up', '30': '30 to 49', '0': 'Under 30'};
  const more = [['website:yes', 'Has a website'], ['website:no', 'No website'], ['contacts:1', 'Has contacts'],
    ['contacted:1', 'Contacted']];
  const moreOn = more.filter(([k]) => { const [f, v] = k.split(':'); return String(ch[f] || '') === (v === '1' ? 'true' : v); });
  return listFilterChip({label: 'Industry', value: ch.industry || '', options: counts('industry'),
      onPick: k => set('industry', k), clearJs: set('industry', '')})
    + listFilterChip({label: 'Fit score', value: fitLabels[ch.fit] || '',
      options: Object.entries(fitLabels).map(([k, l]) => ({key: k, label: l, on: ch.fit === k})),
      onPick: k => set('fit', k), clearJs: set('fit', '')})
    + listFilterChip({label: 'Location', value: ch.location || '', options: counts('location'),
      onPick: k => set('location', k), clearJs: set('location', '')})
    + listFilterChip({label: 'More filters', value: moreOn.map(m => m[1]).join(', '),
      options: more.map(([k, l]) => ({key: k, label: l, on: moreOn.some(m => m[0] === k)})),
      onPick: k => 'toggleCompanyMore(' + jsq(k) + ')', clearJs: 'clearCompanyMore()'});
}

function setCompanyChip(key, value) {
  _companyView.chips[key] = value || '';
  _companiesPage = 0;
  renderCompaniesPage(0, true);
}

function toggleCompanyMore(k) {
  const [f, v] = k.split(':');
  const val = v === '1' ? true : v;
  _companyView.chips[f] = _companyView.chips[f] === val ? '' : val;
  _companiesPage = 0;
  renderCompaniesPage(0, true);
}

function clearCompanyMore() {
  for (const f of ['website', 'contacts', 'contacted']) _companyView.chips[f] = '';
  renderCompaniesPage(0, true);
}

function setCompanyStatusTab(key) {
  _companyView.chips.status = key === 'all' ? '' : key;
  renderCompaniesPage(0);
}

// `chips` re-renders the filter row too. The 15-second refresh leaves it alone
// while one of its menus is open.
function renderCompaniesPage(page, chips) {
  const el = document.getElementById('companies-list');
  const metricsEl = document.getElementById('companies-metrics');
  const tabsEl = document.getElementById('companies-tabs');
  const chipsEl = document.getElementById('companies-chips');
  const colsEl = document.getElementById('companies-cols');
  const toolbar = document.getElementById('companies-toolbar');
  const data = _companies;
  if (!data.length) {
    metricsEl.innerHTML = ''; tabsEl.innerHTML = '';
    if (toolbar) toolbar.hidden = true;
    el.innerHTML = emptyState(icon('companies'), 'No companies yet',
      'Confirm your <b>Signals</b>, then find businesses on the <b>Discover</b> tab. ' +
      'OpenStreetMap is free and needs no account.');
    return;
  }
  if (toolbar) toolbar.hidden = false;
  metricsEl.innerHTML = companiesSummary(data);

  // Count tabs: all, then each register status that has companies.
  const base = companiesFilter(data, {q: _companyView.q, chips: Object.assign({}, _companyView.chips, {status: ''})});
  const counts = {};
  for (const c of base) counts[c.register_status] = (counts[c.register_status] || 0) + 1;
  const known = COMPANY_STATUS_ORDER.filter(s => counts[s]).concat(Object.keys(counts).filter(s => s && !COMPANY_STATUS_ORDER.includes(s)));
  const active = _companyView.chips.status || 'all';
  tabsEl.innerHTML = listCountTabs([{key: 'all', label: 'All', count: base.length}]
    .concat(known.map(s => ({key: s, label: companyStatusLabel(s), count: counts[s]})))
    .concat(active !== 'all' && !counts[active] ? [{key: active, label: companyStatusLabel(active), count: 0}] : []),
    active, k => 'setCompanyStatusTab(' + jsq(k) + ')');

  if (chips || !chipsEl.innerHTML || !chipsEl.querySelector('details[open]')) chipsEl.innerHTML = companiesChips();
  const visible = loadColumns('companies', COMPANY_DEFAULT_COLUMNS);
  if (!colsEl.querySelector('details[open]')) {
    colsEl.innerHTML = uiColumns('companies', COMPANY_COLUMNS, visible, 'setColumnsFrom(this, \'companies\', () => renderCompaniesPage(_companiesPage))');
  }

  const rows = companiesFilter(data, _companyView);
  const pages = Math.max(1, Math.ceil(rows.length / COMPANIES_PER_PAGE));
  _companiesPage = Math.min(Math.max(0, page), pages - 1);
  const start = _companiesPage * COMPANIES_PER_PAGE;
  const end = Math.min(start + COMPANIES_PER_PAGE, rows.length);
  const filtered = rows.length !== data.length;
  const summary = rows.length
    ? (start + 1) + '–' + end + ' of ' + rows.length + (filtered ? ' matching' : ' compan' + (rows.length === 1 ? 'y' : 'ies'))
      + ' · Page ' + (_companiesPage + 1) + ' of ' + pages
    : '0 of ' + data.length + ' companies';
  el.innerHTML = companiesTableHtml(rows.slice(start, end), visible)
    + listPager(summary, _companiesPage > 0 ? 'renderCompaniesPage(' + (_companiesPage - 1) + ')' : null,
      _companiesPage < pages - 1 ? 'renderCompaniesPage(' + (_companiesPage + 1) + ')' : null);
}

function companySearch(value) {
  _companyView.q = value;
  renderCompaniesPage(0);
}

async function openCompany(id) {
  const company = _companies.find(c => c.id === id);
  if (!company) return;
  companyDrill = true;
  const el = document.getElementById('companies-detail');
  showCompanyView('detail');
  el.innerHTML = '<div class="ui-empty"><div class="ui-empty__desc">Loading…</div></div>';
  window.scrollTo(0, 0);
  const [data, profile] = await Promise.all([
    api('/api/companies/' + encodeURIComponent(company.id) + '/contacts'),
    api('/api/companies/' + encodeURIComponent(company.id) + '/profile'),
  ]);
  if (!companyDrill) return;   // went back meanwhile
  el.innerHTML = companyDetailPage(company, profile, data || []);
}

// Kept for anything that still opens a company by its row number.
function showCompanyContacts(index) {
  const company = _companies[index];
  if (company) openCompany(company.id);
}

// From a contact: its company, loading the list first if needed.
async function openCompanyById(id) {
  goTab('companies');
  if (!_companies.length || !_companies.some(c => c.id === id)) {
    const data = await api('/api/companies');
    if (data) _companies = data;
  }
  openCompany(id);
}

function closeCompany() {
  loadCompanies();
  window.scrollTo(0, 0);
}

async function submitFeedback(entityType, entityId, promptText) {
  const comment = prompt(promptText || 'Add your feedback:');
  if (!comment) return;
  const data = await api('/api/feedback', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({entity_type: entityType, entity_id: entityId, comment: comment})
  });
  if (data && data.success) showToast(entityType === 'campaign'
    ? 'Saved. Sellbird follows it in the emails it writes from now on.'
    : 'Saved. Sellbird uses it if it writes this person\'s first email (Gmail, SMTP or Microsoft 365).', 'success');
  else showToast((data && data.message) || 'Could not save feedback.', 'error');
}

function fbProspect(i) {
  const p = _prospects[i];
  if (p) submitFeedback('contact', p.id, 'Anything Sellbird should know before writing to this person?');
}

function fbCampaign(i) {
  const c = _campaigns[i];
  if (c) submitFeedback('campaign', c.id, 'What should Sellbird do differently in the emails it writes next? (e.g. "shorter; don\'t mention reviews")');
}

// Search and status filter live outside the table, so the 15-second refresh
// re-renders rows without losing what you typed.
let _contactQuery = '', _contactFilter = 'all';
let _contactEmail = '', _contactCompany = '', _contactsPage = 0;
let _contactOpen = null, _contactExtras = {outbox: null};
const CONTACTS_PER_PAGE = 50;
const CONTACT_FILTERS = [
  ['all', 'All', null],
  ['todo', 'To write', ['new', 'queued']],
  ['contacted', 'Contacted', ['contacted']],
  ['replied', 'Replied', ['replied', 'interested', 'meeting']],
  ['closed', 'Closed out', null],
];
const CONTACT_COLUMNS = [
  {key: 'name', header: 'Name'},
  {key: 'email', header: 'Email'},
  {key: 'email_status', header: 'Email status'},
  {key: 'company', header: 'Company'},
  {key: 'stage', header: 'Stage'},
  {key: 'score', header: 'Score'},
  {key: 'phone', header: 'Phone'},
  {key: 'source', header: 'Source'},
  {key: 'added', header: 'Added', align: 'right'},
];
const CONTACT_DEFAULT_COLUMNS = ['name', 'email', 'email_status', 'company', 'stage', 'score'];

function contactName(p) {
  return [p.first_name, p.last_name].filter(Boolean).join(' ');
}

// Rows predating email_status fall back to the old verified flag.
function contactEmailStatus(p) {
  if (!p || !p.email) return '';
  return p.email_status || (p.email_verified ? 'verified' : 'guess');
}

function contactEmailBadge(p) {
  const s = contactEmailStatus(p);
  if (!s || !own(STATUS, s)) return '';
  const tone = {verified: 'success', risky: 'warning', invalid: 'danger'}[s] || 'neutral';
  const iconName = {verified: 'check', invalid: 'close'}[s] || '';
  return '<span title="Email ' + escHtml(statusMeta(s).label.toLowerCase()) + '">'
    + uiBadge(tone, statusMeta(s).label, iconName) + '</span>';
}

function contactMatches(p, f) {
  const known = ['new', 'queued', 'contacted', 'replied', 'interested', 'meeting'];
  if (f === 'all') return true;
  if (f === 'closed') return !known.includes(p.status);
  const hit = CONTACT_FILTERS.find(x => x[0] === f);
  return !!(hit && hit[2] && hit[2].includes(p.status));
}

// Search (name, company, email, title), the stage tab, and the two chips.
function contactsFilter(rows, {q = '', status = 'all', emailStatus = '', company = ''} = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return (rows || []).filter(p =>
    (!needle || [p.first_name, p.last_name, p.company, p.email, p.title].join(' ').toLowerCase().includes(needle))
    && contactMatches(p, status || 'all')
    && (!emailStatus || contactEmailStatus(p) === emailStatus)
    && (!company || (p.company || '') === company));
}

function contactsSummary(rows) {
  rows = rows || [];
  const n = s => rows.filter(p => contactEmailStatus(p) === s).length;
  const companies = new Set(rows.map(p => p.company_id || p.company).filter(Boolean)).size;
  return uiMetricStrip([
    {label: 'Contacts', value: rows.length, sub: (rows.length >= 200 ? 'latest 200 · ' : '')
      + 'across ' + companies + ' compan' + (companies === 1 ? 'y' : 'ies')},
    {label: 'Verified', value: n('verified'), sub: 'safe to send'},
    {label: 'Catch-all', value: n('risky'), sub: 'domain accepts any address'},
    {label: 'Invalid', value: n('invalid'), sub: 'never sent'},
  ]);
}

function contactsTableHtml(rows, visible) {
  const columns = CONTACT_COLUMNS.map(col => Object.assign({}, col, {render: {
    name: p => '<span class="lists-person"><span class="lists-avatar">' + initials(p.first_name, p.last_name) + '</span>'
      + (contactName(p)
        ? '<span><span class="ui-cell-main lists-name">' + escHtml(contactName(p)) + '</span>'
          + (p.title ? '<span class="ui-cell-sub lists-name">' + escHtml(p.title) + '</span>' : '') + '</span>'
        : '<span class="muted">General inbox</span>') + '</span>',
    email: p => p.email ? '<span class="lists-email">' + escHtml(p.email) + '</span>' : uiDash(''),
    email_status: p => contactEmailBadge(p) || uiDash(''),
    company: p => p.company ? '<span class="lists-name" title="' + escHtml(p.company) + '">' + escHtml(p.company) + '</span>' : uiDash(''),
    stage: p => ['new', 'queued'].includes(p.status) ? uiBadge('neutral', statusMeta(p.status).label) : listStatusBadge(p.status),
    score: p => (p.score || p.score === 0) ? listBar(p.score, 'brand') : uiDash(''),
    phone: p => p.phone ? escHtml(p.phone) + (p.phone_verified ? ' <span class="verified" title="Phone verified">&#10003;</span>' : '') : uiDash(''),
    source: p => p.source ? '<span class="muted">' + sourceLabel(p.source) + '</span>' : uiDash(''),
    added: p => p.created_at ? '<span class="muted">' + relTime(p.created_at) + '</span>' : uiDash(''),
  }[col.key]}));
  columns.push({key: 'menu', header: '', align: 'right', render: p => uiRowMenu([
    {label: 'Open contact', js: 'openContactById(' + jsq(p.id) + ')'},
    {label: 'Leave feedback', js: 'fbProspectById(' + jsq(p.id) + ')'},
  ].concat(p.status === 'opted_out' || p.opt_out_undone
    ? [{label: p.status === 'opted_out' ? 'Why they opted out' : 'Opt-out history', js: 'openContact(' + jsq(p.id) + ', true)'}]
    : []))});
  // The email status column has no header, as in the design.
  const cols = columns.map(c => c.key === 'email_status' ? Object.assign({}, c, {header: ''}) : c);
  return uiTable({columns: cols, rows: rows || [], rowKey: p => p.id, visible: (visible || CONTACT_DEFAULT_COLUMNS).concat(['menu']),
    onRow: p => 'openContactById(' + jsq(p.id) + ')', empty: 'No contacts match'});
}

// One contact: who they are, the emails to them, their company, and (when
// they opted out, or you undid it) the opt-out record with its undo.
function contactDetailPage(p, extras) {
  extras = extras || {};
  const index = Number(extras.index);
  const emails = extras.outbox || [];
  const name = contactName(p);
  const optable = p.status === 'opted_out' || p.opt_out_undone || _optOut.id === p.id;
  const head = uiPageHead({
    title: name || p.email || 'Contact',
    sub: (p.title ? p.title + ' · ' : (name ? '' : 'Shared inbox · ')) + (p.company || ''),
    crumbs: [{label: 'Contacts', js: 'closeContact()'}],
    actions: (optable ? '<button class="btn btn-secondary btn-sm" onclick="toggleOptOut(' + index + ')" aria-expanded="'
        + (_optOut.id === p.id) + '" title="What made Sellbird stop emailing them">'
        + (p.status === 'opted_out' ? 'Why they opted out' : 'Opt-out history') + '</button>' : '')
      + '<button class="btn btn-secondary btn-sm" onclick="fbProspect(' + index + ')" title="Leave feedback on this contact">Leave feedback</button>',
  }).replace('</h2>', (contactEmailBadge(p) ? ' ' + contactEmailBadge(p) : '') + '</h2>');
  const emailsTable = extras.outbox === null
    ? '<div class="ui-empty"><div class="ui-empty__desc">Loading…</div></div>'
    : uiTable({rows: emails, empty: 'No emails to this contact in the Outbox', columns: [
      {key: 'status', header: 'Status', render: o => listStatusBadge(o.status)},
      {key: 'step', header: 'Step', render: o => o.kind === 'reply' ? 'Reply' : 'Email ' + escHtml(String(Number(o.step) || 1))},
      {key: 'subject', header: 'Subject', render: o => '<span class="ui-strong lists-subject">' + uiDash(o.subject) + '</span>'},
      {key: 'when', header: 'When', align: 'right', render: o => (o.sent_at || o.send_at)
        ? '<span class="muted">' + (o.sent_at ? 'Sent ' : '') + relTime(o.sent_at || o.send_at) + '</span>' : uiDash('')},
    ]});
  const sourceLink = safeHref(p.source_url) ? ' · ' + listLink(p.source_url, 'where') : '';
  return head
    + uiMetricStrip([
      {label: 'Stage', value: p.status ? statusMeta(p.status).label : '', sub: p.status === 'new' ? 'no email written yet' : ''},
      {label: 'Emails', value: extras.outbox === null ? '' : emails.length, sub: 'in the Outbox'},
      {label: 'Score', value: (p.score || p.score === 0) ? p.score : '', sub: 'of 100'},
      {label: 'Found', value: p.created_at ? relTime(p.created_at) : '', sub: p.source ? sourceLabel(p.source) : ''},
    ])
    + (_optOut.id === p.id ? uiCard({title: 'Opt-out', body: optOutPanel(p)}) : '')
    + '<div class="ui-grid lists-detail-grid">'
    + uiCard({title: 'Emails to this contact', action: '<a href="#" onclick="goTab(\'outbox\');return false">Open Outbox</a>', body: emailsTable})
    + '<div class="ui-stack">'
    + uiCard({title: 'Details', body: listDetails([
      ['Email', p.email ? '<span class="lists-email">' + escHtml(p.email) + '</span>' : ''],
      ['Email status', contactEmailBadge(p)],
      ['Title', escHtml(p.title || (name ? '' : 'General inbox'))],
      ['Phone', p.phone ? escHtml(p.phone) + (p.phone_verified ? ' ' + uiBadge('success', 'Verified', 'check') : '') : ''],
      ['LinkedIn', safeHref(p.linkedin_url) ? listLink(p.linkedin_url, 'Profile') : ''],
      ['Source', p.source ? sourceLabel(p.source) + sourceLink : ''],
      ['Seniority', escHtml(p.seniority)],
      ['Added', escHtml(String(p.created_at || '').slice(0, 10))],
    ])})
    + uiCard({title: 'Company', action: p.company_id
        ? '<a href="#" onclick="openCompanyById(' + jsq(p.company_id) + ');return false">Open</a>' : '',
      body: listDetails([
        ['Company', escHtml(p.company)],
        ['Industry', escHtml(p.industry)],
        ['Size', escHtml(p.company_size)],
      ])})
    + '</div></div>';
}

function showContactView(which) {
  const list = document.getElementById('prospects-list-view');
  const detail = document.getElementById('prospects-detail');
  if (list) list.hidden = which !== 'list';
  if (detail) detail.hidden = which === 'list';
}

async function loadProspects() {
  const el = document.getElementById('prospects-table');
  const data = await api('/api/prospects');
  if (!data) { el.innerHTML = offlineState(); showContactView('list'); return; }
  _prospects = data;
  const search = document.getElementById('contact-search');
  // A rebuild after an offline blip must show the search still applied.
  if (search && search.value !== _contactQuery) search.value = _contactQuery;
  renderContacts();
}

function setContactFilter(f) { _contactFilter = f; _contactsPage = 0; renderContacts(); }
function setContactChip(kind, v) {
  if (kind === 'email') _contactEmail = v; else _contactCompany = v;
  _contactsPage = 0;
  renderContacts(true);
}
function contactSearch(v) { _contactQuery = v; _contactsPage = 0; renderContacts(); }
function contactsPage(n) { _contactsPage = n; renderContacts(); window.scrollTo(0, 0); }

function contactsChips() {
  const emailOpts = ['verified', 'risky', 'guess', 'invalid'].map(s => ({key: s, label: statusMeta(s).label,
    count: _prospects.filter(p => contactEmailStatus(p) === s).length, on: _contactEmail === s}));
  const m = {};
  for (const p of _prospects) if (p.company) m[p.company] = (m[p.company] || 0) + 1;
  const companyOpts = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 40)
    .map(([k, n]) => ({key: k, label: k, count: n, on: _contactCompany === k}));
  return listFilterChip({label: 'Email status', value: _contactEmail ? statusMeta(_contactEmail).label : '',
      options: emailOpts, onPick: k => 'setContactChip(\'email\',' + jsq(k) + ')', clearJs: 'setContactChip(\'email\',\'\')'})
    + listFilterChip({label: 'Company', value: _contactCompany, options: companyOpts,
      onPick: k => 'setContactChip(\'company\',' + jsq(k) + ')', clearJs: 'setContactChip(\'company\',\'\')'});
}

// `chips` re-renders the filter row too; the refresh leaves an open menu alone.
function renderContacts(chips) {
  const rowsEl = document.getElementById('prospects-table');
  const detailEl = document.getElementById('prospects-detail');
  if (!rowsEl) return;
  if (_contactOpen) {
    const i = _prospects.findIndex(p => p.id === _contactOpen);
    if (i >= 0) {
      showContactView('detail');
      detailEl.innerHTML = contactDetailPage(_prospects[i], Object.assign({index: i}, _contactExtras));
      return;
    }
    _contactOpen = null;
  }
  showContactView('list');
  const metricsEl = document.getElementById('prospects-metrics');
  const tabsEl = document.getElementById('contact-filters');
  const chipsEl = document.getElementById('contact-chips');
  const colsEl = document.getElementById('contact-cols');
  const toolbar = document.getElementById('prospects-toolbar');
  if (!_prospects.length) {
    metricsEl.innerHTML = ''; tabsEl.innerHTML = '';
    if (toolbar) toolbar.hidden = true;
    rowsEl.innerHTML = emptyState(icon('contacts'), 'No contacts yet',
      'Sellbird hasn\'t found any prospects. Once it\'s running, the Scout agent searches the web for people matching your ideal customer profile in <b>sellbird.yaml</b>.');
    return;
  }
  if (toolbar) toolbar.hidden = false;
  metricsEl.innerHTML = contactsSummary(_prospects);
  const view = {q: _contactQuery, emailStatus: _contactEmail, company: _contactCompany};
  tabsEl.innerHTML = listCountTabs(CONTACT_FILTERS.map(f => ({key: f[0], label: f[1],
    count: contactsFilter(_prospects, Object.assign({}, view, {status: f[0]})).length})),
    _contactFilter, k => 'setContactFilter(' + jsq(k) + ')');
  if (chips || !chipsEl.innerHTML || !chipsEl.querySelector('details[open]')) chipsEl.innerHTML = contactsChips();
  const visible = loadColumns('contacts', CONTACT_DEFAULT_COLUMNS);
  if (!colsEl.querySelector('details[open]')) {
    colsEl.innerHTML = uiColumns('contacts', CONTACT_COLUMNS, visible, 'setColumnsFrom(this, \'contacts\', () => renderContacts())');
  }
  const rows = contactsFilter(_prospects, Object.assign({}, view, {status: _contactFilter}));
  const pages = Math.max(1, Math.ceil(rows.length / CONTACTS_PER_PAGE));
  _contactsPage = Math.min(Math.max(0, _contactsPage), pages - 1);
  const start = _contactsPage * CONTACTS_PER_PAGE;
  const end = Math.min(start + CONTACTS_PER_PAGE, rows.length);
  const summary = (rows.length > CONTACTS_PER_PAGE ? (start + 1) + '–' + end : rows.length) + ' of '
    + _prospects.length + ' contacts' + (pages > 1 ? ' · Page ' + (_contactsPage + 1) + ' of ' + pages : '');
  rowsEl.innerHTML = contactsTableHtml(rows.slice(start, end), visible)
    + listPager(summary, _contactsPage > 0 ? 'contactsPage(' + (_contactsPage - 1) + ')' : null,
      _contactsPage < pages - 1 ? 'contactsPage(' + (_contactsPage + 1) + ')' : null);
}

// The emails the Outbox holds for one person, from all of its lists.
function outboxItemsFor(ob, id) {
  return ['pending', 'approved', 'sent', 'failed'].flatMap(k => (ob && ob[k]) || [])
    .filter(o => o.prospect_id === id)
    .sort((a, b) => (Number(a.step) || 0) - (Number(b.step) || 0));
}

async function openContact(id, withOptOut) {
  const i = _prospects.findIndex(p => p.id === id);
  if (i < 0) return;
  if (_contactOpen !== id) {
    _contactOpen = id;
    _contactExtras = {outbox: null};
    window.scrollTo(0, 0);
  }
  renderContacts();
  if (withOptOut && _optOut.id !== id) toggleOptOut(i);
  const ob = await api('/api/outbox');
  if (_contactOpen !== id) return;
  _contactExtras = {outbox: ob && !ob.error ? outboxItemsFor(ob, id) : []};
  renderContacts();
}

// From anywhere (a company's contacts, a row menu): open one contact.
async function openContactById(id) {
  if (currentTab !== 'prospects') goTab('prospects');
  if (!_prospects.some(p => p.id === id)) {
    const data = await api('/api/prospects');
    if (data) _prospects = data;
  }
  openContact(id);
}

function closeContact() {
  _contactOpen = null;
  renderContacts(true);
  window.scrollTo(0, 0);
}

function fbProspectById(id) {
  const i = _prospects.findIndex(p => p.id === id);
  if (i >= 0) fbProspect(i);
}

// Why someone is opted out, and undoing it. Sellbird never moves anyone off
// "opted out" on its own, so a mistaken one (a bare "stop" that meant
// something else) needs you: see what triggered it, then undo it here.
let _optOut = {id: null, data: null, armed: false, busy: false};
const OPT_OUT_RULES = {
  phrase: 'Matched an opt-out phrase',
  no_thanks: 'Matched “no thanks”',
  only_words: 'Their reply was only an opt-out word',
  model: 'The model’s judgement (no phrase matched)',
};

async function toggleOptOut(i) {
  const p = _prospects[i];
  if (!p) return;
  if (_contactOpen !== p.id) { openContact(p.id, true); return; }
  if (_optOut.id === p.id) { _optOut = {id: null, data: null, armed: false, busy: false}; renderContacts(); return; }
  _optOut = {id: p.id, data: null, armed: false, busy: false};
  renderContacts();
  const data = await api('/api/prospects/' + encodeURIComponent(p.id) + '/opt-out');
  if (_optOut.id !== p.id) return;   // closed or switched meanwhile
  _optOut.data = data || {error: true};
  renderContacts();
}

function optOutPanel(p) {
  const d = _optOut.data;
  const name = escHtml([p.first_name, p.last_name].filter(Boolean).join(' ') || p.email);
  if (!d) return '<div class="optout-panel muted">Loading…</div>';
  if (d.error) return '<div class="optout-panel muted">Couldn’t load the opt-out record. Try again.</div>';
  let html = '<div class="optout-panel"><h4>' + (d.opted_out ? 'Why Sellbird stopped emailing ' : 'Opt-out history for ') +
    name + '</h4>';
  if (d.recorded) {
    html += '<p>' + escHtml(d.why) + '</p><div class="optout-meta">' +
      escHtml(own(OPT_OUT_RULES, d.rule) || d.rule || '') + (d.at ? ' · ' + relTime(d.at) : '') + '</div>';
  } else if (d.opted_out || (d.history || []).length) {
    html += '<p>They opted out before Sellbird kept a record of why.' +
      (d.message ? ' The last thing they wrote:' : ' There’s no reply from them on file.') + '</p>';
  }
  if (d.message) {
    html += '<div class="thread-msg received"><div class="sender">' + escHtml(p.first_name || 'They') +
      (d.at ? ' &middot; ' + relTime(d.at) : '') + '</div>' + escHtml(d.message) + '</div>';
  }
  const undone = (d.history || []).filter(h => h.action === 'opt_out_undone');
  if (undone.length) {
    html += '<div class="optout-meta">' + undone.map(h => 'You undid an opt-out ' + relTime(h.at)).join(' · ') + '</div>';
  }
  if (!d.opted_out) {
    html += '<div class="convo-actions"><span class="muted">Not opted out now (' +
      escHtml(statusMeta(d.status).label) + ').</span></div>';
  } else if (_optOut.armed) {
    html += '<div class="convo-actions"><span class="muted">Sellbird will treat them as having replied. Nothing is ' +
      'sent automatically, emails the opt-out cancelled stay cancelled, and Sellbird’s answer to their next ' +
      'reply waits for your approval, even on autopilot. Only undo it if they didn’t mean to opt out.</span>' +
      '<button class="btn btn-primary btn-sm" onclick="undoOptOut()"' + (_optOut.busy ? ' disabled' : '') +
        '>Confirm undo</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="_optOut.armed=false;renderContacts()">Cancel</button></div>';
  } else {
    html += '<div class="convo-actions"><button class="btn btn-secondary btn-sm" ' +
      'onclick="_optOut.armed=true;renderContacts()">Undo opt-out</button></div>';
  }
  return html + '</div>';
}

async function undoOptOut() {
  const id = _optOut.id;
  if (!id || _optOut.busy) return;
  _optOut.busy = true;
  renderContacts();
  const res = await api('/api/prospects/' + encodeURIComponent(id) + '/opt-out/undo', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({confirm: true}),
  });
  if (res && res.success) showToast('Opt-out undone. They’re marked as replied; Sellbird sends nothing on its own.', 'success');
  else showToast(failMsg(res, 'Could not undo the opt-out. Try again.'), 'error');
  if (_optOut.id !== id) return;
  _optOut.armed = false;
  _optOut.busy = false;
  _optOut.data = await api('/api/prospects/' + encodeURIComponent(id) + '/opt-out') || {error: true};
  loadProspects();
}

// From a conversation: the contact, with the opt-out record open.
async function showOptOut(prospectId, email) {
  goTab('prospects');
  _contactQuery = email || '';
  const search = document.getElementById('contact-search');
  if (search) search.value = _contactQuery;
  await loadProspects();
  const i = _prospects.findIndex(p => p.id === prospectId);
  if (i >= 0 && _optOut.id !== prospectId) toggleOptOut(i);
}

// Opens a filled-in compose window in whatever Gmail account the browser is
// logged into. Nothing is sent from here — the user reads it and presses Send.
// Same values as the Sender's _render, so a hand-sent email reads the same.
function fillMergeVars(text, r) {
  const inbox = r.source === 'company_inbox';
  const vals = {
    first_name: r.first_name || (inbox ? 'there' : ''), last_name: r.last_name || '',
    company: r.company || '', title: r.title || '',
    personalization: r.personalization_notes || '',
  };
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
    k = k.toLowerCase();
    return Object.prototype.hasOwnProperty.call(vals, k) ? vals[k] : m;
  });
}

let _gmailBusy = false;  // one compose window per click, never two

async function openInGmail(ci, si, ri) {
  if (_gmailBusy) return;
  const c = _campaigns[ci];
  const step = c && (c.sequence || [])[si];
  const r = c && (c.recipients || [])[ri];
  if (!step || !r) return;
  // Cold email carries the postal address and opt-out line, sent by hand too.
  const filled = fillMergeVars(step.body, r).trimEnd();
  const body = filled + (c.footer && !filled.endsWith(c.footer) ? '\n\n' + c.footer : '');
  // authuser picks the Google account Sellbird sends as, not just whichever
  // one the browser happens to be signed into.
  const url = 'https://mail.google.com/mail/?view=cm&fs=1' +
    (c.send_as ? '&authuser=' + encodeURIComponent(c.send_as) : '') +
    '&to=' + encodeURIComponent(r.email) +
    '&su=' + encodeURIComponent(fillMergeVars(step.subject, r)) +
    '&body=' + encodeURIComponent(body);
  const left = /\{\{\s*\w+\s*\}\}/.test(fillMergeVars(step.subject, r) + fillMergeVars(step.body, r));
  // No 'noopener' feature string: with it window.open always returns null,
  // so a blocked pop-up could not be told apart from a successful one. The
  // tab opens blank right away (inside the click, so it isn't blocked) and
  // only gets the draft once the send is recorded.
  const w = window.open('', '_blank');
  if (!w) {
    showToast('Your browser blocked the Gmail tab. Allow pop-ups for this page and click again.', 'error');
    return;
  }
  w.opener = null;
  // Record the send BEFORE the user can press Send in Gmail, so Sellbird can
  // never email them as well — not even if they forget to tick the box.
  _gmailBusy = true;
  let claimed = r.sent_by_hand;
  try { if (!claimed) claimed = await markSent(ci, ri, true); } finally { _gmailBusy = false; }
  if (!claimed) { w.close(); return; }
  w.location.href = url;
  if (left) showToast('This draft still has a {{placeholder}} in it. Fix it in Gmail before sending.', 'error');
}

async function markSent(ci, ri, sent) {
  const r = (_campaigns[ci] && _campaigns[ci].recipients || [])[ri];
  if (!r) return;
  let res = null;
  try {
    const resp = await authFetch('/api/prospects/' + encodeURIComponent(r.id) + '/sent', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sent}),
    });
    if (await lockIfRefused(resp)) return;
    res = await resp.json();
  } catch {}
  const ok = !!(res && res.success);
  if (!ok) showToast((res && res.message) || 'Could not save that. Try again.', 'error');
  else if (!sent && res.sent) showToast('They already replied, so this stays marked as sent.');
  else showToast(sent ? 'Marked as sent by you.' : 'Unmarked.', 'success');
  loadCampaigns();
  // True only when this call changed it: a status means they replied or
  // opted out, 'already' means another click or tab got there first.
  return ok && sent === !!res.sent && !res.status && !res.already;
}

// Where a campaign's people stand, as one stacked bar.
function campaignProgress(c) {
  const rs = c.recipients || [];
  if (!rs.length) return '';
  const count = st => rs.filter(r => st.includes(r.status)).length;
  const parts = [
    ['Contacted', count(['contacted']), 'c-accent'],
    ['Replied', count(['replied']), 'c-active'],
    ['Interested', count(['interested', 'meeting']), 'c-good'],
    ['Waiting', count(['new', 'queued']), 'c-accent-soft'],
  ];
  const closed = rs.length - parts.reduce((x, p) => x + p[1], 0);
  if (closed > 0) parts.push(['Closed out', closed, 'c-idle']);
  return '<div class="campaign-progress"><div class="bar" role="img" aria-label="Where this campaign\'s people stand">' +
    parts.filter(p => p[1]).map(p => '<span class="' + p[2] + '" style="width:' + (100 * p[1] / rs.length) +
      '%" title="' + p[0] + ': ' + p[1] + '"></span>').join('') + '</div>' +
    '<div class="campaign-legend">' + parts.filter(p => p[1]).map(p =>
      '<span><i class="' + p[2] + '"></i>' + p[0] + ' <b>' + p[1] + '</b></span>').join('') + '</div></div>';
}

async function loadCampaigns() {
  const el = document.getElementById('campaigns-list');
  const data = await api('/api/campaigns');
  if (!data) { el.innerHTML = offlineState(); return; }
  _campaigns = data;
  // The 15-second refresh must not close a row menu someone is using.
  if (el.querySelector('details.ui-menu[open]')) return;
  renderCampaigns();
}

// ── Campaigns: a list, and one page per campaign ──

let _cpOpen = null;       // id of the campaign whose page is open
let _cpFilter = 'all';
let _cpOffset = 0;
const CP_PAGE = 25;

// A status word as a kit badge, toned from the shared STATUS vocabulary.
function cpBadge(status) {
  const m = statusMeta(status);
  const tone = {good: 'success', active: 'info', waiting: 'warning', bad: 'danger'}[m.tone] || 'neutral';
  return uiBadge(tone, m.label, m.tone === 'good' ? 'check' : '');
}

// Where a campaign's people stand, counted from their statuses.
function campaignStats(c) {
  const rs = (c && c.recipients) || [];
  const count = st => rs.filter(r => st.includes(r.status)).length;
  const companies = new Set(rs.map(r => r.company).filter(Boolean));
  return {
    prospects: ((c && c.prospect_ids) || []).length, recipients: rs.length, companies: companies.size,
    waiting: count(['new', 'queued']), contacted: count(['contacted']),
    replied: count(['replied', 'interested', 'meeting', 'accepted_offer']),
    interested: count(['interested', 'meeting', 'accepted_offer']),
  };
}

// "day 0, +3, +4": when each email goes out, after the one before.
function campaignCadence(seq) {
  return (seq || []).map((s, i) => i === 0 ? 'day ' + (Number(s.delay_days) || 0) : '+' + (Number(s.delay_days) || 0)).join(', ');
}

function cpFilterKey(status) {
  return status === 'completed' ? 'finished' : (status || 'draft');
}

function campaignCountTabs(campaigns, active) {
  const rows = campaigns || [];
  const n = k => rows.filter(c => cpFilterKey(c.status) === k).length;
  const items = [{key: 'all', label: 'All', count: rows.length}, {key: 'active', label: 'Active', count: n('active')}];
  if (n('draft')) items.push({key: 'draft', label: 'Draft', count: n('draft')});
  items.push({key: 'paused', label: 'Paused', count: n('paused')}, {key: 'finished', label: 'Finished', count: n('finished')});
  return '<div class="cp-counts" role="tablist">' + items.map(t =>
    '<button type="button" class="cp-count" role="tab" aria-selected="' + (t.key === active) + '" onclick="setCampaignFilter('
    + jsq(t.key) + ')">' + escHtml(t.label) + '<span class="cp-count__n">' + escHtml(t.count) + '</span></button>').join('') + '</div>';
}

// rows carry their index into _campaigns as `_i`, so filtering keeps handlers right.
function campaignsTable(campaigns) {
  const rows = (campaigns || []).map((c, i) => Object.assign({_i: i}, c));
  return uiTable({
    columns: [
      {key: 'name', header: 'Campaign', render: c => {
        const st = campaignStats(c);
        const firstCo = ((c.recipients || []).find(r => r.company) || {}).company;
        const sub = st.companies > 1 ? firstCo + ' and ' + (st.companies - 1) + ' more' : (firstCo || 'No contacts yet');
        return '<span class="ui-cell-main">' + escHtml(c.name || 'Untitled campaign') + '</span>'
          + '<span class="ui-cell-sub">' + escHtml(sub) + '</span>';
      }},
      {key: 'status', header: '', render: c => cpBadge(c.status)},
      {key: 'prospects', header: 'Prospects', align: 'right', render: c => '<span class="ui-strong">' + campaignStats(c).prospects + '</span>'},
      {key: 'sequence', header: 'Sequence', render: c => {
        const n = (c.sequence || []).length;
        return n ? escHtml(n + (n === 1 ? ' email' : ' emails') + ' · ' + campaignCadence(c.sequence)) : uiDash('');
      }},
      {key: 'progress', header: 'Waiting / Contacted / Replied', render: c => {
        const st = campaignStats(c);
        return '<span class="cp-nums">' + st.waiting + ' / ' + st.contacted + ' / ' + st.replied + '</span>';
      }},
      {key: 'created', header: 'Created', align: 'right', render: c => '<span class="cp-muted">' + (relTime(c.created_at) || uiDash('')) + '</span>'},
      {key: 'menu', header: '', align: 'right', render: c => uiRowMenu([
        {label: 'Open campaign', js: 'openCampaign(' + c._i + ')'},
        {label: 'Feedback on its emails', js: 'fbCampaign(' + c._i + ')'}])},
    ],
    rows, rowKey: c => c.id || String(c._i), onRow: c => 'openCampaign(' + c._i + ')',
    empty: 'No campaigns in this view',
  });
}

// The hand-send controls for one person on one step, exactly as before:
// only offered when Sellbird can't send itself and they can still be emailed.
function campaignRecipientActions(c, ci, r, ri, s) {
  if (r.sent_by_hand) {
    const tick = '<label class="cp-check"><input type="checkbox" checked onchange="markSent(' + ci + ',' + ri + ',this.checked)"> '
      + '&#10003; Sent by you</label>';
    if (s === 0) return tick;
    // Follow-ups are the user's too: Sellbird never emails someone they emailed.
    return '<button class="btn btn-secondary btn-sm" onclick="openInGmail(' + ci + ',' + s + ',' + ri + ')">Open in Gmail</button>'
      + '<span class="cp-muted">Sellbird won\'t send follow-ups to people you emailed yourself.</span>';
  }
  if (s !== 0) return '';
  if (!r.can_send_by_hand) {
    // Sellbird sends here; this only records an email the user already sent.
    return r.can_mark_sent
      ? '<label class="cp-check cp-muted"><input type="checkbox" onchange="markSent(' + ci + ',' + ri + ',this.checked)"> '
        + 'I already emailed ' + escHtml(r.email) + ' myself</label>'
      : '';
  }
  const risky = r.email_status === 'risky' ? uiBadge('warning', 'Catch-all, may bounce') : '';
  return risky + '<button class="btn btn-secondary btn-sm" onclick="openInGmail(' + ci + ',' + s + ',' + ri + ')">Open in Gmail</button>'
    + '<label class="cp-check"><input type="checkbox" onchange="markSent(' + ci + ',' + ri + ',this.checked)"> Mark as sent</label>';
}

function campaignDetailPage(c, ci) {
  const st = campaignStats(c);
  const seq = c.sequence || [], rs = c.recipients || [];
  const sample = rs[0];
  const n = (k, one, many) => k + ' ' + (k === 1 ? one : many);
  const head = uiPageHead({
    title: c.name || 'Untitled campaign',
    sub: [n(st.prospects, 'prospect', 'prospects'), n(seq.length, 'email', 'emails'),
          c.created_at ? 'Created ' + relTime(c.created_at) : ''].filter(Boolean).join(' · '),
    crumbs: [{label: 'Campaigns', js: 'closeCampaign()'}],
    actions: '<button class="btn btn-secondary" onclick="fbCampaign(' + ci + ')">Feedback</button>',
  }).replace('</h2>', ' ' + cpBadge(c.status) + '</h2>');
  const strip = uiMetricStrip([
    {label: 'Prospects', value: String(st.prospects), sub: n(st.companies, 'company', 'companies')},
    {label: 'Emails in sequence', value: String(seq.length), sub: seq.length ? campaignCadence(seq) : 'none written'},
    {label: 'Waiting', value: String(st.waiting), sub: 'not contacted yet'},
    {label: 'Contacted', value: String(st.contacted), sub: 'no reply yet'},
    {label: 'Replied', value: String(st.replied), sub: st.interested ? st.interested + ' interested' : 'no replies yet'},
  ]);
  const steps = seq.length ? seq.map((step, s) => {
    const fill = t => sample ? fillMergeVars(t, sample) : String(t || '');
    const followUps = s > 0 ? rs.map((r, ri) => {
      const a = campaignRecipientActions(c, ci, r, ri, s);
      return a ? '<div class="rcpt"><span class="rcpt-who">' + escHtml(r.email) + '</span>' + a + '</div>' : '';
    }).join('') : '';
    return '<div class="cp-step"><span class="cp-step__n">' + escHtml(String(step.step || s + 1)) + '</span><div class="cp-step__main">'
      + '<div class="cp-step__top"><span class="ui-strong">' + (s === 0 ? 'First email' : 'Follow-up ' + s) + '</span>'
      + '<span class="cp-muted">' + (s === 0 ? 'Sends first' : (step.delay_days ? escHtml(String(step.delay_days)) + ' days after the last' : 'After the last')) + '</span></div>'
      + '<div class="cp-step__subject">Subject: <b>' + escHtml(fill(step.subject)) + '</b></div>'
      + '<div class="cp-step__body">' + escHtml(fill(step.body)) + '</div>'
      + (followUps ? '<div class="step-actions">' + followUps + '</div>' : '')
      + '</div></div>';
  }).join('') : uiEmpty('No email steps in this campaign');
  const seqCard = uiCard({title: 'Sequence', action: sample
    ? 'Shown as ' + escHtml([sample.first_name, sample.last_name].filter(Boolean).join(' ') || sample.email) + ' gets it' : '',
    body: '<div class="cp-steps">' + steps + '</div>'});
  const people = rs.length ? uiTable({
    columns: [
      {key: 'name', header: 'Contact', render: r => '<span class="ui-cell-main">'
        + uiDash([r.first_name, r.last_name].filter(Boolean).join(' ') || r.email) + '</span><span class="ui-cell-sub">'
        + uiDash(r.company) + '</span>'},
      {key: 'email', header: 'Email', render: r => escHtml(r.email) + ' ' + cpBadge(r.email_status || 'guess')},
      {key: 'stage', header: 'Stage', render: r => cpBadge(r.status || 'new')},
      {key: 'act', header: '', align: 'right', render: (r, ri) => '<span class="cp-acts">' + campaignRecipientActions(c, ci, r, ri, 0) + '</span>'},
    ],
    rows: rs, rowKey: r => r.id,
  }) : uiEmpty('No contacts in this campaign', 'Sellbird adds the people it writes this sequence for.');
  return head + strip + '<div class="ui-grid cp-grid">' + seqCard + '<div class="ui-stack">'
    + uiCard({title: 'Progress', body: campaignProgress(c) || uiEmpty('Nobody to track yet')})
    + uiCard({title: 'Contacts', body: people}) + '</div></div>';
}

function campaignListPage(data) {
  const all = data.map((c, i) => Object.assign({_i: i}, c));
  const rows = _cpFilter === 'all' ? all : all.filter(c => cpFilterKey(c.status) === _cpFilter);
  const off = rows.length ? Math.min(_cpOffset, Math.floor((rows.length - 1) / CP_PAGE) * CP_PAGE) : 0;
  return campaignCountTabs(data, _cpFilter)
    + '<div>' + campaignsTable(rows.slice(off, off + CP_PAGE))
    + uiPager({total: rows.length, offset: off, size: CP_PAGE, onPage: o => 'pageCampaigns(' + o + ')'}) + '</div>';
}

function campaignsHead() {
  return uiPageHead({title: 'Campaigns',
    sub: 'Each campaign is one audience and one sequence. Open a campaign to see its emails and the people it goes to.'});
}

function renderCampaigns() {
  const el = document.getElementById('campaigns-list');
  if (!el) return;
  const data = _campaigns || [];
  const ci = _cpOpen ? data.findIndex(c => c.id === _cpOpen) : -1;
  if (ci >= 0) { el.innerHTML = campaignDetailPage(data[ci], ci); return; }
  _cpOpen = null;
  if (!data.length) {
    el.innerHTML = campaignsHead() + uiCard({body: uiEmpty('No campaigns yet',
      'The Writer agent hasn\'t drafted any sequences. It kicks in automatically once Sellbird has scored prospects to write for.')});
    return;
  }
  el.innerHTML = campaignsHead() + campaignListPage(data);
}

function openCampaign(i) {
  const c = _campaigns[i];
  if (!c) return;
  _cpOpen = c.id;
  renderCampaigns();
  window.scrollTo({top: 0});
}

function closeCampaign() { _cpOpen = null; renderCampaigns(); }
function setCampaignFilter(k) { _cpFilter = k; _cpOffset = 0; renderCampaigns(); }
function pageCampaigns(o) { _cpOffset = o; renderCampaigns(); }

// The sidebar's Campaigns button always lands on the list.
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('nav button');
  if (b && /'campaigns'/.test(b.getAttribute('onclick') || '')) { _cpOpen = null; _cpOffset = 0; }
}, true);

// The whole exchange in order: Sellbird's cold emails (from the Outbox), the
// replies, Sellbird's answers, and any answer still waiting for approval.
let _convos = [], _convoFilter = 'needs';
const STAGE_LABELS = {
  initial_outreach: 'Outreach', engaged: 'Engaged', qualifying: 'Qualifying', presenting: 'Presenting',
  negotiating: 'Negotiating', closing: 'Closing', closed_won: 'Won', closed_lost: 'Lost',
};
const CONVO_FILTERS = [
  ['needs', 'Needs you', c => !!c.draft || c.status === 'needs_human'],
  ['open', 'Open', c => c.status !== 'closed' && c.status !== 'awaiting_reply'],
  ['awaiting', 'Awaiting reply', c => c.status === 'awaiting_reply'],
  ['closed', 'Closed', c => c.status === 'closed'],
  ['all', 'All', () => true],
];

let _convoOpen = null;

async function loadConversations() {
  const el = document.getElementById('conversations-list');
  const data = await api('/api/conversations?awaiting=1');
  if (!data) { el.innerHTML = offlineState(); return; }
  _convos = data;
  // Open on "Needs you" only when something needs you.
  if (_convoFilter === 'needs' && !data.some(CONVO_FILTERS[0][2]))
    _convoFilter = data.some(CONVO_FILTERS[1][2]) ? 'open' : 'all';
  renderConversations();
}

function setConvoFilter(f) { _convoFilter = f; renderConversations(); }
function openConvo(id) { _convoOpen = id; renderConversations(); window.scrollTo(0, 0); }
function closeConvo() { _convoOpen = null; renderConversations(); }

function renderConversations() {
  const el = document.getElementById('conversations-list');
  const open = _convoOpen && _convos.find(c => c.id === _convoOpen);
  if (open) { el.innerHTML = convoDetailPage(open); return; }
  _convoOpen = null;
  const head = uiPageHead({title: 'Conversations', sub: 'Every reply, and how Sellbird handled it.'});
  if (!_convos.length) {
    el.innerHTML = head + convoSummary([]) + convoTiles([], 'all') + uiCard({body: uiEmpty('No conversations yet',
      'No prospects have replied so far. When they do, the Handler agent classifies each reply and responds, every thread shows up here.',
      '<a href="#" class="ui-link-arrow" onclick="goTab(\'outbox\');return false">View outbox' + icon('arrow') + '</a>')});
    return;
  }
  el.innerHTML = head + convoSummary(_convos) + convoTiles(_convos, _convoFilter) + convoTable(_convos, _convoFilter);
}

// The four numbers over the list, counted from what the tab loaded.
function convoSummary(convos) {
  const real = (convos || []).filter(c => c.status !== 'awaiting_reply');
  const since = Date.now() - 14 * 86400000;
  const recent = real.filter(c => +parseTs(c.created_at) >= since).length;
  return uiMetricStrip([
    {label: 'Replies', value: String(recent), sub: 'last 14 days'},
    {label: 'Interested', value: String(real.filter(c => c.intent === 'interested' || c.intent === 'accepted_offer').length), sub: 'ready for a meeting'},
    {label: 'Objections', value: String(real.filter(c => c.intent === 'objection').length), sub: 'answered by Sellbird'},
    {label: 'Opted out', value: String((convos || []).filter(c => c.prospect_status === 'opted_out' || c.intent === 'unsubscribe').length), sub: 'never emailed again'},
  ]);
}

// Count tiles: one per existing filter, the selected one outlined.
function convoTiles(convos, active) {
  return '<div class="convo-tiles" role="tablist" aria-label="Filter conversations">' + CONVO_FILTERS.map(f =>
    '<button type="button" class="convo-tile" role="tab" aria-selected="' + (f[0] === active) + '" onclick="setConvoFilter(\''
    + f[0] + '\')"><span>' + escHtml(f[1]) + '</span><span class="convo-tile__n">'
    + (convos || []).filter(f[2]).length + '</span></button>').join('') + '</div>';
}

function convoStatusBadge(c) {
  if (c.status === 'needs_human') return uiBadge('warning', 'Needs you');
  if (c.draft) return uiBadge('warning', 'Reply waiting');
  if (c.status === 'open') return uiBadge('info', 'Open');
  if (c.status === 'awaiting_reply') return uiBadge('neutral', 'Awaiting reply');
  if (c.status === 'closed') return uiBadge('neutral', 'Closed');
  return uiBadge('neutral', statusMeta(c.status).label);
}

// The newest thing said in the thread: a message, or the last email sent.
function convoLast(c) {
  const t = (c.thread || []).filter(m => m && m.content);
  if (t.length) return String(t[t.length - 1].content);
  const e = (c.emails || []).filter(x => x && x.subject);
  return e.length ? 'Email ' + (e[e.length - 1].step || 1) + ': ' + e[e.length - 1].subject : '';
}

function convoTable(convos, filterKey) {
  const filter = CONVO_FILTERS.find(f => f[0] === filterKey) || CONVO_FILTERS[CONVO_FILTERS.length - 1];
  // Handed-to-you first, then drafts waiting; otherwise newest first (as served).
  const rank = c => c.status === 'needs_human' ? 0 : c.draft ? 1 : 2;
  const shown = (convos || []).filter(filter[2]).map((c, i) => [c, i])
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
  return uiTable({
    columns: [
      {key: 'who', header: 'Contact', render: c => '<span class="ui-cell-main">'
        + escHtml([c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || c.prospect_email || 'Unknown') + '</span>'
        + '<span class="ui-cell-sub">' + escHtml([c.company, c.prospect_email].filter(Boolean).join(' · ')) + '</span>'},
      {key: 'status', header: 'Status', render: convoStatusBadge},
      {key: 'stage', header: 'Stage', render: c => own(STAGE_LABELS, c.stage) ? uiBadge('neutral', STAGE_LABELS[c.stage]) : uiDash('')},
      {key: 'last', header: 'Last message', render: c => '<span class="convo-last">' + uiDash(convoLast(c)) + '</span>'},
      {key: 'when', header: 'When', align: 'right', render: c => uiDash(relTime(c.updated_at))},
    ],
    rows: shown, empty: 'No conversation matches this filter.',
    onRow: c => 'openConvo(' + jsq(c.id) + ')',
  });
}

// The whole exchange in order, oldest first.
function convoThread(c) {
  const items = (c.emails || []).map(e => ({ts: e.sent_at, email: e}))
    .concat((c.thread || []).map(m => ({ts: m.timestamp, msg: m})))
    .map(it => ({...it, key: +parseTs(it.ts)}))
    // An item with no time goes last instead of scrambling the order.
    .sort((a, b) => (isNaN(a.key) ? Infinity : a.key) - (isNaN(b.key) ? Infinity : b.key) || 0);
  const first = c.first_name || 'Them';
  const thread = items.map(it => {
    if (it.email) {
      return '<div class="thread-email"><div class="te-head">' + icon('campaigns') +
        '<b>Email ' + escHtml(String(it.email.step)) + '</b><span>' + escHtml(it.email.subject) + '</span>' +
        '<span class="te-when">' + relTime(it.email.sent_at) + '</span></div>' +
        '<div class="te-body">' + escHtml(it.email.body) + '</div></div>';
    }
    const m = it.msg, sent = m.sender !== 'prospect';  // 'harvey' (the old name) is ours too
    return '<div class="thread-msg ' + (sent ? 'sent' : 'received') + '"><div class="sender">' +
      (sent ? 'Sellbird' : escHtml(first)) + ' &middot; ' + relTime(m.timestamp) + '</div>' +
      escHtml(m.content) + '</div>';
  }).join('');
  const draft = c.draft
    ? '<div class="thread-draft"><div class="sender">' + icon('pen') + 'Sellbird drafted a reply · waiting for you</div>' +
      '<div class="td-body">' + escHtml(c.draft.body) + '</div>' +
      '<button class="btn btn-primary btn-sm" onclick="goTab(\'outbox\')">Review in Outbox' + icon('arrow') + '</button></div>'
    : '';
  return '<div class="thread">' + (thread || '<p class="muted">No messages in this thread yet.</p>') + draft + '</div>';
}

function convoDetailPage(c) {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || c.prospect_email || 'Unknown';
  const sub = [c.company, c.prospect_email].filter(Boolean).join(' · ');
  const intent = c.intent && !(c.status === 'needs_human' && c.intent === 'escalate')
    ? uiBadge(statusMeta(c.intent).tone === 'good' ? 'success' : statusMeta(c.intent).tone === 'bad' ? 'danger' : 'neutral', statusMeta(c.intent).label) : '';
  const facts = '<dl class="ui-details">'
    + '<div><dt>Status</dt><dd>' + convoStatusBadge(c) + '</dd></div>'
    + '<div><dt>Intent</dt><dd>' + (intent || uiDash('')) + '</dd></div>'
    + '<div><dt>Stage</dt><dd>' + (own(STAGE_LABELS, c.stage) ? escHtml(STAGE_LABELS[c.stage]) : uiDash('')) + '</dd></div>'
    + '<div><dt>Email</dt><dd>' + uiDash(c.prospect_email) + '</dd></div>'
    + '<div><dt>Last activity</dt><dd>' + uiDash(relTime(c.updated_at)) + '</dd></div></dl>';
  const actions = convoActions(c);
  return uiPageHead({title: name, sub,
      crumbs: [{label: 'Conversations', js: 'closeConvo()'}, {label: name}]})
    + '<div class="convo-detail">'
    + uiCard({title: 'Thread', body: convoThread(c)})
    + '<div class="ui-stack">' + uiCard({title: 'Details', body: facts + (actions ? '<div class="convo-detail__actions">' + actions + '</div>' : '')}) + '</div>'
    + '</div>';
}

// Sellbird answers new replies only on open conversations: an escalated one
// waits for you to reply yourself, then close it or hand it back.
function convoActions(c) {
  if (c.status === 'needs_human' && c.prospect_status === 'opted_out') {
    // A complaint or legal threat from someone who opted out: handing it
    // back wouldn't help, Sellbird never answers them.
    return '<div class="convo-actions"><span class="muted">' + icon('alert') +
      'Opted out, and Sellbird handed this to you. Reply from your inbox if you need to, then:</span>' +
      '<button class="btn btn-secondary btn-sm" onclick="setConvoStatus(' + jsq(c.id) + ',\'closed\')">Close</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="showOptOut(' + jsq(c.prospect_id) + ',' + jsq(c.prospect_email) +
      ')">Why opted out?</button></div>';
  }
  if (c.status === 'needs_human') {
    return '<div class="convo-actions"><span class="muted">' + icon('alert') +
      'Sellbird handed this to you. Reply from your inbox, then:</span>' +
      '<button class="btn btn-secondary btn-sm" onclick="setConvoStatus(' + jsq(c.id) + ',\'open\')">Hand back to Sellbird</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="setConvoStatus(' + jsq(c.id) + ',\'closed\')">Close</button></div>';
  }
  if (c.status === 'open') {
    return '<div class="convo-actions"><button class="btn btn-ghost btn-sm" onclick="setConvoStatus(' +
      jsq(c.id) + ',\'closed\')">Close conversation</button></div>';
  }
  if (c.status === 'closed' && c.prospect_status === 'opted_out') {
    // Reopening wouldn't help: Sellbird never answers someone who opted out.
    return '<div class="convo-actions"><span class="muted">' + icon('alert') + 'Opted out. Sellbird won’t write to them.</span>' +
      '<button class="btn btn-secondary btn-sm" onclick="showOptOut(' + jsq(c.prospect_id) + ',' + jsq(c.prospect_email) +
      ')">Why opted out?</button></div>';
  }
  if (c.status === 'closed') {
    return '<div class="convo-actions"><button class="btn btn-ghost btn-sm" onclick="setConvoStatus(' +
      jsq(c.id) + ',\'open\')">Reopen</button></div>';
  }
  return '';
}

async function setConvoStatus(id, status) {
  const data = await api('/api/conversations/' + encodeURIComponent(id) + '/status', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({status: status}),
  });
  if (data && data.success) showToast(status === 'open' ? 'Open again. Sellbird will answer the next reply.' : 'Closed. A new reply starts a new conversation.', 'success');
  else showToast(failMsg(data, 'Could not update that conversation.'), 'error');
  loadConversations();
  loadToday();
}

// ── Inboxes: the main mailbox and the extra ones you connected ──
// A list (summary, table) and, for one inbox, its own page. Adding an inbox
// stays a dialog, as the design draws it.

const INBOX_STATE = {
  sending: ['Sending', 'success'],
  paused: ['Paused', 'warning'],
  not_connected: ['Not connected', 'danger'],
};
const INBOX_KINDS = {
  gmail: ['Gmail', 'Google Workspace or Gmail. Sign in with Google in your browser.'],
  microsoft: ['Microsoft 365', 'Outlook or Microsoft 365. Sign in with Microsoft in your browser.'],
  smtp: ['Other (SMTP)', 'Any other email host, with its SMTP server and password.'],
};
let _inboxes = null;
let _inboxPoll = null;
let _mainPoll = null;    // the main-mailbox sign-in; the Add-inbox dialog has its own

// The inbox page is rebuilt by the 15-second refresh only when nobody is using
// it: no field focused or edited, and no sign-in waiting to finish.
function inboxPageBusy() {
  if (_mainPoll) return true;
  const page = document.getElementById('inbox-page');
  const active = document.activeElement;
  if (page && active && page.contains(active) && /^(input|textarea|select)$/i.test(active.tagName || '')) return true;
  return ['ib-cap', 'ib-name', 'ib-confirm'].some(id => {
    const el = document.getElementById(id);
    return !!el && el.value !== el.defaultValue;
  });
}
let _inboxOpen = null;   // id of the inbox whose page is showing

function inboxBadge(ib) {
  const [label, tone] = own(INBOX_STATE, ib && ib.state) || [String((ib && ib.state) || 'Unknown'), 'neutral'];
  return uiBadge(tone, label, tone === 'success' ? 'check' : '');
}

// Cold emails sent today against the inbox's cap; a dash when either is unknown.
function inboxMeter(ib) {
  const cap = Number(ib && ib.cold_cap), sent = Number(ib && ib.cold_sent_today);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(sent)) {
    return '<span class="ib-meter"><span class="ib-bar"><i style="width:0%"></i></span><span class="ib-n">' + uiDash('') + '</span></span>';
  }
  const pct = Math.min(100, Math.round(sent / cap * 100));
  return '<span class="ib-meter" title="' + sent + ' of ' + cap + ' cold emails today"><span class="ib-bar' + (pct >= 100 ? ' is-full' : '') +
    '" role="meter" aria-valuemin="0" aria-valuemax="' + cap + '" aria-valuenow="' + sent + '"><i style="width:' + pct + '%"></i></span>' +
    '<span class="ib-n">' + sent + ' / ' + cap + '</span></span>';
}

function inboxDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
}

function inboxProvider(ib) {
  const p = ib && ib.provider === 'google' ? 'gmail' : ib && ib.provider;
  const kind = own(INBOX_KINDS, p);
  return kind ? (p === 'smtp' ? 'SMTP + IMAP' : kind[0]) : (p || '');
}

function inboxSub(ib) {
  return [ib.name, ib.main ? 'Main mailbox' : inboxProvider(ib)].filter(Boolean).join(' · ');
}

function inboxCount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function inboxSummary(data) {
  const d = data || {};
  const list = d.inboxes || [];
  const sending = list.filter(i => i.state === 'sending');
  const capToday = sending.reduce((n, i) => n + (Number(i.cold_cap) || 0), 0);
  const limit = Number(d.max_daily_sends);
  const daily = capToday && Number.isFinite(limit) ? Math.min(capToday, limit) : (capToday || (Number.isFinite(limit) ? limit : 0));
  return uiMetricStrip([
    {label: 'Inboxes', value: list.length, sub: sending.length + ' sending'},
    {label: 'Cold emails sent today', value: list.reduce((n, i) => n + (Number(i.cold_sent_today) || 0), 0),
     sub: daily ? 'of ' + daily + ' daily limit' : 'no daily limit set'},
    {label: 'First emails waiting', value: list.reduce((n, i) => n + (Number(i.first_emails_waiting) || 0), 0),
     sub: 'approved, not yet sent'},
  ]);
}

function inboxesTable(inboxes) {
  const columns = [
    {key: 'address', header: 'Inbox', render: ib => '<span class="ib-who"><span class="ib-avatar" aria-hidden="true">' +
      escHtml(String(ib.address || '?').charAt(0).toUpperCase()) + '</span><span><span class="ui-cell-main">' +
      escHtml(ib.address || '(main mailbox)') + '</span><span class="ui-cell-sub">' + uiDash(inboxSub(ib)) + '</span></span></span>'},
    {key: 'state', header: '', render: ib => inboxBadge(ib)},
    {key: 'cold', header: 'Cold emails today', render: ib => inboxMeter(ib)},
    {key: 'waiting', header: 'Waiting', align: 'right',
     render: ib => '<span class="ui-strong">' + uiDash(inboxCount(ib.first_emails_waiting)) + '</span>'},
    {key: 'provider', header: 'Provider', render: ib => uiDash(inboxProvider(ib))},
    {key: 'menu', header: '', align: 'right', render: (ib, i) => {
      const id = jsq(ib.id);
      const items = [{label: 'Open inbox', js: 'openInbox(' + i + ')'}];
      if (!ib.main) {
        items.push({label: 'Check connection', js: 'testInbox(' + id + ')'});
        items.push(ib.paused_reason
          ? {label: 'Resume sending', js: 'inboxAction(' + id + ',\'resume\')'}
          : {label: 'Pause', js: 'inboxAction(' + id + ',\'pause\')'});
      }
      return uiRowMenu(items);
    }},
  ];
  return uiTable({columns, rows: inboxes || [], rowKey: ib => ib.id, empty: 'No inboxes connected yet',
                  onRow: (ib, i) => 'openInbox(' + i + ')'});
}

function inboxWhyCard(data) {
  const per = Number(data && data.per_inbox_daily_cap), max = Number(data && data.max_daily_sends);
  const col = (t, p) => '<div><div class="ib-why__t">' + escHtml(t) + '</div><div class="ib-why__p">' + escHtml(p) + '</div></div>';
  return uiCard({cls: 'ui-card--subdued', title: 'Why add another inbox?',
    action: '<button class="btn btn-secondary btn-sm" onclick="openAddInbox()">' + icon('plus') + 'Add inbox</button>',
    body: '<div class="ib-why">' +
      col('Send more each day', 'Each inbox sends up to ' + (Number.isFinite(per) ? per : '—') +
        ' cold emails a day. Two inboxes, twice as many, all under your daily total' +
        (Number.isFinite(max) ? ' of ' + max : '') + '.') +
      col('Protect your main address', 'Send cold email from a second domain, so a bad week never touches your everyday mail.') +
      col('Pick per campaign', 'Choose which inboxes each campaign sends from. Replies always come back to the inbox that started the thread.') +
    '</div>'});
}

// `force`: after your own action, rebuild even if the page looks in use.
async function loadInboxes(force = false) {
  const el = document.getElementById('inboxes-list');
  const actions = document.getElementById('inboxes-actions');
  const data = await api('/api/inboxes');
  if (!data) { inboxShowList(true); el.innerHTML = offlineState(); return; }
  _inboxes = data;
  if (!data.native) {
    actions.innerHTML = '';
    inboxShowList(true);
    el.innerHTML = '<div class="ui-card">' + uiEmpty('Instantly sends for you',
      'Sending through several of your own inboxes works with Gmail, Microsoft 365 or SMTP. ' +
      'Set channels.email.provider in sellbird.yaml to one of those to use it.') + '</div>';
    return;
  }
  actions.innerHTML = '<button class="btn btn-primary" onclick="openAddInbox()">' + icon('plus') + 'Add inbox</button>';

  let html = '';
  if (data.sending_paused) {
    html += uiBanner({tone: 'warning', iconName: 'alert', title: 'All sending is paused',
      body: data.sending_paused + '. Resume it on the Outbox tab.',
      actions: '<button class="btn btn-secondary btn-sm" onclick="goTab(\'outbox\')">Open Outbox</button>'});
  }
  html += inboxSummary(data) + inboxesTable(data.inboxes || []);
  if (!data.several) html += inboxWhyCard(data);
  el.innerHTML = html;

  const list = data.inboxes || [];
  const at = _inboxOpen === null ? -1 : list.findIndex(i => i.id === _inboxOpen);
  if (at >= 0) { if (force || !inboxPageBusy()) renderInboxPage(at); }
  else { _inboxOpen = null; inboxShowList(true); }
}

function inboxShowList(on) {
  ['inboxes-head', 'inboxes-list'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('ib-hide', !on);
  });
  const page = document.getElementById('inbox-page');
  if (page) {
    page.classList.toggle('ib-hide', on);
    if (on) page.innerHTML = '';
  }
}

// The dialog: adding an inbox.

function inboxDialog(html) {
  const d = document.getElementById('inbox-dialog');
  d.innerHTML = html;
  if (!d.open) d.showModal();
  return d;
}

function closeInboxDialog() {
  if (_inboxPoll) { clearInterval(_inboxPoll); _inboxPoll = null; }
  const d = document.getElementById('inbox-dialog');
  if (d.open) d.close();
}

function inboxDialogHead(title, sub, extra) {
  return '<div class="modal-head"><div><h3 id="inbox-dialog-title">' + title + '</h3>' +
    (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>' + (extra || '') +
    '<button class="btn btn-ghost btn-sm btn-icon" onclick="closeInboxDialog()" aria-label="Close">' + icon('close') + '</button></div>';
}

// One inbox on its own page: status, today's numbers, the campaigns using
// it, and its settings. `data` is the /api/inboxes payload (campaigns, pools,
// per_inbox_daily_cap, can_connect).
function inboxDetailPage(ib, data) {
  const d = data || {};
  const campaigns = d.campaigns || [];
  const pools = d.pools || {};
  const id = jsq(ib.id);
  const cap = inboxCount(ib.cold_cap), sent = inboxCount(ib.cold_sent_today);
  const dl = items => '<dl class="ui-details">' + items.map(([k, v]) =>
    '<div><dt>' + escHtml(k) + '</dt><dd>' + (v || uiDash('')) + '</dd></div>').join('') + '</dl>';

  let notes = '';
  if (ib.state === 'not_connected' && !(ib.main && (ib.provider === 'gmail' || ib.provider === 'microsoft'))) {
    notes += uiBanner({tone: 'danger', iconName: 'alert', title: 'Not connected',
      body: ib.connect_hint || 'Sellbird can\'t sign in to it from this computer. Check the connection to see why, or remove it and add it again.'});
  }
  if (ib.paused_reason) notes += uiBanner({tone: 'warning', iconName: 'alert', title: 'Paused', body: ib.paused_reason});

  let actions = '';
  if (!ib.main) {
    actions = (ib.paused_reason
      ? '<button class="btn btn-secondary" onclick="inboxAction(' + id + ',\'resume\')">Resume sending</button>'
      : '<button class="btn btn-secondary" onclick="inboxAction(' + id + ',\'pause\')"' + (ib.state === 'not_connected' ? ' disabled' : '') + '>Pause inbox</button>') +
      '<button class="btn btn-primary" onclick="testInbox(' + id + ')">Check connection</button>';
  }
  const head = uiPageHead({
    title: ib.address || 'Main mailbox', sub: [ib.name, ib.main ? 'Main mailbox' : '', inboxProvider(ib)].filter(Boolean).join(' · '),
    crumbs: [{label: 'Inboxes', js: 'closeInbox()'}, {label: ib.address || 'Main mailbox'}], actions,
  }).replace('</h2>', ' ' + inboxBadge(ib) + '</h2>');

  const strip = uiMetricStrip([
    {label: 'Sent today', value: sent, sub: cap !== null ? 'of ' + cap + ' cold emails' : ''},
    {label: 'Waiting', value: inboxCount(ib.first_emails_waiting), sub: 'first emails, approved, not yet sent'},
    {label: 'Warming up since', value: ib.warmup_started_at ? inboxDate(ib.warmup_started_at) : (ib.main ? null : 'Established'),
     sub: ib.warmup_started_at ? 'starts lower, ramps up' : ''},
  ]);

  let using = '';
  if (!campaigns.length) using = uiEmpty('No campaigns yet');
  else {
    const mine = campaigns.filter(c => (pools[c.id] || []).includes(ib.id));
    const every = campaigns.filter(c => !pools[c.id]);
    const rows = mine.map(c => ({name: c.name, how: 'Chose this inbox'}))
      .concat(every.map(c => ({name: c.name, how: 'Sends from every inbox'})));
    using = uiTable({columns: [{key: 'name', header: 'Campaign', render: r => uiDash(r.name || 'Untitled')},
                               {key: 'how', header: 'How'}],
                     rows, empty: 'None. Every campaign has chosen other inboxes.'}) +
      (every.length ? '<div class="form-hint">Campaigns that haven\'t chosen inboxes send from all of them.</div>' : '');
  }
  const left = uiCard({title: 'Campaigns sending from it', body: using});

  let right = uiCard({title: 'Setup', body: dl([
    ['Address', escHtml(ib.address || '')], ['Provider', escHtml(inboxProvider(ib))],
    ['Sender name', escHtml(ib.name || '')],
    ['Daily cap', cap !== null ? cap + ' cold emails' + (ib.cap_is_yours ? '' : ' (default)') : ''],
    ['Warming up since', ib.warmup_started_at ? escHtml(inboxDate(ib.warmup_started_at)) : ''],
  ])});

  if (ib.main) {
    const kind = ib.provider === 'gmail' || ib.provider === 'microsoft' ? ib.provider : '';
    let connect = '';
    if (ib.state === 'not_connected' && kind) {
      const can = (d.can_connect || {})[kind];
      connect = uiCard({title: 'Connect', body: '<div id="main-status"></div>' + (can
        ? uiBanner({tone: 'danger', iconName: 'alert', title: 'Not connected', body: 'Sign in to the mailbox Sellbird sends from.'}) +
          '<div><button class="btn btn-primary" id="main-go" onclick="connectMainMailbox(\'' + kind + '\')">Sign in with ' +
          (kind === 'gmail' ? 'Google' : 'Microsoft') + '</button></div>'
        : connectSetupNotice(kind))});
    }
    right = connect + right + uiCard({title: 'Settings', body: '<p class="ib-note">Your main mailbox comes from sellbird.yaml: ' +
      'its address is persona.email, its daily cap is channels.email.per_inbox_daily_cap, and pausing it pauses ' +
      'all sending, on the Outbox tab.</p>'});
  } else {
    right += uiCard({title: 'Limits', body:
      '<label class="form-label" for="ib-cap">Daily cold-email cap</label>' +
      '<div class="inline-edit"><input class="form-input" id="ib-cap" type="number" min="1" max="500" inputmode="numeric" placeholder="Default (' +
        uiCountText(d.per_inbox_daily_cap) + ')" value="' + (ib.cap_is_yours && cap !== null ? cap : '') + '">' +
      '<button class="btn btn-secondary" onclick="saveInboxCap(' + id + ')">Save</button></div>' +
      '<div class="form-hint">Leave empty for the default. Warming inboxes start lower on their own.</div>' +
      '<label class="form-label" for="ib-name">Sender name</label>' +
      '<div class="inline-edit"><input class="form-input" id="ib-name" maxlength="100" placeholder="Your persona name" value="' + escHtml(ib.name || '') + '">' +
      '<button class="btn btn-secondary" onclick="saveInboxName(' + id + ')">Save</button></div>' +
      '<div class="form-hint">The name people see in From.</div>'});
    right += uiCard({title: 'Remove this inbox', body:
      '<p class="ib-note">Sellbird stops sending from it, and threads it started end. Its sign-in stays in your keychain.</p>' +
      '<div class="inline-edit"><input class="form-input" id="ib-confirm" placeholder="Type ' + escHtml(ib.address || '') + ' to confirm">' +
      '<button class="btn btn-danger" onclick="removeInbox(' + id + ')">Remove</button></div>'});
  }
  return '<div class="ui-page">' + head + notes + strip +
    '<div class="ui-grid ib-grid">' + left + '<div class="ui-stack">' + right + '</div></div></div>';
}

function uiCountText(v) {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== '' && v !== undefined ? String(n) : '—';
}

function renderInboxPage(i) {
  const ib = (_inboxes && _inboxes.inboxes || [])[i];
  if (!ib) return;
  _inboxOpen = ib.id;
  inboxShowList(false);
  document.getElementById('inbox-page').innerHTML = inboxDetailPage(ib, _inboxes);
}

function openInbox(i) {
  renderInboxPage(i);
  window.scrollTo(0, 0);
}

function closeInbox() {
  if (_inboxPoll) { clearInterval(_inboxPoll); _inboxPoll = null; }
  _inboxOpen = null;
  inboxShowList(true);
}

async function inboxPost(path, body, done, keepOpen) {
  const r = await api(path, {method: 'POST', headers: {'Content-Type': 'application/json'},
                             body: JSON.stringify(body || {})});
  if (r && r.success) {
    if (done) showToast(done, 'success');
    if (!keepOpen) closeInboxDialog();
    loadInboxes(true);
  } else showToast((r && r.message) || 'That didn\'t work.', 'error');
  return r;
}

function inboxAction(id, action) {
  inboxPost('/api/inboxes/' + encodeURIComponent(id) + '/' + action, {},
            action === 'pause' ? 'Inbox paused' : 'Inbox sends again');
}

function saveInboxCap(id) {
  const v = document.getElementById('ib-cap').value.trim();
  inboxPost('/api/inboxes/' + encodeURIComponent(id) + '/cap', {cap: v === '' ? null : Number(v)}, 'Cap saved');
}

function saveInboxName(id) {
  inboxPost('/api/inboxes/' + encodeURIComponent(id) + '/name',
            {name: document.getElementById('ib-name').value.trim()}, 'Name saved');
}

function removeInbox(id) {
  inboxPost('/api/inboxes/' + encodeURIComponent(id) + '/remove',
            {confirm: document.getElementById('ib-confirm').value.trim().toLowerCase()}, 'Inbox removed');
}

async function testInbox(id) {
  showToast('Checking the connection...', 'info');
  const r = await api('/api/inboxes/' + encodeURIComponent(id) + '/test', {method: 'POST'});
  if (r && r.success) showToast(r.detail || (r.ok ? 'Connected' : 'Not connected'), r.ok ? 'success' : 'error');
  else showToast((r && r.message) || 'Couldn\'t check it.', 'error');
}

// Adding an inbox

let _addKind = 'gmail';

function openAddInbox(kind) {
  if (kind) _addKind = kind;
  const can = (_inboxes && _inboxes.can_connect) || {};
  const picks = Object.keys(INBOX_KINDS).map(k =>
    '<button class="provider-pick' + (k === _addKind ? ' on' : '') + '" onclick="openAddInbox(\'' + k + '\')" aria-pressed="' + (k === _addKind) + '">' +
    '<b>' + INBOX_KINDS[k][0] + '</b><span>' + INBOX_KINDS[k][1] + '</span></button>').join('');
  let form = '<div class="form-group"><label class="form-label" for="add-address">Email address</label>' +
    '<input class="form-input" id="add-address" type="email" autocomplete="off" placeholder="you@yourdomain.com" oninput="updateAddCommand()"></div>' +
    '<div class="form-row"><div class="form-group"><label class="form-label" for="add-name">Sender name <span class="optional-tag">optional</span></label>' +
    '<input class="form-input" id="add-name" maxlength="100" placeholder="Your persona name"></div>' +
    '<div class="form-group"><label class="form-label" for="add-warmup">Warming up since <span class="optional-tag">optional</span></label>' +
    '<input class="form-input" id="add-warmup" type="date"></div></div>' +
    '<div class="form-hint" style="margin:-8px 0 16px">Leave the date empty if this inbox has been sending normally for a while.</div>';
  let note = '';
  if (_addKind === 'smtp') {
    form += '<div class="form-row"><div class="form-group"><label class="form-label" for="add-host">SMTP server</label>' +
      '<input class="form-input" id="add-host" placeholder="smtp.yourhost.com"></div>' +
      '<div class="form-group" style="max-width:110px"><label class="form-label" for="add-port">Port</label>' +
      '<input class="form-input" id="add-port" type="number" value="587"></div></div>' +
      '<div class="form-group"><label class="form-label" for="add-password">Password or app password</label>' +
      '<input class="form-input" id="add-password" type="password" autocomplete="new-password"></div>' +
      '<details class="more-fields"><summary>Username and IMAP (for reading replies)</summary>' +
      '<div class="form-group"><label class="form-label" for="add-user">Username</label><input class="form-input" id="add-user" placeholder="Same as the address"></div>' +
      '<div class="form-row"><div class="form-group"><label class="form-label" for="add-imap">IMAP server</label><input class="form-input" id="add-imap" placeholder="Same as the SMTP server"></div>' +
      '<div class="form-group" style="max-width:110px"><label class="form-label" for="add-imap-port">Port</label><input class="form-input" id="add-imap-port" type="number" value="993"></div></div></details>';
    note = '<p class="form-hint">The password goes straight to your system keychain. Sellbird never shows it again.</p>';
  } else if (!can[_addKind]) {
    note = connectSetupNotice(_addKind);
  } else {
    note = '<p class="form-hint">A ' + INBOX_KINDS[_addKind][0] + ' sign-in opens in the browser on the computer running Sellbird. Sign in as the address above.</p>';
  }
  note += '<div class="modal-section"><h4>Or from your terminal</h4><div class="cmd-copy"><code id="add-cmd"></code>' +
    '<button class="btn btn-secondary btn-sm" onclick="copyAddCommand()">Copy</button></div></div>';
  const disabled = _addKind !== 'smtp' && !can[_addKind];
  inboxDialog(inboxDialogHead('Add an inbox', 'Connect an inbox you already own. Sellbird sends from it and reads its replies.') +
    '<div class="modal-body"><div class="provider-picks">' + picks + '</div><div style="height:16px"></div>' +
    '<div id="add-status"></div>' + form + note + '</div>' +
    '<div class="modal-foot"><button class="btn btn-ghost" onclick="closeInboxDialog()">Cancel</button>' +
    '<button class="btn btn-primary" id="add-go" onclick="submitAddInbox()"' + (disabled ? ' disabled' : '') + '>' +
    (_addKind === 'smtp' ? 'Connect' : 'Sign in with ' + (_addKind === 'gmail' ? 'Google' : 'Microsoft')) + '</button></div>');
  updateAddCommand();
}

function updateAddCommand() {
  const el = document.getElementById('add-cmd');
  if (!el) return;
  const addr = (document.getElementById('add-address').value || '').trim() || 'you@yourdomain.com';
  el.textContent = 'sellbird inboxes connect ' + _addKind + ' --address ' + addr +
    (_addKind === 'smtp' ? ' --smtp-host smtp.yourhost.com' : '');
}

function copyAddCommand() {
  const text = document.getElementById('add-cmd').textContent;
  navigator.clipboard.writeText(text).then(() => showToast('Copied', 'success'),
    () => showToast('Couldn\'t copy. Select the command instead.', 'error'));
}

function addStatus(cls, html) {
  const el = document.getElementById('add-status');
  if (el) el.innerHTML = html ? '<div class="notice ' + cls + '">' + html + '</div>' : '';
}

// Where the browser sign-in's own app (Google OAuth client / Microsoft app
// registration) is set up, when it isn't yet or doesn't look real.
const CONNECT_SETUP = {
  gmail: {
    field: 'gmail-id',
    steps: [
      'In <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener noreferrer">Google Cloud Console</a>, pick or create a project and enable the Gmail API.',
      'Under <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Credentials</a>, create an OAuth client ID of type <b>Desktop app</b>.',
      'Paste its Client ID and Client secret in Settings, under Gmail, and save.',
      'Come back here and sign in.',
    ],
  },
  microsoft: {
    field: 'm365-client',
    steps: [
      'In <a href="https://entra.microsoft.com" target="_blank" rel="noopener noreferrer">Entra</a>, go to App registrations and register an app for your organization only.',
      'Add the redirect URI <code>http://localhost:8766</code> as "Public client/native".',
      'Paste the Application (client) ID and tenant ID in Settings, under Microsoft 365, and save.',
      'Come back here and sign in.',
    ],
  },
};

function connectSetupNotice(kind) {
  const setup = CONNECT_SETUP[kind];
  const problem = ((_inboxes && _inboxes.connect_problems) || {})[kind] || '';
  return '<div class="notice info"><b>' + escHtml(problem) + '</b>' +
    '<ol class="setup-steps">' + setup.steps.map(t => '<li>' + t + '</li>').join('') + '</ol>' +
    '<button class="btn btn-secondary btn-sm" onclick="openSettingsAt(\'' + setup.field + '\')">Open Settings</button></div>';
}

function openSettingsAt(fieldId) {
  closeInboxDialog();
  const btn = Array.from(document.querySelectorAll('nav button'))
    .find(b => (b.getAttribute('onclick') || '').includes("'settings'"));
  showTab('settings', btn);
  setTimeout(() => {
    const el = document.getElementById(fieldId);
    if (!el) return;
    el.scrollIntoView({behavior: 'smooth', block: 'center'});
    el.focus({preventScroll: true});
  }, 300);
}

async function connectMainMailbox(kind) {
  const go = document.getElementById('main-go');
  if (go) go.disabled = true;
  const status = document.getElementById('main-status');
  const say = (cls, html) => { if (status) status.innerHTML = '<div class="notice ' + cls + '">' + html + '</div>'; };
  say('info', 'Opening the sign-in...');
  const r = await api('/api/inboxes/main/connect', {method: 'POST'});
  if (!r || !r.success) {
    if (go) go.disabled = false;
    say('bad', escHtml((r && r.message) || 'That didn\'t work.'));
    return;
  }
  say('wait', 'A ' + (kind === 'gmail' ? 'Google' : 'Microsoft') + ' sign-in opened in your browser. ' +
    'Sign in as your sending address and allow access. This page updates when you\'re done.');
  if (_mainPoll) clearInterval(_mainPoll);
  _mainPoll = setInterval(async () => {
    const s = await api('/api/inboxes/connect/status');
    if (!s || s.state === 'waiting') return;
    clearInterval(_mainPoll); _mainPoll = null;
    if (s.state === 'connected') {
      showToast('Main mailbox connected', 'success');
      closeInboxDialog(); loadInboxes(true);
    } else {
      if (go) go.disabled = false;
      say('bad', escHtml(s.message || 'The sign-in didn\'t finish.'));
    }
  }, 1500);
}

async function submitAddInbox() {
  const v = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const body = {address: v('add-address'), name: v('add-name'), warmup_started: v('add-warmup')};
  const go = document.getElementById('add-go');
  if (_addKind === 'smtp') {
    Object.assign(body, {smtp_host: v('add-host'), smtp_port: Number(v('add-port') || 587),
      password: document.getElementById('add-password').value, username: v('add-user'),
      imap_host: v('add-imap'), imap_port: Number(v('add-imap-port') || 993)});
  }
  go.disabled = true;
  addStatus('info', _addKind === 'smtp' ? 'Connecting and checking the sign-in...' : 'Opening the sign-in...');
  const r = await api('/api/inboxes/connect/' + _addKind, {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if (!r || !r.success) {
    go.disabled = false;
    addStatus('bad', escHtml((r && r.message) || 'That didn\'t work.'));
    return;
  }
  if (_addKind === 'smtp') {
    showToast('Connected ' + r.address, 'success');
    if (!r.test_ok) showToast('It\'s connected, but the check failed: ' + (r.test_detail || ''), 'error');
    closeInboxDialog(); loadInboxes(true);
    return;
  }
  addStatus('wait', 'A ' + (_addKind === 'gmail' ? 'Google' : 'Microsoft') + ' sign-in opened in your browser. ' +
    'Sign in as <b>' + escHtml(body.address.toLowerCase()) + '</b> and allow access. This page updates when you\'re done.');
  _inboxPoll = setInterval(async () => {
    const s = await api('/api/inboxes/connect/status');
    if (!s || s.state === 'waiting') return;
    clearInterval(_inboxPoll); _inboxPoll = null;
    if (s.state === 'connected') {
      showToast('Connected ' + s.address, 'success');
      if (s.message) showToast('It\'s connected, but the check failed: ' + s.message, 'error');
      closeInboxDialog(); loadInboxes(true);
    } else {
      go.disabled = false;
      addStatus('bad', escHtml(s.message || 'The sign-in didn\'t finish.'));
    }
  }, 1500);
}

let _activity = [], _actFilter = {date: 'all', agent: '', type: '', offset: 0};

async function loadActivity() {
  const el = document.getElementById('activity-list');
  const data = await api('/api/activity');
  if (!data) {
    document.getElementById('activity-summary').innerHTML = '';
    el.innerHTML = offlineState(); return;
  }
  _activity = data;
  renderActivity();
}

function renderActivity() {
  document.getElementById('activity-summary').innerHTML = activitySummary(_activity);
  document.getElementById('activity-list').innerHTML = activityFeed(_activity, _actFilter);
}

function setActivityFilter(key, value) {
  _actFilter = {..._actFilter, [key]: value, offset: 0};
  renderActivity();
}

function pageActivity(offset) { _actFilter = {..._actFilter, offset}; renderActivity(); }

// Four numbers from the last 100 actions the endpoint returns.
function activitySummary(actions) {
  const today = (actions || []).filter(a => dayLabel(a.created_at) === 'Today');
  const agents = [...new Set(today.map(a => a.agent).filter(Boolean))];
  const last = (actions || [])[0];
  const lastText = last ? (actionText(last).replace(/<[^>]*>/g, '')) : '';
  const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return uiMetricStrip([
    {label: 'Events today', value: String(today.length), sub: (actions || []).length >= 100 ? 'in the last 100 events' : 'since midnight'},
    {label: 'Agents active', value: String(agents.length), sub: agents.join(', ') || 'none today'},
    {label: 'Campaigns written', value: String(today.filter(a => a.action_type === 'write_campaign').length), sub: 'today'},
    {label: 'Last event', value: last ? timeOfDay(last.created_at) : null,
     sub: lastText ? decode(lastText).charAt(0).toLowerCase() + decode(lastText).slice(1) : ''},
  ]);
}

// A filter chip with a native select: "⊕ Agent" until one is picked, then "⊗ Agent | scout".
function activityFilterChip(key, label, value, options) {
  const on = !!value;
  return '<label class="act-filter' + (on ? ' is-applied' : '') + '">' + icon(on ? 'close' : 'plus')
    + '<span>' + escHtml(label) + '</span>' + (on ? '<span class="act-filter__sep"></span>' : '')
    + '<select aria-label="' + escHtml(label) + '" onchange="setActivityFilter(' + jsq(key) + ', this.value)">'
    + options.map(o => '<option value="' + escHtml(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + escHtml(o[1]) + '</option>').join('')
    + '</select></label>';
}

function activityRows(actions, f) {
  return (actions || []).filter(a =>
    (f.date !== 'today' || dayLabel(a.created_at) === 'Today') &&
    (!f.agent || a.agent === f.agent) && (!f.type || a.action_type === f.type));
}

function activityFeed(actions, f, size = 25) {
  const all = actions || [];
  if (!all.length) {
    return uiCard({body: uiEmpty('No activity yet',
      'Sellbird hasn\'t taken any actions. Every prospect found, email written, and reply handled will appear here the moment it happens.')});
  }
  const uniq = k => [...new Set(all.map(a => a[k]).filter(Boolean))].sort();
  const chips = '<div class="ui-chips">'
    + activityFilterChip('date', 'Date', f.date === 'today' ? 'today' : '', [['', 'All'], ['today', 'Today']])
    + activityFilterChip('agent', 'Agent', f.agent, [['', 'All']].concat(uniq('agent').map(a => [a, a])))
    + activityFilterChip('type', 'Type', f.type, [['', 'All']].concat(uniq('action_type').map(t => [t, t.replace(/_/g, ' ')])))
    + '</div>';
  const rows = activityRows(all, f);
  if (!rows.length) {
    return chips + uiCard({body: uiEmpty('No activity matches these filters', 'Clear a filter to see more.')});
  }
  return chips + '<div>' + activityTable(pageSlice(rows, f.offset || 0, size))
    + uiPager({total: rows.length, offset: f.offset || 0, size, onPage: o => 'pageActivity(' + o + ')'}) + '</div>';
}

// The loaded log as CSV, built in the page: no new endpoint.
// One CSV cell. Text from websites and replies must not run as a spreadsheet
// formula, so a value starting with = + - @ (or a tab/newline) gets a quote,
// as sellbird/register.py does for the server-side exports.
function csvCell(v) {
  let t = String(v == null ? '' : v);
  if (/^\s*[=+\-@]/.test(t) || /^[\t\r\n]/.test(t)) t = "'" + t;
  return '"' + t.replace(/"/g, '""') + '"';
}

function exportActivity() {
  const rows = activityRows(_activity, _actFilter);
  if (!rows.length) { showToast('Nothing to export.', 'error'); return; }
  const cell = csvCell;
  const div = document.createElement('div');
  const text = a => { div.innerHTML = actionText(a); return div.textContent; };
  const csv = ['time,agent,type,event'].concat(rows.map(a =>
    [a.created_at, a.agent, a.action_type, text(a)].map(cell).join(','))).join('\n');
  const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));
  const link = document.createElement('a');
  link.href = url; link.download = 'activity.csv';
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Init & live refresh ──

loadRenameNotice();
loadToday();
loadTrend();
loadFunnel();
loadSetupStatus();
loadRuns();
loadTodayActivity();
loadSellbirdStatus();

loadLiveStatus();

// Agent status: quick poll (not while locked: it would only be refused)
setInterval(() => { if (!_locked) loadSellbirdStatus(); }, 8000);

// Live status panel: refreshed while the Today tab is open and visible.
setInterval(() => {
  if (!document.hidden && !_locked && currentTab === 'today') loadLiveStatus();
}, 10000);

// Nav counts stay live wherever you are, so "something needs me" is visible
// from any tab without polling that tab's contents.
setInterval(async () => {
  if (document.hidden || _locked || currentTab === 'today') return;
  const data = await api('/api/today');
  if (!data) return;
  navCount('nav-today', (data.items || []).filter(i => i.tone !== 'good').length);
  navCount('nav-outbox', (data.stats || {}).outbox_pending || 0);
}, 20000);

// Data tabs: auto-refresh live views without clobbering anything in progress.
// Outbox, settings and help are deliberately excluded — re-rendering the desk
// under someone mid-decision loses their place, and settings may be mid-edit.
setInterval(() => {
  if (document.hidden || _locked) return;
  switch (currentTab) {
    case 'today': loadToday(); loadTrend(); loadFunnel(); loadRuns(); loadTodayActivity(); break;
    case 'companies': if (!companyDrill) loadCompanies(); break;
    case 'prospects': loadProspects(); break;
    case 'campaigns': loadCampaigns(); break;
    case 'conversations': loadConversations(); break;
    case 'activity': loadActivity(); break;
    case 'inboxes': loadInboxes(); break;
    case 'usage': loadUsage(); break;
    case 'controls': loadLogs(); break;
  }
}, 15000);


// ── Your company (sellbird.offer): what Sellbird writes from, and the offer ──
// A list of sections; each opens its own edit page under a breadcrumb.

let _company = null;
let _offerIdeas = [];
let _coSection = null;

function lines(list) { return (list || []).join('\n'); }
function splitLines(text) { return String(text || '').split('\n').map(x => x.trim()).filter(Boolean); }

// A definition list: [{label, value}], value is text (escaped here); empty shows —.
function uiDetails(items) {
  return '<dl class="ui-details">' + items.map(it => '<div><dt>' + escHtml(it.label) + '</dt><dd>'
    + uiDash(it.value) + '</dd></div>').join('') + '</dl>';
}

// "## Heading" + its first line, from a training markdown file.
function knowledgeFacts(md) {
  const out = [];
  let cur = null;
  String(md || '').split('\n').forEach(raw => {
    const line = raw.trim();
    const h = /^##\s+(.+)$/.exec(line);
    if (h) { cur = {k: h[1].trim(), v: ''}; out.push(cur); return; }
    if (cur && !cur.v && line && !line.startsWith('#')) {
      const v = line.replace(/^[-*]\s+/, '').replace(/\*\*/g, '');
      cur.v = v.length > 180 ? v.slice(0, 177) + '…' : v;
    }
  });
  return out;
}

// Competitors: the "## vs. X" cards, or every heading when there are none.
function competitorItems(md) {
  const facts = knowledgeFacts(md);
  const vs = facts.filter(f => /^vs\.?\s/i.test(f.k));
  return (vs.length ? vs.map(f => ({k: f.k.replace(/^vs\.?\s+/i, ''), v: f.v})) : facts)
    .map(f => ({label: f.k, value: f.v}));
}

// The six sections, each with a status and a one-line current value.
function companySections(c) {
  c = c || {};
  const o = c.offer || {}, p = c.product || {}, icp = c.icp || {}, s = c.persona || {};
  const n = (k, one, many) => k + ' ' + (k === 1 ? one : many);
  const objections = Object.keys(p.objection_responses || {}).length;
  const benefits = (p.key_benefits || []).length;
  const facts = knowledgeFacts(c.knowledge).length, rivals = c.competitors ? competitorItems(c.competitors).length : 0;
  const join = parts => parts.filter(Boolean).join(' · ');
  const audience = join([
    (icp.industries || []).length ? n(icp.industries.length, 'industry', 'industries') : '',
    (icp.titles || []).length ? n(icp.titles.length, 'title', 'titles') : '',
    (icp.geography || []).length ? n(icp.geography.length, 'place', 'places') : '',
    icp.company_size || '']);
  const trained = !!(c.knowledge || c.competitors);
  return [
    {key: 'offer', title: 'Offer', desc: 'What every first email ends by offering',
     status: o.entry ? 'Set' : (o.proposed ? 'Proposed' : 'Missing'), value: o.entry || ''},
    {key: 'sell', title: 'What you sell', desc: 'Product, pricing, benefits',
     status: (p.name || p.description) ? 'Set' : 'Missing',
     value: join([p.name || p.description || '', benefits ? n(benefits, 'benefit', 'benefits') : ''])},
    {key: 'audience', title: 'Who you sell to', desc: 'Industries, titles, places, size',
     status: ((icp.industries || []).length || (icp.titles || []).length) ? 'Set' : 'Missing', value: audience},
    {key: 'from', title: 'Who it\'s from', desc: 'Sender name, role and tone',
     status: s.name ? 'Set' : 'Missing', value: join([s.name, s.role, s.tone])},
    {key: 'objections', title: 'Objections and answers', desc: 'How replies handle pushback',
     status: objections ? 'Set' : 'Missing', value: objections ? n(objections, 'objection', 'objections') + ' answered' : ''},
    {key: 'learned', title: 'What Sellbird learned from your site', desc: 'Product knowledge and competitors, from training',
     status: trained ? 'Trained' : 'Missing',
     value: trained ? join([n(facts, 'topic', 'topics'), rivals ? n(rivals, 'competitor', 'competitors') : '']) : ''},
  ];
}

function coStatusBadge(status) {
  if (status === 'Set' || status === 'Trained') return uiBadge('success', status, 'check');
  if (status === 'Proposed') return uiBadge('info', 'Proposed');
  return uiBadge('warning', 'Missing');
}

function companySummary(c) {
  c = c || {};
  const secs = companySections(c);
  const done = secs.filter(x => x.status === 'Set' || x.status === 'Trained').length;
  const p = c.product || {}, s = c.persona || {};
  const objections = Object.keys(p.objection_responses || {}).length;
  const trained = !!(c.knowledge || c.competitors);
  return uiMetricStrip([
    {label: 'Sections complete', value: done + ' of ' + secs.length, sub: done === secs.length ? 'ready to write' : (secs.length - done) + ' to fill in'},
    {label: 'Objections answered', value: String(objections), sub: 'used in replies'},
    {label: 'Trained from', value: trained ? 'Your website' : null,
     sub: trained ? knowledgeFacts(c.knowledge).length + ' topics learned' : 'run sellbird train <url>'},
    {label: 'Sender', value: s.name || null, sub: s.role || ''},
  ]);
}

function companySectionsTable(c) {
  return uiTable({
    columns: [
      {key: 'title', header: 'Section', render: r => '<span class="ui-cell-main">' + escHtml(r.title) + '</span>'
        + '<span class="ui-cell-sub">' + escHtml(r.desc) + '</span>'},
      {key: 'status', header: '', render: r => coStatusBadge(r.status)},
      {key: 'value', header: 'Current value', render: r => '<span class="co-value">' + uiDash(r.value) + '</span>'},
    ],
    rows: companySections(c), rowKey: r => r.key,
    onRow: r => 'openCompanySection(' + jsq(r.key) + ')',
  });
}

function objectionRow(k, v, i) {
  return `<div class="company-objection">
    <div class="form-group"><label class="form-label" for="co-ok-${i}">When they say</label>
      <input class="form-input co-ok" id="co-ok-${i}" value="${escHtml(k)}"></div>
    <div class="form-group"><label class="form-label" for="co-ov-${i}">Answer with</label>
      <textarea class="form-input co-ov" id="co-ov-${i}" rows="2">${escHtml(v)}</textarea></div>
  </div>`;
}

function coField(id, label, inputHtml, help = '') {
  return '<div class="form-group"><label class="form-label" for="' + id + '">' + escHtml(label) + '</label>'
    + inputHtml + (help ? '<div class="co-help">' + escHtml(help) + '</div>' : '') + '</div>';
}
function coInput(id, value, extra = '') {
  return '<input class="form-input" id="' + id + '" value="' + escHtml(value) + '"' + extra + '>';
}
function coArea(id, value, rows) {
  return '<textarea class="form-input" id="' + id + '" rows="' + rows + '">' + escHtml(value) + '</textarea>';
}

// One section's edit page: breadcrumb, title, Cancel/Save, then its form.
function companySectionPage(key, c) {
  c = c || {};
  const sec = companySections(c).find(x => x.key === key) || companySections(c)[0];
  const o = c.offer || {}, p = c.product || {}, icp = c.icp || {}, s = c.persona || {};
  const save = {offer: 'saveOffer()', sell: 'saveCompanySection(\'product\')', audience: 'saveCompanySection(\'icp\')',
                from: 'saveCompanySection(\'persona\')', objections: 'saveCompanySection(\'product\', true)'}[sec.key];
  const actions = '<button class="btn btn-secondary" onclick="closeCompanySection()">' + (save ? 'Cancel' : 'Back') + '</button>'
    + (save ? '<button class="btn btn-primary" onclick="' + save + '">Save</button>' : '');
  const head = uiPageHead({title: sec.title, sub: sec.desc + '.', actions,
    crumbs: [{label: 'Your company', js: 'closeCompanySection()'}]})
    .replace('</h2>', ' ' + coStatusBadge(sec.status) + '</h2>');
  let body = '';
  if (sec.key === 'offer') {
    const proposed = o.proposed ? '<div class="offer-proposed">'
      + '<div>' + uiBadge('info', 'Your agent proposed') + '</div>'
      + '<p class="offer-proposed-text">' + escHtml(o.proposed.entry) + '</p>'
      + (o.proposed.why ? '<p class="co-help">' + escHtml(o.proposed.why) + '</p>' : '')
      + '<div class="offer-actions"><button class="btn btn-primary btn-sm" onclick="useProposedOffer()">Use this offer</button>'
      + '<button class="btn btn-secondary btn-sm" onclick="dismissProposedOffer()">Dismiss</button></div></div>' : '';
    body = '<div class="ui-grid co-grid">'
      + uiCard({title: 'Your offer', body: proposed
        + coField('offer-entry', 'Offer', '<textarea class="form-input" id="offer-entry" rows="3" maxlength="300" placeholder="e.g. a written plan for getting you onto page one of Google">'
          + escHtml(o.entry || '') + '</textarea>',
          'Each first email names something Sellbird found about the prospect, says what it costs them, and offers this as the fix. '
          + 'Make it free, specific, and something you can deliver this week.'
          + (o.entry ? '' : ' No offer yet, so first emails end with a question instead.')
          + ' The easiest way to work it out is to ask your coding agent: "Help me work out my Sellbird offer."')
        + '<div class="offer-actions">'
        + '<button class="btn btn-secondary btn-sm" id="offer-preview-btn" onclick="previewOffer()">Preview an email</button>'
        + '<button class="btn btn-secondary btn-sm" id="offer-suggest-btn" onclick="suggestOffers()">Suggest ideas</button></div>'
        + '<div id="offer-preview" class="offer-preview" hidden></div>'})
      + uiCard({title: 'Ideas to start from', cls: 'ui-card--subdued', body: '<div id="offer-ideas" class="offer-ideas"></div>'})
      + '</div>';
  } else if (sec.key === 'sell') {
    body = uiCard({title: 'What you sell', body: '<div class="company-grid">'
      + coField('co-p-name', 'Product or service', coInput('co-p-name', p.name))
      + coField('co-p-pricing', 'Pricing', coInput('co-p-pricing', p.pricing)) + '</div>'
      + coField('co-p-desc', 'What it is and who it\'s for', coArea('co-p-desc', p.description, 3))
      + coField('co-p-benefits', 'Key benefits', coArea('co-p-benefits', lines(p.key_benefits), 4), 'One per line')});
  } else if (sec.key === 'audience') {
    body = uiCard({title: 'Who you sell to', body: '<div class="company-grid">'
      + coField('co-i-industries', 'Industries', coArea('co-i-industries', lines(icp.industries), 4), 'One per line')
      + coField('co-i-titles', 'Job titles', coArea('co-i-titles', lines(icp.titles), 4), 'One per line')
      + coField('co-i-geo', 'Where', coArea('co-i-geo', lines(icp.geography), 4), 'One per line')
      + coField('co-i-size', 'Company size', coInput('co-i-size', icp.company_size)) + '</div>'});
  } else if (sec.key === 'from') {
    body = uiCard({title: 'Who it\'s from', body: '<div class="company-grid">'
      + coField('co-s-name', 'Sender name', coInput('co-s-name', s.name), 'Signed under every email')
      + coField('co-s-role', 'Role', coInput('co-s-role', s.role))
      + coField('co-s-company', 'Company', coInput('co-s-company', s.company, ' disabled'), 'Set in your config file')
      + coField('co-s-email', 'Reply-to', coInput('co-s-email', s.email, ' disabled'), 'Set in your config file')
      + coField('co-s-tone', 'Tone', coInput('co-s-tone', s.tone)) + '</div>'});
  } else if (sec.key === 'objections') {
    const objections = Object.entries(p.objection_responses || {});
    body = uiCard({title: 'Objections and answers',
      action: '<button class="btn btn-secondary btn-sm" onclick="addObjection()">' + icon('plus') + 'Add an objection</button>',
      body: '<div id="co-objections" class="company-objections">'
        + (objections.length ? objections : [['', '']]).map(([k, v], i) => objectionRow(k, v, i)).join('') + '</div>'});
  } else {
    const facts = knowledgeFacts(c.knowledge), rivals = c.competitors ? competitorItems(c.competitors) : [];
    const full = (label, text) => text ? '<details class="company-learned"><summary>' + escHtml(label)
      + '</summary><pre>' + escHtml(text) + '</pre></details>' : '';
    const retrain = '<span>Retrain with <code>sellbird train &lt;url&gt;</code></span>';
    if (!c.knowledge && !c.competitors) {
      body = uiCard({body: uiEmpty('Nothing learned yet',
        'Train Sellbird on your website with sellbird train <url> and what it learns about your product and competitors shows here.')});
    } else {
      body = '<div class="ui-grid co-grid">'
        + uiCard({title: 'Product knowledge', action: retrain, body: uiTable({
            columns: [{key: 'k', header: 'Fact', render: r => '<span class="ui-strong">' + escHtml(r.k) + '</span>'},
                      {key: 'v', header: 'Detail', render: r => '<span class="co-value">' + uiDash(r.v) + '</span>'}],
            rows: facts, empty: 'No product knowledge yet'}) + full('Read the full text', c.knowledge)})
        + '<div class="ui-stack">'
        + uiCard({title: 'Competitors', body: rivals.length ? uiDetails(rivals) + full('Read the battle cards', c.competitors)
            : uiEmpty('No competitors yet')})
        + uiCard({title: 'Source', body: uiDetails([
            {label: 'Product knowledge', value: c.knowledge ? 'skills/product_knowledge.md' : ''},
            {label: 'Competitors', value: c.competitors ? 'skills/competitive_intel.md' : ''},
            {label: 'Topics', value: String(facts.length)}])})
        + '</div></div>';
    }
  }
  return head + body;
}

function companyListPage(c) {
  const o = (c && c.offer) || {};
  return uiPageHead({title: 'Your company',
      sub: 'Everything Sellbird writes from: what you sell, who you sell to, the offer every first email ends with, '
        + 'and who it\'s from. Open a section to edit it, or talk it through with your coding agent.',
      actions: '<button class="btn btn-secondary" onclick="companyPreview()">Preview an email</button>'})
    + (o.proposed ? uiBanner({tone: 'warning', iconName: 'flag', title: 'Your agent proposed an offer',
        body: o.proposed.entry,
        actions: '<button class="btn btn-secondary btn-sm" onclick="openCompanySection(\'offer\')">Review it</button>'}) : '')
    + companySummary(c) + companySectionsTable(c);
}

function renderCompany() {
  const body = document.getElementById('company-body');
  if (!body || !_company) return;
  body.innerHTML = _coSection ? companySectionPage(_coSection, _company) : companyListPage(_company);
  if (_coSection === 'offer') renderOfferIdeas();
}

// keepSection: stay on the open section (after saving the offer); otherwise the list.
async function loadCompany(keepSection) {
  if (!keepSection) _coSection = null;
  const body = document.getElementById('company-body');
  const data = await api('/api/company');
  if (!data) { body.innerHTML = offlineState(); return; }
  if (data.error) {
    body.innerHTML = uiBanner({tone: 'danger', iconName: 'alert', title: 'Couldn\'t read your company', body: data.error});
    return;
  }
  _company = data;
  _offerIdeas = ((data.offer || {}).entry_ideas || []).map(x => ({offer: x}));
  renderCompany();
  const badge = document.getElementById('nav-company');
  if (badge) badge.textContent = (data.offer || {}).proposed ? '1' : '';
}

function openCompanySection(key) {
  _coSection = key;
  renderCompany();
  window.scrollTo({top: 0});
}

// Back to the list, re-read so the summary shows what was just saved.
function closeCompanySection() {
  _coSection = null;
  loadCompany();
}

// The header's "Preview an email": the preview lives on the offer page.
function companyPreview() {
  openCompanySection('offer');
  previewOffer();
}

function addObjection() {
  const box = document.getElementById('co-objections');
  box.insertAdjacentHTML('beforeend', objectionRow('', '', box.children.length));
}

async function saveCompanySection(section, objectionsOnly) {
  const v = id => document.getElementById(id).value;
  let fields;
  if (section === 'product' && objectionsOnly) {
    const out = {};
    document.querySelectorAll('.company-objection').forEach(row => {
      const k = row.querySelector('.co-ok').value.trim(), a = row.querySelector('.co-ov').value.trim();
      if (k && a) out[k] = a;
    });
    fields = {objection_responses: out};
  } else if (section === 'product') {
    fields = {name: v('co-p-name'), pricing: v('co-p-pricing'), description: v('co-p-desc'),
              key_benefits: splitLines(v('co-p-benefits'))};
  } else if (section === 'icp') {
    fields = {industries: splitLines(v('co-i-industries')), titles: splitLines(v('co-i-titles')),
              company_size: v('co-i-size'), geography: splitLines(v('co-i-geo'))};
  } else if (section === 'persona') {
    fields = {name: v('co-s-name'), role: v('co-s-role'), tone: v('co-s-tone')};
  }
  const r = await api('/api/company', {method: 'POST', headers: {'Content-Type': 'application/json'},
                                       body: JSON.stringify({section, fields})});
  if (r && r.success) showToast(r.message, 'success');
  else showToast((r && r.message) || 'Couldn\'t save.', 'error');
}

function renderOfferIdeas() {
  const box = document.getElementById('offer-ideas');
  if (!box) return;
  if (!_offerIdeas.length) {
    box.innerHTML = '<p class="co-help">No ideas yet. Press Suggest ideas and Sellbird proposes a few offers that fit what you sell.</p>';
    return;
  }
  box.innerHTML = '<p class="co-help">Click one to put it in the box, then make it yours.</p>' +
    _offerIdeas.map((idea, i) => `<button type="button" class="offer-idea" onclick="useOfferIdea(${i})">
      <span class="offer-idea-text">${escHtml(idea.offer)}</span>
      ${idea.finding ? `<span class="offer-idea-meta">Pairs with: ${escHtml(idea.finding)}</span>` : ''}
      ${idea.why ? `<span class="offer-idea-meta">${escHtml(idea.why)}</span>` : ''}
    </button>`).join('');
}

function useOfferIdea(i) {
  const el = document.getElementById('offer-entry');
  el.value = _offerIdeas[i].offer;
  el.focus();
}

async function suggestOffers() {
  const btn = document.getElementById('offer-suggest-btn');
  btn.disabled = true; btn.textContent = 'Thinking...';
  document.getElementById('offer-ideas').innerHTML =
    '<p class="co-help">Sellbird is reading your product and coming up with offers that fit it...</p>';
  const r = await api('/api/offer/suggest', {method: 'POST'});
  btn.disabled = false; btn.textContent = 'Suggest ideas';
  if (!r || r.error || !r.ideas) { renderOfferIdeas(); showToast((r && r.error) || 'Sellbird couldn\'t come up with offers just now. Try again.', 'error'); return; }
  _offerIdeas = r.ideas;
  renderOfferIdeas();
}

async function previewOffer() {
  const entry = document.getElementById('offer-entry').value.trim();
  if (!entry) { showToast('Write an offer first.', 'error'); return; }
  const btn = document.getElementById('offer-preview-btn');
  const box = document.getElementById('offer-preview');
  btn.disabled = true; btn.textContent = 'Writing...';
  box.hidden = false;
  box.innerHTML = '<p class="co-help">Writing a sample first email for one of your prospects. Nothing is saved or sent.</p>';
  box.scrollIntoView({block: 'nearest', behavior: 'smooth'});
  const r = await api('/api/offer/preview', {method: 'POST', headers: {'Content-Type': 'application/json'},
                                            body: JSON.stringify({entry})});
  btn.disabled = false; btn.textContent = 'Preview an email';
  if (!r || !r.ok) { box.innerHTML = `<p class="co-help">${escHtml((r && r.message) || 'The preview failed. Try again.')}</p>`; return; }
  box.innerHTML = `<div class="form-label">Sample for ${escHtml(r.to)} (not saved, not sent)</div>
    <div class="offer-mail"><div class="offer-mail-subject">${escHtml(r.subject)}</div><pre>${escHtml(r.body)}</pre></div>`;
  box.scrollIntoView({block: 'nearest', behavior: 'smooth'});
}

async function saveOffer(entryOverride) {
  const entry = entryOverride != null ? entryOverride : document.getElementById('offer-entry').value.trim();
  const r = await api('/api/offer', {method: 'POST', headers: {'Content-Type': 'application/json'},
                                     body: JSON.stringify({entry})});
  if (r && r.success) { showToast(r.message, 'success'); loadCompany(_coSection === 'offer'); }
  else showToast((r && r.message) || 'Couldn\'t save the offer.', 'error');
}

async function useProposedOffer() {
  if (_company && _company.offer && _company.offer.proposed) await saveOffer(_company.offer.proposed.entry);
}

async function dismissProposedOffer() {
  await api('/api/offer/propose', {method: 'DELETE'});
  loadCompany(_coSection === 'offer');
}

(function wireInboxDialog() {
  const d = document.getElementById('inbox-dialog');
  if (!d) return;
  d.addEventListener('close', () => { if (_inboxPoll) { clearInterval(_inboxPoll); _inboxPoll = null; } });
  d.addEventListener('click', e => { if (e.target === d) closeInboxDialog(); });
})();
