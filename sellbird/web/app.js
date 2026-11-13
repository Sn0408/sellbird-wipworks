let currentTab = 'today';
let companyDrill = false;      // true while viewing a single company's contacts
let _companies = [], _prospects = [], _campaigns = [];
let _signals = null;           // last /api/signals payload, for the cohort builder
let _desk = { items: [], i: 0 };

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

async function loadSignals() {
  const data = await api('/api/signals');
  const sumEl = document.getElementById('signals-summary');
  const grpEl = document.getElementById('signals-groups');
  if (!data || data.error) { grpEl.innerHTML = offlineState(); sumEl.innerHTML = ''; return; }
  _signals = data;

  const s = data.summary || {};
  navCount('nav-signals', s.proposed || 0);
  const parts = [['Confirmed', s.confirmed || 0, 'c-good'], ['Waiting on you', s.proposed || 0, 'c-wait'],
                 ['Turned off', s.rejected || 0, 'c-idle']];
  const all = parts.reduce((x, p) => x + p[1], 0) || 1;
  sumEl.innerHTML = '<div class="card sig-summary"><div class="funnel-bar">' +
    parts.filter(p => p[1]).map(p => '<span class="seg ' + p[2] + '" style="flex:' + p[1] + '"></span>').join('') +
    '</div><div class="funnel-legend">' + parts.map(p =>
      '<div class="legend-item"><span class="legend-key"><i class="' + p[2] + '"></i>' + p[0] + '</span>' +
      '<span class="legend-val">' + p[1] + '<small>' + Math.round(100 * p[1] / all) + '%</small></span></div>'
    ).join('') + '</div></div>';

  grpEl.innerHTML = (data.groups || []).map(g => {
    // Only the undecided ones: "Confirm all" must never re-enable a signal
    // you turned off (or "Skip all" turn off one you confirmed).
    const pending = escHtml(JSON.stringify(g.signals.filter(x => x.status === 'proposed').map(x => x.code)));
    const undecided = g.signals.filter(x => x.status === 'proposed').length;
    return '<div class="sig-group">' +
      '<div class="sig-group-head"><div>' +
        '<h3>' + escHtml(g.label) + '</h3><p>' + escHtml(g.blurb) + '</p>' +
      '</div>' +
      (undecided
        ? '<div style="display:flex;gap:6px;flex-shrink:0">' +
            '<button class="btn btn-primary btn-sm" onclick="setSignals(' + pending +
              ', \'confirmed\')">Confirm all ' + undecided + '</button>' +
            '<button class="btn btn-secondary btn-sm" onclick="setSignals(' + pending +
              ', \'rejected\')">Skip all ' + undecided + '</button>' +
          '</div>'
        : '') +
      '</div>' +
      '<div class="card flush">' + g.signals.map(sigRow).join('') + '</div>' +
    '</div>';
  }).join('');

  renderCohortBuilder();
}

function sigRow(sig) {
  const free = /free|included/i.test(sig.cost_note || '');
  const costCls = free ? 'free' : (/\$/.test(sig.cost_note || '') ? 'paid' : '');
  const seen = sig.companies
    ? '<span class="cost-chip">seen on ' + sig.companies +
      (sig.companies === 1 ? ' company' : ' companies') + ' so far</span>' : '';
  const floor = sig.confidence_floor > 0
    ? '<span class="cost-chip">only recorded above ' +
      Math.round(sig.confidence_floor * 100) + '% confidence</span>' : '';

  const decide = sig.status === 'confirmed'
    ? '<button class="btn btn-secondary btn-sm" onclick="setSignals([' + jsq(sig.code) +
        '],\'rejected\')">Turn off</button>'
    : sig.status === 'rejected'
      ? '<button class="btn btn-secondary btn-sm" onclick="setSignals([' + jsq(sig.code) +
          '],\'confirmed\')">Turn on</button>'
      : '<button class="btn btn-primary btn-sm" onclick="setSignals([' + jsq(sig.code) +
          '],\'confirmed\')">Confirm</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="setSignals([' + jsq(sig.code) +
          '],\'rejected\')">Skip</button>';

  return '<div class="sig-row ' + (sig.status === 'rejected' ? 'rejected' : '') + '">' +
    '<div class="sig-main">' +
      '<div class="sig-label">' + escHtml(sig.label || sig.code) +
        '<span class="sig-code">' + escHtml(sig.code) + '</span></div>' +
      '<div class="sig-desc">' + escHtml(sig.description) + '</div>' +
      '<div class="sig-meta">' +
        '<span class="cost-chip ' + costCls + '">' + escHtml(sig.cost_note || 'cost unknown') + '</span>' +
        floor + seen + badge(sig.status) +
      '</div>' +
    '</div>' +
    '<div class="sig-decide">' + decide + '</div>' +
  '</div>';
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

async function loadDiscoverProviders() {
  const el = document.getElementById('discover-providers');
  const data = await api('/api/discover/providers');
  if (!data || !data.providers) { el.innerHTML = offlineState(); return; }

  _provider = _provider || data.selected || data.default;
  el.innerHTML = '<div class="prov-grid">' + data.providers.map(p => {
    const ready = p.configured
      ? '<span class="badge t-good">ready</span>'
      : '<span class="badge t-waiting">needs a key</span>';
    return '<div class="prov-card ' + (p.key === _provider ? 'selected' : '') +
      '" onclick="pickProvider(' + jsq(p.key) + ')">' +
      '<div class="prov-head"><h3>' + escHtml(p.label) + '</h3>' + ready + '</div>' +
      '<div class="blurb">' + escHtml(p.blurb) + '</div>' +
      '<div class="row"><span class="k">Cost</span><span class="v">' +
        escHtml(p.cost_note) + '</span></div>' +
      '<div class="row"><span class="k">Free</span><span class="v">' +
        escHtml(p.free_tier) + '</span></div>' +
      (p.needs_key
        ? '<div class="row"><span class="k">Setup</span><span class="v">' +
          escHtml(p.env_keys.join(', ')) + ' in .env &middot; ' +
          '<a href="' + safeHref(p.signup_url) + '" target="_blank" rel="noopener noreferrer">get a key</a>' +
          '</span></div>'
        : '') +
      (p.caveat ? '<div class="caveat">' + escHtml(p.caveat) + '</div>' : '') +
    '</div>';
  }).join('') + '</div>';

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

function pickProvider(key) {
  _provider = key;
  document.getElementById('disc-run').disabled = true;
  document.getElementById('disc-run').textContent = 'Estimate first';
  document.getElementById('discover-estimate').innerHTML = '';
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

async function estimateDiscovery() {
  const el = document.getElementById('discover-estimate');
  el.innerHTML = '<p class="muted" style="font-size:13px">Pricing it…</p>';
  const data = await api('/api/discover/estimate', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(discoverBody()),
  });
  if (!data || data.error) {
    el.innerHTML = '<div class="test-result error">' +
      escHtml((data && data.error) || 'Could not estimate.') + '</div>';
    return;
  }

  const cap = discoverBody().max_spend;
  const over = data.estimated_cost > cap;
  el.innerHTML = '<div class="estimate-box">' +
    '<div class="amount ' + (data.free ? 'free' : 'paid') + '">' +
      (data.free ? 'Free' : '$' + data.estimated_cost.toFixed(4)) + '</div>' +
    '<div class="muted" style="font-size:13px;margin-top:2px">' +
      data.query_count + ' quer' + (data.query_count === 1 ? 'y' : 'ies') +
      (data.free ? '' : ' &middot; cap is $' + cap.toFixed(2)) + '</div>' +
    (over ? '<div class="test-result error" style="margin-top:12px">' +
      'Over your cap. Raise the cap or narrow the search.</div>' : '') +
    '<div class="query-list">' +
      data.queries.slice(0, 40).map(escHtml).join('<br>') +
      (data.queries.length > 40 ? '<br>… and ' + (data.queries.length - 40) + ' more' : '') +
    '</div></div>';

  const btn = document.getElementById('disc-run');
  btn.disabled = over;
  btn.textContent = over ? 'Over cap'
    : (data.free ? 'Run — free' : 'Run — spend up to $' + data.estimated_cost.toFixed(2));
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
function renderProfileCard(pending, running) {
  const el = document.getElementById('discover-profile');
  if (!el) return;
  if (!pending) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="subhead">Read websites</div><div class="card"><div class="queue-item good" style="padding:0;border:0;box-shadow:none">' +
    '<div class="qtext"><div class="qtitle">' + pending + ' compan' + (pending === 1 ? 'y' : 'ies') +
    ' not looked at yet</div><div class="qdetail">Free, no account needed. Sellbird reads each site for ' +
    'who their agency is, what they are missing, and whether they run ads. Up to 200 per run.</div></div>' +
    '<button class="btn btn-primary btn-sm" onclick="runProfile(this)"' + (running ? ' disabled' : '') + '>' +
    (running ? 'Busy…' : 'Read their sites') + '</button></div></div>';
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
    el.innerHTML = '<div class="card"><h2>Running…</h2>' +
      '<p class="muted" style="font-size:13px">Sellbird is working through the ' +
      'queries. Results land in Companies, and the run log is on Today.</p></div>';
    return;
  }
  if (!report) { el.innerHTML = ''; return; }

  const stat = (label, value, tone) =>
    '<div class="stat-card"><div class="label">' + label + '</div>' +
    '<div class="value"' + (tone ? ' style="color:var(--' + tone + ')"' : '') + '>' +
    value + '</div></div>';

  if (report.profiled_companies !== undefined && report.new_companies === undefined) {
    el.innerHTML = '<div class="subhead">Last run</div><div class="stats-grid">' +
      stat('Websites read', report.profiled_companies || 0, 'accent') +
      stat('Facts recorded', report.profile_observations || 0) +
      stat('Cost', 'free') + '</div>' +
      (report.stopped ? '<div class="test-result error" style="margin-top:14px">Stopped early: ' + escHtml(report.stopped) + '</div>' : '');
    return;
  }
  el.innerHTML = '<div class="subhead">Last run</div>' +
    '<div class="stats-grid">' +
      stat('New companies', report.new_companies || 0, 'accent') +
      stat('Already known', report.known_companies || 0) +
      stat('Observations', report.observations || 0) +
      stat('Filtered as junk', report.junk || 0) +
      (report.profiled_companies ? stat('Websites read', report.profiled_companies) : '') +
      stat('Actual cost', report.actual_cost ? '$' + report.actual_cost.toFixed(4) : 'free') +
    '</div>' +
    (report.stopped ? '<div class="test-result error" style="margin-top:14px">' +
      'Stopped early: ' + escHtml(report.stopped) + '</div>' : '') +
    ((report.errors || []).length
      ? '<div class="card" style="margin-top:14px"><h2>Problems</h2>' +
        (report.errors || []).slice(0, 8).map(e =>
          '<div class="check-help">' + escHtml(e) + '</div>').join('') + '</div>'
      : '');
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
    el.innerHTML = '<p class="muted" style="font-size:13px">' +
      'Confirm some signals above and they become the building blocks here.</p>';
    document.getElementById('cohort-result').innerHTML = '';
    return;
  }

  const col = (title, key, hint) =>
    '<div><div class="subhead" style="margin-top:0">' + title +
      ' <span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">' +
      hint + '</span></div><div class="cohort-grid">' +
    confirmed.map(s =>
      '<label class="cohort-pick"><input type="checkbox" ' +
        (_cohort[key].has(s.code) ? 'checked ' : '') +
        'onchange="toggleCohort(\'' + key + '\',' + jsq(s.code) + ',this.checked)">' +
        '<span>' + escHtml(s.label || s.code) + '</span>' +
        '<span class="n">' + (s.companies || 0) + '</span></label>'
    ).join('') + '</div></div>';

  // Numeric signals (ranks, ratings) take a range: "organic rank 11-30".
  const numeric = confirmed.filter(s => s.value_type === 'num');
  const bound = (code, side) => {
    const v = (_cohort.ranges[code] || {})[side];
    return '<input type="number" class="cohort-bound" placeholder="' + side + '" ' +
      'value="' + (v === undefined || v === null ? '' : escHtml(String(v))) + '" ' +
      'aria-label="' + escHtml(code) + ' ' + side + '" ' +
      'onchange="setCohortRange(' + jsq(code) + ',' + jsq(side) + ',this.value)">';
  };
  const rangeCol = numeric.length ?
    '<div style="height:18px"></div><div><div class="subhead" style="margin-top:0">In range ' +
      '<span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">' +
      '&mdash; e.g. organic rank 11 to 30; leave a side blank for no limit</span></div>' +
      '<div class="cohort-grid">' +
      numeric.map(s =>
        '<div class="cohort-pick cohort-range"><span>' + escHtml(s.label || s.code) + '</span>' +
          bound(s.code, 'min') + '<span class="muted">to</span>' + bound(s.code, 'max') + '</div>'
      ).join('') + '</div></div>' : '';

  el.innerHTML = col('Must have', 'require', '&mdash; every company in the cohort carries all of these') +
    '<div style="height:18px"></div>' +
    col('Must not have', 'exclude', '&mdash; disqualifiers') + rangeCol;
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
  el.innerHTML = '<p class="muted">Loading cohort…</p>';

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

  let html = '<div style="border-top:1px solid var(--border);margin-top:20px;padding-top:20px">' +
    '<div class="cohort-size">' + data.size + '</div>' +
    '<div class="muted" style="font-size:13px;margin-top:2px">compan' +
      (data.size === 1 ? 'y matches' : 'ies match') + ' this cohort right now</div>';

  if (data.companies && data.companies.length) {
    html += '<div class="table-card" style="margin-top:16px"><table><thead><tr>' +
      '<th>Company</th><th>Domain</th><th>Industry</th><th>Location</th>' +
      '</tr></thead><tbody>' +
      data.companies.map(c =>
        '<tr><td>' + escHtml(c.name) + '</td><td class="muted">' + escHtml(c.domain) + '</td>' +
        '<td class="muted">' + escHtml(c.industry) + '</td>' +
        '<td class="muted">' + escHtml(c.location) + '</td></tr>'
      ).join('') + '</tbody></table></div>';

    const first = data.offset + 1, last = data.offset + data.companies.length;
    const hasPrev = data.offset > 0, hasNext = last < data.size;
    html += '<div style="display:flex;align-items:center;gap:8px;margin-top:10px">' +
      '<span class="muted" style="font-size:12px">Showing ' + first + '&ndash;' + last +
        ' of ' + data.size + '</span>' +
      '<span style="flex:1"></span>' +
      '<button class="btn btn-secondary btn-sm" onclick="pageCohort(-1)"' +
        (hasPrev ? '' : ' disabled') + '>Prev</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="pageCohort(1)"' +
        (hasNext ? '' : ' disabled') + '>Next</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="exportCohort(this)">Export CSV</button>' +
      '</div>';
  } else if (data.size === 0) {
    html += '<p class="muted" style="font-size:13px;margin-top:12px">' +
      'No company carries all of those yet. Either loosen the cohort, or run ' +
      'prospecting to collect more.</p>';
  } else if (_cohortOffset > 0) {
    // The cohort shrank under us (a re-profile, a delete): back to page one.
    _cohortOffset = 0;
    return runCohort();
  }
  el.innerHTML = html + '</div>';
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

function renderDesk(items, i) {
  const cur = items[i];
  const rail = items.map((it, n) => {
    const who = it.context && it.context.contact ? it.context.contact : it.to_email;
    const parts = String(who || '').split(/[\s@.]+/);
    return '<div class="desk-item ' + (n === i ? 'active' : '') + '" onclick="deskGo(' + n + ')">' +
      '<span class="avatar">' + initials(parts[0], parts[1]) + '</span>' +
      '<div class="di-text"><div class="to">' + escHtml(who) +
        (heldReason(it) ? ' <span class="tag t-bad" title="Sellbird held this instead of sending it">Held</span>' : '') +
        '</div>' +
      '<div class="sub">' + escHtml(it.subject || '(no subject)') + '</div></div>' +
    '</div>';
  }).join('');

  const editing = _desk.editing === cur.id;
  const unsaved = (editing && _desk.unsaved) || {subject: cur.subject || '', body: cur.body || ''};
  // A reply keeps its subject: Gmail threads by it.
  const fixedSubject = cur.kind === 'reply'
    ? ' readonly title="A reply keeps its subject so it stays in the thread"' : '';
  const draft = editing
    ? '<input id="desk-subject" class="desk-edit-subject" value="' + escHtml(unsaved.subject) + '"' +
        fixedSubject + ' oninput="deskKeep()">' +
      '<textarea id="desk-body" class="desk-edit-body" rows="14" oninput="deskKeep()">' +
        escHtml(unsaved.body) + '</textarea>'
    : '<div class="subject">' + escHtml(cur.subject || '(no subject)') + '</div>' +
      '<div class="body">' + escHtml(cur.body) + '</div>';
  // Cold email leaves with the footer underneath; show it as it will go out.
  // Not added again when the body already ends with it, as in the Sender.
  const added = cur.kind === 'sequence' && !(cur.body || '').trimEnd().endsWith(_desk.footer)
    ? _desk.footer : '';
  const footer = added
    ? '<div class="desk-footer" title="Added when it sends (compliance in sellbird.yaml)">' +
        escHtml(added) + '</div>' : '';
  const actions = editing
    ? '<button class="btn btn-primary" onclick="deskSave(' + jsq(cur.id) + ')">Save</button>' +
      '<button class="btn btn-secondary" onclick="deskEdit(null)">Cancel</button>'
    : '<button class="btn btn-primary" onclick="outboxAct(' + jsq(cur.id) + ',\'approve\')">' +
        'Approve <kbd>A</kbd></button>' +
      '<button class="btn btn-secondary" onclick="deskEdit(' + jsq(cur.id) + ')">' +
        'Edit <kbd>E</kbd></button>' +
      '<button class="btn btn-secondary" onclick="outboxAct(' + jsq(cur.id) + ',\'reject\')">' +
        'Reject <kbd>R</kbd></button>';

  return '<div class="desk">' +
    '<div class="desk-list">' + rail + '</div>' +
    '<div class="desk-pane">' +
      '<div class="to-line">To <b>' + escHtml(cur.to_email) + '</b>' +
        '<span class="tag">' + (cur.kind === 'reply' ? 'Reply' : 'Email ' + escHtml(String(cur.step))) + '</span>' +
        '<span class="muted">sends ' + formatDate(cur.send_at) + '</span></div>' +
      renderDeskContext(cur.context) +
      (heldReason(cur)
        ? '<div class="banner wait desk-held">' + icon('alert') + '<div><b>Sellbird held this instead of sending it</b>' +
          '<div>' + escHtml(heldReason(cur)) + '. Read it before approving: text from a website or an ' +
          'email can try to steer what Sellbird writes.</div></div></div>'
        : '') +
      draft + footer +
      '<div class="desk-actions">' + actions +
        '<span class="muted" style="font-size:12px;margin-left:auto">' +
          (i + 1) + ' of ' + items.length + '</span>' +
      '</div>' +
    '</div></div>';
}

function deskEdit(id) {
  _desk.editing = id;
  _desk.unsaved = null;
  document.getElementById('outbox-desk').innerHTML = renderDesk(_desk.items, _desk.i);
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

function deskGo(n) {
  if (n < 0 || n >= _desk.items.length || deskBusy()) return;
  _desk.i = n;
  document.getElementById('outbox-desk').innerHTML = renderDesk(_desk.items, n);
}

// Keyboard review. Ignored while typing into a field, so Settings still works.
document.addEventListener('keydown', e => {
  if (currentTab !== 'outbox' || e.metaKey || e.ctrlKey || e.altKey) return;
  // Mid-edit, A would approve the stored draft, not what's typed. Only
  // Escape (cancel) works until the edit is saved or cancelled.
  if (_desk.editing) {
    const typing = /^(input|textarea)$/i.test(e.target.tagName || '');
    if (e.key === 'Escape') { e.preventDefault(); deskEdit(null); }
    else if (!typing && 'jkare'.includes(e.key.toLowerCase())) { e.preventDefault(); deskBusy(); }
    return;
  }
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  const cur = _desk.items[_desk.i];
  const k = e.key.toLowerCase();
  if (k === 'j') { e.preventDefault(); deskGo(_desk.i + 1); }
  else if (k === 'k') { e.preventDefault(); deskGo(_desk.i - 1); }
  else if (k === 'a' && cur) { e.preventDefault(); outboxAct(cur.id, 'approve'); }
  else if (k === 'r' && cur) { e.preventDefault(); outboxAct(cur.id, 'reject'); }
  else if (k === 'e' && cur) { e.preventDefault(); deskEdit(cur.id); }
});

async function outboxAct(id, action) {
  if (deskBusy()) return;
  const data = await api('/api/outbox/' + encodeURIComponent(id) + '/' + action, {method: 'POST'});
  if (data && data.success) showToast(action === 'approve' ? 'Approved — will send on schedule.' : 'Rejected.', 'success');
  else showToast(failMsg(data, 'Action failed.'), 'error');
  loadOutbox();
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

const COMPANIES_PER_PAGE = 50;
let _companiesPage = 0;

async function loadCompanies() {
  companyDrill = false;
  const el = document.getElementById('companies-list');
  const data = await api('/api/companies');
  if (!data) { el.innerHTML = offlineState(); return; }
  _companies = data;
  if (!data.length) {
    el.innerHTML = emptyState(icon('companies'), 'No companies yet',
      'Confirm your <b>Signals</b>, then find businesses on the <b>Discover</b> tab. ' +
      'OpenStreetMap is free and needs no account.');
    return;
  }
  renderCompaniesPage(_companiesPage);
}

function renderCompaniesPage(page) {
  const el = document.getElementById('companies-list');
  const data = _companies;
  const pages = Math.max(1, Math.ceil(data.length / COMPANIES_PER_PAGE));
  _companiesPage = Math.min(Math.max(0, page), pages - 1);
  const start = _companiesPage * COMPANIES_PER_PAGE;
  let html = '<div class="table-card"><table class="nowrap"><thead><tr><th>Company</th>' +
    '<th title="Company fit, 0-100: sector, decision maker, reachability, buying signal. Hover a score for why.">Fit</th>' +
    '<th title="Hover a status for why the company was or wasn\'t contacted">Status</th>' +
    '<th>Industry</th><th>Location</th><th class="num">Contacts</th><th>Added</th></tr></thead><tbody>';
  data.slice(start, start + COMPANIES_PER_PAGE).forEach((c, j) => {
    const i = start + j;
    const website = c.website || (c.domain ? 'https://' + c.domain : '');
    const domain = safeHref(website)
      ? '<a href="' + safeHref(website) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">' +
        escHtml(c.domain || website.replace(/^https?:\/\//i, '')) + '</a>'
      : escHtml(c.domain);
    html += '<tr class="clickable" onclick="showCompanyContacts(' + i + ')">' +
      '<td><div class="cell-stack"><span class="cell-main">' + escHtml(c.name) + '</span>' +
        '<span class="cell-sub">' + domain + '</span></div></td>' +
      '<td title="' + escHtml((c.fit_reasons || []).join(' · ')) + '">' +
        (typeof c.fit === 'number' ? meterHtml(c.fit) : '') + '</td>' +
      '<td title="' + escHtml(c.register_why || '') + '">' + escHtml(c.register_status || '') + '</td>' +
      '<td>' + (c.industry ? '<span class="tag">' + escHtml(c.industry) + '</span>' : '') + '</td>' +
      '<td>' + escHtml(c.location) + '</td>' +
      '<td class="num">' + (c.contact_count || 0) + '</td>' +
      '<td class="muted">' + relTime(c.created_at) + '</td></tr>';
  });
  const pager = pages > 1
    ? ' &nbsp; <button class="btn btn-ghost btn-sm" ' + (_companiesPage === 0 ? 'disabled ' : '') +
        'onclick="renderCompaniesPage(' + (_companiesPage - 1) + ')">&larr; Prev</button> ' +
      'Page ' + (_companiesPage + 1) + ' of ' + pages +
      ' <button class="btn btn-ghost btn-sm" ' + (_companiesPage >= pages - 1 ? 'disabled ' : '') +
        'onclick="renderCompaniesPage(' + (_companiesPage + 1) + ')">Next &rarr;</button>'
    : '';
  el.innerHTML = html + '</tbody></table></div>' +
    '<div class="table-foot">' + (start + 1) + '–' + Math.min(start + COMPANIES_PER_PAGE, data.length) +
    ' of ' + data.length + ' compan' + (data.length === 1 ? 'y' : 'ies') + pager + '</div>';
}

// Basic facts about one company, above its contacts: where it came from,
// why it fits, what's been done, and what Sellbird saw on its own site.
function companyInfoCard(company, profile) {
  const c = (profile && profile.company) || company;
  const reg = (profile && profile.register) || {};
  const obs = (profile && profile.observations) || [];
  const link = (url, text) => safeHref(url)
    ? '<a href="' + safeHref(url) + '" target="_blank" rel="noopener noreferrer">' + escHtml(text || url) + '</a>'
    : escHtml(text || url || '');
  const website = c.website || (c.domain ? 'https://' + c.domain : '');
  const row = (k, v) => v ? '<tr><td class="muted" style="width:170px;vertical-align:top">' + k +
    '</td><td style="white-space:normal">' + v + '</td></tr>' : '';
  const latest = {};
  for (const o of obs) {
    const key = o.signal_code + '|' + (o.value_text || o.value_num);
    if (!latest[key] && (o.value_text || o.value_num !== null)) latest[key] = o;
  }
  const by = code => Object.values(latest).filter(o => o.signal_code === code);
  const list = (items, max) => items.slice(0, max).map(o =>
    (o.evidence_url ? link(o.evidence_url, o.value_text || String(o.value_num)) : escHtml(o.value_text || String(o.value_num)))
  ).join('<br>');
  const people = by('DECISION_MAKER_TITLE').length ? by('DECISION_MAKER_TITLE') : by('CONTACT_FOUND');
  const form = by('CONTACT_FORM_URL')[0];
  const shown = new Set(['DECISION_MAKER_TITLE', 'CONTACT_FOUND', 'CONTACT_FORM_URL', 'HIRING_ROLE', 'FOUND_IN_SERP', 'TECH_STACK']);
  const other = Object.values(latest).filter(o => !shown.has(o.signal_code));
  let html = '<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>' + escHtml(c.name || c.domain) + '</h3>' +
    '<span class="meta">' + (typeof company.fit === 'number' ? 'Fit ' + company.fit + ' / 100' : '') + '</span></div>' +
    '<table><tbody>' +
    row('Website', link(website, c.domain || website)) +
    row('Sector', escHtml(c.industry)) +
    row('Area', escHtml(c.location)) +
    row('Why selected', escHtml(reg.why_selected || (company.fit_reasons || []).join(' · '))) +
    row('Status', '<b>' + escHtml(reg.status || company.register_status || '') + '</b>' +
      (reg.why_not_contacted || company.register_why ? ' — ' + escHtml(reg.why_not_contacted || company.register_why) : '')) +
    row('People named on site', list(people, 8)) +
    row('Contact form', form ? link(form.value_text, form.value_text) : '') +
    row('Hiring', list(by('HIRING_ROLE'), 6)) +
    row('Tech on website', escHtml(by('TECH_STACK').map(o => o.value_text).slice(0, 1).join(''))) +
    row('Other signals', other.slice(0, 8).map(o => escHtml(o.label) + ': ' +
      escHtml(o.value_text || String(o.value_num))).join('<br>')) +
    row('Found via', c.source_url ? link(c.source_url, 'search result') + ' · ' + escHtml(c.source || '') : escHtml(c.source || '')) +
    row('First found', escHtml((c.created_at || '').slice(0, 10))) +
    '</tbody></table></div>';
  return html;
}

async function showCompanyContacts(index) {
  const company = _companies[index];
  if (!company) return;
  companyDrill = true;
  const el = document.getElementById('companies-list');
  const [data, profile] = await Promise.all([
    api('/api/companies/' + encodeURIComponent(company.id) + '/contacts'),
    api('/api/companies/' + encodeURIComponent(company.id) + '/profile'),
  ]);
  let html = '<button class="btn btn-ghost btn-sm" onclick="loadCompanies()" style="margin-bottom:12px">' +
    '&larr; All companies</button>' + companyInfoCard(company, profile) +
    '<div class="card flush"><div class="card-head"><h3>Contacts</h3>' +
    '<span class="meta">' + escHtml([company.industry, company.location].filter(Boolean).join(' · ')) + '</span></div>';
  if (!data || !data.length) {
    html += '<div class="empty"><div class="copy">No contacts found at this company yet.</div></div></div>';
  } else {
    html += '<table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>LinkedIn</th><th>Status</th><th>Source</th></tr></thead><tbody>';
    for (const p of data) {
      const phoneIcon = p.phone_verified ? ' <span class="muted">&#10003;</span>' : '';
      html += '<tr><td><div class="cell-row"><span class="avatar">' + initials(p.first_name, p.last_name) + '</span>' +
          '<div class="cell-stack"><span class="cell-main">' + escHtml(p.first_name) + ' ' + escHtml(p.last_name) + '</span>' +
          '<span class="cell-sub">' + escHtml(p.title) + '</span></div></div></td>' +
        '<td>' + escHtml(p.email) + emailTag(p) + '</td>' +
        '<td>' + escHtml(p.phone) + phoneIcon + '</td>' +
        '<td>' + (safeHref(p.linkedin_url) ? '<a href="' + safeHref(p.linkedin_url) + '" target="_blank" rel="noopener noreferrer">Profile</a>' : '') + '</td>' +
        '<td>' + badge(p.status) + '</td><td class="muted">' + sourceLabel(p.source) + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  el.innerHTML = html;
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
const CONTACT_FILTERS = [
  ['all', 'All', null],
  ['todo', 'To write', ['new', 'queued']],
  ['contacted', 'Contacted', ['contacted']],
  ['replied', 'Replied', ['replied', 'interested', 'meeting']],
  ['closed', 'Closed out', null],
];

async function loadProspects() {
  const el = document.getElementById('prospects-table');
  const data = await api('/api/prospects');
  if (!data) { el.innerHTML = offlineState(); return; }
  _prospects = data;
  if (!data.length) {
    el.innerHTML = emptyState(icon('contacts'), 'No contacts yet',
      'Sellbird hasn\'t found any prospects. Once it\'s running, the Scout agent searches the web for people matching your ideal customer profile in <b>sellbird.yaml</b>.');
    return;
  }
  if (!document.getElementById('contact-rows')) {
    el.innerHTML = '<div class="toolbar">' +
      '<label class="search">' + icon('discover') +
        '<input class="form-input" id="contact-search" type="search" placeholder="Search name, company, email" ' +
        'aria-label="Search contacts" oninput="_contactQuery=this.value;renderContacts()"></label>' +
      '<div class="segmented" id="contact-filters" role="group" aria-label="Filter by status"></div>' +
      '</div><div id="contact-rows"></div>';
    // A rebuild after an offline blip must show the search still applied.
    document.getElementById('contact-search').value = _contactQuery;
  }
  renderContacts();
}

function contactMatches(p, f) {
  const known = ['new', 'queued', 'contacted', 'replied', 'interested', 'meeting'];
  if (f === 'all') return true;
  if (f === 'closed') return !known.includes(p.status);
  const hit = CONTACT_FILTERS.find(x => x[0] === f);
  return !!(hit && hit[2] && hit[2].includes(p.status));
}

function setContactFilter(f) { _contactFilter = f; renderContacts(); }

function renderContacts() {
  const rowsEl = document.getElementById('contact-rows');
  const filtersEl = document.getElementById('contact-filters');
  if (!rowsEl) return;
  const q = _contactQuery.trim().toLowerCase();
  const found = p => !q || [p.first_name, p.last_name, p.company, p.email, p.title].join(' ').toLowerCase().includes(q);
  filtersEl.innerHTML = CONTACT_FILTERS.map(f =>
    '<button class="' + (f[0] === _contactFilter ? 'on' : '') + '" aria-pressed="' + (f[0] === _contactFilter) + '" onclick="setContactFilter(\'' + f[0] + '\')">' +
      f[1] + ' <span class="n">' + _prospects.filter(p => contactMatches(p, f[0]) && found(p)).length + '</span></button>'
  ).join('');

  const rows = _prospects.map((p, i) => [p, i]).filter(([p]) => contactMatches(p, _contactFilter) && found(p));
  if (!rows.length) {
    rowsEl.innerHTML = '<div class="table-card">' + emptyState(icon('discover'), 'No matches',
      'Nothing matches that search and filter.') + '</div>';
    return;
  }
  let html = '<div class="table-card"><table class="nowrap"><thead><tr><th>Name</th><th>Company</th><th>Email</th>' +
    '<th>Score</th><th>Status</th><th>Source</th><th>Added</th><th></th></tr></thead><tbody>';
  for (const [p, i] of rows) {
    html += '<tr><td><div class="cell-row"><span class="avatar">' + initials(p.first_name, p.last_name) + '</span>' +
        '<div class="cell-stack"><span class="cell-main">' + escHtml(p.first_name) + ' ' + escHtml(p.last_name) + '</span>' +
        '<span class="cell-sub">' + escHtml(p.title) + '</span></div></div></td>' +
      '<td>' + escHtml(p.company) + '</td>' +
      '<td><div class="cell-stack"><span>' + escHtml(p.email) + '</span>' +
        '<span class="cell-sub">' + [emailTag(p).trim(), p.phone ? escHtml(p.phone) +
          (p.phone_verified ? ' <span class="verified" title="Phone verified">&#10003;</span>' : '') : '']
          .filter(Boolean).join(' · ') + '</span>' +
        '</div></td>' +
      '<td>' + (p.score || p.score === 0 ? meterHtml(p.score) : '') + '</td>' +
      '<td>' + badge(p.status) + '</td>' +
      '<td class="muted">' + sourceLabel(p.source) + '</td>' +
      '<td class="muted" style="white-space:nowrap">' + relTime(p.created_at) + '</td>' +
      '<td><div class="cell-row">' + (p.status === 'opted_out' || p.opt_out_undone || _optOut.id === p.id
        ? '<button class="btn btn-ghost btn-sm" onclick="toggleOptOut(' + i + ')" ' +
          'aria-expanded="' + (_optOut.id === p.id) + '" title="What made Sellbird stop emailing them">' +
          (p.status === 'opted_out' ? 'Why?' : 'Opt-out history') + '</button>' : '') +
        '<button class="btn btn-ghost btn-sm row-action" onclick="fbProspect(' + i + ')" ' +
        'title="Leave feedback on this contact">Feedback</button></div></td></tr>';
    if (_optOut.id === p.id) html += '<tr class="detail-row"><td colspan="8">' + optOutPanel(p) + '</td></tr>';
  }
  rowsEl.innerHTML = html + '</tbody></table></div>' +
    '<div class="table-foot">' + rows.length + ' of ' + _prospects.length + ' contacts</div>';
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
  if (!data.length) {
    el.innerHTML = emptyState(icon('campaigns'), 'No campaigns yet',
      'The Writer agent hasn\'t drafted any sequences. It kicks in automatically once Sellbird has scored prospects to write for.');
    return;
  }
  let html = '';
  data.forEach((c, i) => {
    let stepsHtml = '';
    (c.sequence || []).forEach((step, s) => {
      const sendBtns = (c.recipients || []).map((r, ri) => {
        // Only offered when Sellbird can't send itself and this person can
        // still be emailed (the server decides: can_send_by_hand).
        if (r.sent_by_hand) {
          const tick = '<label style="display:inline-flex;align-items:center;gap:4px;font-size:13px;cursor:pointer">' +
            '<input type="checkbox" checked onchange="markSent(' + i + ',' + ri + ',this.checked)"> ' +
            '&#10003; Sent by you</label>';
          if (s === 0) return '<span class="rcpt-who">' + escHtml(r.email) + '</span>' + tick;
          // Follow-ups are the user's too: Sellbird never emails someone they emailed.
          return '<span class="rcpt-who">' + escHtml(r.email) + '</span>' +
            '<button class="btn btn-secondary btn-sm" onclick="openInGmail(' + i + ',' + s + ',' + ri + ')">' +
            'Open in Gmail</button>' +
            '<span class="muted" style="font-size:12px">Sellbird won\'t send follow-ups to people you emailed yourself.</span>';
        }
        if (s !== 0) return '';
        if (!r.can_send_by_hand) {
          // Sellbird sends here; this only records an email the user already sent.
          return r.can_mark_sent
            ? '<label class="muted" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">' +
              '<input type="checkbox" onchange="markSent(' + i + ',' + ri + ',this.checked)"> ' +
              'I already emailed ' + escHtml(r.email) + ' myself</label>'
            : '';
        }
        const risky = r.email_status === 'risky'
          ? ' <span class="mini t-waiting">Catch-all, may bounce</span>' : '';
        return '<span class="rcpt-who">' + escHtml(r.email) + risky + '</span>' +
          '<button class="btn btn-secondary btn-sm" onclick="openInGmail(' + i + ',' + s + ',' + ri + ')">' +
          'Open in Gmail</button>' +
          '<label><input type="checkbox" onchange="markSent(' + i + ',' + ri + ',this.checked)"> Mark as sent</label>'
      }).filter(Boolean).map(x => '<div class="rcpt">' + x + '</div>').join('');
      stepsHtml += '<div class="email-step"><span class="step-dot">' + escHtml(String(step.step || '?')) + '</span>' +
        '<div><div class="step-num">' + (s === 0 ? 'First email' : 'Follow-up') +
        (step.delay_days ? ' &middot; ' + escHtml(String(step.delay_days)) + ' days after the last' : '') + '</div>' +
        '<div class="subject">' + escHtml(step.subject) + '</div>' +
        '<div class="body">' + escHtml(step.body) + '</div>' +
        (sendBtns ? '<div class="step-actions">' + sendBtns + '</div>' : '') +
        '</div></div>';
    });
    const pc = (c.prospect_ids || []).length;
    html += '<div class="campaign-card"><div class="campaign-top">' +
      '<div class="campaign-title"><h3>' + escHtml(c.name || 'Untitled Campaign') + '</h3>' +
        '<button class="btn btn-ghost btn-sm" onclick="fbCampaign(' + i + ')">Feedback</button></div>' +
      '<div class="meta">' + badge(c.status) + '<span>' + pc + ' prospect' + (pc !== 1 ? 's' : '') + '</span>' +
        '<span>' + (c.sequence || []).length + ' emails</span><span>Created ' + relTime(c.created_at) + '</span></div>' +
      campaignProgress(c) + '</div>' +
      '<div class="sequence">' +
      (stepsHtml || '<p class="muted" style="font-size:13px;padding-top:16px">No email steps in this campaign.</p>') + '</div></div>';
  });
  el.innerHTML = html;
}

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

const INBOX_STATE = {
  sending: ['Sending', 't-good'],
  paused: ['Paused', 't-waiting'],
  not_connected: ['Not connected', 't-bad'],
};
const INBOX_KINDS = {
  gmail: ['Gmail', 'Google Workspace or Gmail. Sign in with Google in your browser.'],
  microsoft: ['Microsoft 365', 'Outlook or Microsoft 365. Sign in with Microsoft in your browser.'],
  smtp: ['Other (SMTP)', 'Any other email host, with its SMTP server and password.'],
};
let _inboxes = null;
let _inboxPoll = null;

function inboxBadge(ib) {
  const [label, tone] = INBOX_STATE[ib.state] || [ib.state, 't-idle'];
  return '<span class="badge ' + tone + '">' + escHtml(label) + '</span>';
}

function inboxMeter(ib) {
  const cap = Math.max(1, Number(ib.cold_cap) || 0);
  const sent = Number(ib.cold_sent_today) || 0;
  const pct = Math.min(100, Math.round(sent / cap * 100));
  return '<div class="inbox-meter"><div class="line"><span>Cold emails today</span><span>' +
    sent + ' / ' + Number(ib.cold_cap) + '</span></div>' +
    '<div class="progress-bar"><div class="progress-fill ' + (pct >= 100 ? 'yellow' : 'green') +
    '" style="width:' + pct + '%"></div></div></div>';
}

function inboxDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
}

async function loadInboxes() {
  const el = document.getElementById('inboxes-list');
  const actions = document.getElementById('inboxes-actions');
  const data = await api('/api/inboxes');
  if (!data) { el.innerHTML = offlineState(); return; }
  _inboxes = data;
  if (!data.native) {
    actions.innerHTML = '';
    el.innerHTML = emptyState(icon('inboxes'), 'Instantly sends for you',
      'Sending through several of your own inboxes works with Gmail, Microsoft 365 or SMTP. ' +
      'Set channels.email.provider in sellbird.yaml to one of those to use it.');
    return;
  }
  actions.innerHTML = '<button class="btn btn-primary" onclick="openAddInbox()">' + icon('plus') +
    'Add inbox</button>';

  let html = '';
  if (data.sending_paused) {
    html += '<div class="notice wait"><b>All sending is paused:</b> ' + escHtml(data.sending_paused) +
      '. Resume it on the Outbox tab.</div>';
  }
  const list = data.inboxes || [];
  const sending = list.filter(i => i.state === 'sending');
  const capToday = sending.reduce((n, i) => n + (Number(i.cold_cap) || 0), 0);
  const sentToday = list.reduce((n, i) => n + (Number(i.cold_sent_today) || 0), 0);
  const waiting = list.reduce((n, i) => n + (Number(i.first_emails_waiting) || 0), 0);
  html += '<div class="inbox-summary">' +
    '<span><b>' + list.length + '</b> ' + (list.length === 1 ? 'inbox' : 'inboxes') + ', <b>' + sending.length + '</b> sending</span>' +
    '<span><b>' + sentToday + '</b>' + (capToday ? ' of <b>' + Math.min(capToday, Number(data.max_daily_sends)) + '</b>' : '') + ' cold emails sent today</span>' +
    '<span><b>' + waiting + '</b> first emails waiting to go</span></div>';

  html += '<div class="inbox-list">';
  list.forEach((ib, i) => {
    const letter = (ib.address || '?').charAt(0).toUpperCase();
    const sub = [ib.name, ib.main ? 'Main mailbox' : (INBOX_KINDS[ib.provider === 'google' ? 'gmail' : ib.provider] || [ib.provider])[0]]
      .filter(Boolean).join(' · ');
    html += '<button class="inbox-row" onclick="openInbox(' + i + ')" aria-label="Open ' + escHtml(ib.address || 'main mailbox') + '">' +
      '<span class="inbox-avatar" aria-hidden="true">' + escHtml(letter) + '</span>' +
      '<span class="inbox-who"><div class="addr">' + escHtml(ib.address || '(main mailbox)') + '</div>' +
      '<div class="sub">' + escHtml(sub) + '</div></span>' +
      inboxBadge(ib) + inboxMeter(ib) +
      '<span class="inbox-waiting"><b>' + Number(ib.first_emails_waiting) + '</b>waiting</span>' +
      icon('chevron', 'chev') + '</button>';
  });
  html += '</div>';

  if (!data.several) {
    html += '<div class="card"><div class="card-title">Why add another inbox?</div><div class="inbox-help">' +
      '<div class="inset"><h4>Send more each day</h4><p>Each inbox sends up to ' + Number(data.per_inbox_daily_cap) +
      ' cold emails a day. Two inboxes, twice as many, all under your daily total of ' + Number(data.max_daily_sends) + '.</p></div>' +
      '<div class="inset"><h4>Protect your main address</h4><p>Send cold email from a second domain, so a bad week never touches your everyday mail.</p></div>' +
      '<div class="inset"><h4>Pick per campaign</h4><p>Choose which inboxes each campaign sends from. Replies always come back to the inbox that started the thread.</p></div>' +
      '</div><div class="btn-group"><button class="btn btn-secondary" onclick="openAddInbox()">' + icon('plus') + 'Add inbox</button></div></div>';
  }
  el.innerHTML = html;
}

// The dialog: one inbox's detail, or adding one.

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

function openInbox(i) {
  const ib = (_inboxes && _inboxes.inboxes || [])[i];
  if (!ib) return;
  const campaigns = (_inboxes.campaigns || []);
  const pools = _inboxes.pools || {};
  const using = campaigns.filter(c => (pools[c.id] || []).includes(ib.id));
  const everyInbox = campaigns.filter(c => !pools[c.id]);
  let body = '';
  if (ib.state === 'not_connected') {
    body += '<div class="notice bad"><b>Not connected.</b> ' +
      escHtml(ib.connect_hint || 'Sellbird can\'t sign in to it from this computer. Check the connection to see why, or remove it and add it again.') + '</div>';
  }
  if (ib.paused_reason) {
    body += '<div class="notice wait"><b>Paused:</b> ' + escHtml(ib.paused_reason) + '</div>';
  }
  body += '<div class="modal-stats">' +
    '<div class="inset"><div class="k">Cold today</div><div class="v">' + Number(ib.cold_sent_today) + ' / ' + Number(ib.cold_cap) + '</div></div>' +
    '<div class="inset"><div class="k">First emails waiting</div><div class="v">' + Number(ib.first_emails_waiting) + '</div></div>' +
    '<div class="inset"><div class="k">Warming up since</div><div class="v">' + (ib.warmup_started_at ? escHtml(inboxDate(ib.warmup_started_at)) : '<span class="muted">Established</span>') + '</div></div>' +
    '</div>';
  body += '<div class="modal-section"><h4>Campaigns sending from it</h4>';
  if (!campaigns.length) body += '<p>No campaigns yet.</p>';
  else {
    const names = using.concat(everyInbox).map(c => escHtml(c.name || 'Untitled'));
    const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ', and ' + (names.length - 6) + ' more' : '');
    body += names.length ? '<p>' + shown + '</p>' : '<p>None. Every campaign has chosen other inboxes.</p>';
    if (everyInbox.length) body += '<p class="form-hint">Campaigns that haven\'t chosen inboxes send from all of them.</p>';
  }
  body += '</div>';

  if (ib.main) {
    const kind = ib.provider === 'gmail' || ib.provider === 'microsoft' ? ib.provider : '';
    if (ib.state === 'not_connected' && kind) {
      const can = (_inboxes.can_connect || {})[kind];
      body = '<div id="main-status"></div>' + (can
        ? '<div class="notice bad"><b>Not connected.</b> Sign in to the mailbox Sellbird sends from.</div>' +
          '<button class="btn btn-primary" id="main-go" onclick="connectMainMailbox(\'' + kind + '\')">Sign in with ' +
          (kind === 'gmail' ? 'Google' : 'Microsoft') + '</button><div style="height:16px"></div>'
        : connectSetupNotice(kind)) + body.replace(/<div class="notice bad"><b>Not connected.<\/b>[\s\S]*?<\/div>/, '');
    }
    body += '<div class="modal-section"><h4>Settings</h4><p>Your main mailbox comes from sellbird.yaml: ' +
      'its address is persona.email, its daily cap is channels.email.per_inbox_daily_cap, and pausing it pauses ' +
      'all sending, on the Outbox tab.</p></div>';
    inboxDialog(inboxDialogHead(escHtml(ib.address || 'Main mailbox'), inboxBadge(ib) + ' Main mailbox') +
      '<div class="modal-body">' + body + '</div>');
    return;
  }
  const id = jsq(ib.id);
  body += '<div class="modal-section"><h4>Daily cold-email cap</h4>' +
    '<div class="inline-edit"><input class="form-input" id="ib-cap" type="number" min="1" max="500" inputmode="numeric" placeholder="Default (' +
    Number(_inboxes.per_inbox_daily_cap) + ')" value="' + (ib.cap_is_yours ? Number(ib.cold_cap) : '') + '">' +
    '<button class="btn btn-secondary" onclick="saveInboxCap(' + id + ')">Save</button></div>' +
    '<div class="form-hint">Leave empty for the default. Warming inboxes start lower on their own.</div></div>';
  body += '<div class="modal-section"><h4>Sender name</h4>' +
    '<div class="inline-edit"><input class="form-input" id="ib-name" maxlength="100" placeholder="Your persona name" value="' + escHtml(ib.name || '') + '">' +
    '<button class="btn btn-secondary" onclick="saveInboxName(' + id + ')">Save</button></div>' +
    '<div class="form-hint">The name people see in From.</div></div>';
  body += '<div class="modal-section"><h4>Remove this inbox</h4><p>Sellbird stops sending from it, and threads it started end. Its sign-in stays in your keychain.</p>' +
    '<div class="inline-edit" style="margin-top:8px"><input class="form-input" id="ib-confirm" placeholder="Type ' + escHtml(ib.address) + ' to confirm">' +
    '<button class="btn btn-danger" onclick="removeInbox(' + id + ')">Remove</button></div></div>';

  const pauseBtn = ib.paused_reason
    ? '<button class="btn btn-primary" onclick="inboxAction(' + id + ',\'resume\')">Resume sending</button>'
    : '<button class="btn btn-secondary" onclick="inboxAction(' + id + ',\'pause\')"' + (ib.state === 'not_connected' ? ' disabled' : '') + '>Pause</button>';
  inboxDialog(inboxDialogHead(escHtml(ib.address), inboxBadge(ib) + ' ' + escHtml(ib.name || '')) +
    '<div class="modal-body">' + body + '</div>' +
    '<div class="modal-foot"><button class="btn btn-ghost" onclick="testInbox(' + id + ')">Check connection</button>' + pauseBtn + '</div>');
}

async function inboxPost(path, body, done, keepOpen) {
  const r = await api(path, {method: 'POST', headers: {'Content-Type': 'application/json'},
                             body: JSON.stringify(body || {})});
  if (r && r.success) {
    if (done) showToast(done, 'success');
    if (!keepOpen) closeInboxDialog();
    loadInboxes();
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
  if (_inboxPoll) clearInterval(_inboxPoll);
  _inboxPoll = setInterval(async () => {
    const s = await api('/api/inboxes/connect/status');
    if (!s || s.state === 'waiting') return;
    clearInterval(_inboxPoll); _inboxPoll = null;
    if (s.state === 'connected') {
      showToast('Main mailbox connected', 'success');
      closeInboxDialog(); loadInboxes();
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
    closeInboxDialog(); loadInboxes();
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
      closeInboxDialog(); loadInboxes();
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
function exportActivity() {
  const rows = activityRows(_activity, _actFilter);
  if (!rows.length) { showToast('Nothing to export.', 'error'); return; }
  const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
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

let _company = null;
let _offerIdeas = [];

function ce(t) {
  const d = document.createElement('div');
  d.textContent = t == null ? '' : String(t);
  return d.innerHTML;
}

function lines(list) { return (list || []).join('\n'); }
function splitLines(text) { return String(text || '').split('\n').map(x => x.trim()).filter(Boolean); }

async function loadCompany() {
  const body = document.getElementById('company-body');
  const data = await api('/api/company');
  if (!data) { body.innerHTML = offlineState(); return; }
  if (data.error) { body.innerHTML = `<p class="desc">${ce(data.error)}</p>`; return; }
  _company = data;
  const o = data.offer || {}, p = data.product || {}, icp = data.icp || {}, s = data.persona || {};
  const objections = Object.entries(p.objection_responses || {});
  body.innerHTML = `
  <section class="card company-card" aria-labelledby="co-offer-h">
    <div class="company-card-head">
      <h3 id="co-offer-h">Your offer</h3>
      <span class="hint">What every first email ends by offering</span>
    </div>
    ${o.proposed ? `<div class="offer-proposed">
      <div><span class="tag accent">Your agent proposed</span></div>
      <p class="offer-proposed-text">${ce(o.proposed.entry)}</p>
      ${o.proposed.why ? `<p class="desc">${ce(o.proposed.why)}</p>` : ''}
      <div class="offer-actions">
        <button class="btn btn-primary btn-sm" onclick="useProposedOffer()">Use this offer</button>
        <button class="btn btn-secondary btn-sm" onclick="dismissProposedOffer()">Dismiss</button>
      </div>
    </div>` : ''}
    <p class="desc">Each first email names something Sellbird found about the prospect, says what it costs them, and offers this as the fix. Make it free, specific, and something you can deliver this week. ${o.entry ? '' : '<b>No offer yet</b>, so first emails end with a question instead. '}The easiest way to work it out is to ask your coding agent: <i>"Help me work out my Sellbird offer."</i></p>
    <div class="form-group"><label class="form-label" for="offer-entry">Offer</label>
      <textarea class="form-input" id="offer-entry" rows="2" maxlength="300" placeholder="e.g. a written plan for getting you onto page one of Google">${ce(o.entry || '')}</textarea></div>
    <div class="offer-actions">
      <button class="btn btn-primary btn-sm" onclick="saveOffer()">Save offer</button>
      <button class="btn btn-secondary btn-sm" id="offer-preview-btn" onclick="previewOffer()">Preview an email</button>
      <button class="btn btn-secondary btn-sm" id="offer-suggest-btn" onclick="suggestOffers()">Suggest ideas</button>
    </div>
    <div id="offer-preview" class="offer-preview" hidden></div>
    <div id="offer-ideas" class="offer-ideas"></div>
  </section>

  <section class="card company-card" aria-labelledby="co-product-h">
    <div class="company-card-head"><h3 id="co-product-h">What you sell</h3></div>
    <div class="company-grid">
      <div class="form-group"><label class="form-label" for="co-p-name">Product or service</label>
        <input class="form-input" id="co-p-name" value="${ce(p.name)}"></div>
      <div class="form-group"><label class="form-label" for="co-p-pricing">Pricing</label>
        <input class="form-input" id="co-p-pricing" value="${ce(p.pricing)}"></div>
    </div>
    <div class="form-group"><label class="form-label" for="co-p-desc">What it is and who it's for</label>
      <textarea class="form-input" id="co-p-desc" rows="3">${ce(p.description)}</textarea></div>
    <div class="form-group"><label class="form-label" for="co-p-benefits">Key benefits <span class="hint">one per line</span></label>
      <textarea class="form-input" id="co-p-benefits" rows="4">${ce(lines(p.key_benefits))}</textarea></div>
    <div class="offer-actions"><button class="btn btn-primary btn-sm" onclick="saveCompanySection('product')">Save</button></div>
  </section>

  <section class="card company-card" aria-labelledby="co-icp-h">
    <div class="company-card-head"><h3 id="co-icp-h">Who you sell to</h3></div>
    <div class="company-grid">
      <div class="form-group"><label class="form-label" for="co-i-industries">Industries <span class="hint">one per line</span></label>
        <textarea class="form-input" id="co-i-industries" rows="4">${ce(lines(icp.industries))}</textarea></div>
      <div class="form-group"><label class="form-label" for="co-i-titles">Job titles <span class="hint">one per line</span></label>
        <textarea class="form-input" id="co-i-titles" rows="4">${ce(lines(icp.titles))}</textarea></div>
      <div class="form-group"><label class="form-label" for="co-i-size">Company size</label>
        <input class="form-input" id="co-i-size" value="${ce(icp.company_size)}"></div>
      <div class="form-group"><label class="form-label" for="co-i-geo">Where <span class="hint">one per line</span></label>
        <textarea class="form-input" id="co-i-geo" rows="2">${ce(lines(icp.geography))}</textarea></div>
    </div>
    <div class="offer-actions"><button class="btn btn-primary btn-sm" onclick="saveCompanySection('icp')">Save</button></div>
  </section>

  <section class="card company-card" aria-labelledby="co-sender-h">
    <div class="company-card-head"><h3 id="co-sender-h">Who it's from</h3>
      <span class="hint">${ce(s.company)}${s.email ? ' · ' + ce(s.email) : ''}</span></div>
    <div class="company-grid">
      <div class="form-group"><label class="form-label" for="co-s-name">Sender name <span class="hint">signed under every email</span></label>
        <input class="form-input" id="co-s-name" value="${ce(s.name)}"></div>
      <div class="form-group"><label class="form-label" for="co-s-role">Role</label>
        <input class="form-input" id="co-s-role" value="${ce(s.role)}"></div>
    </div>
    <div class="form-group"><label class="form-label" for="co-s-tone">Tone</label>
      <input class="form-input" id="co-s-tone" value="${ce(s.tone)}"></div>
    <div class="offer-actions"><button class="btn btn-primary btn-sm" onclick="saveCompanySection('persona')">Save</button></div>
  </section>

  <section class="card company-card" aria-labelledby="co-obj-h">
    <div class="company-card-head"><h3 id="co-obj-h">Objections and answers</h3>
      <span class="hint">How replies handle pushback</span></div>
    <div id="co-objections" class="company-objections">
      ${(objections.length ? objections : [['', '']]).map(([k, v], i) => objectionRow(k, v, i)).join('')}
    </div>
    <div class="offer-actions">
      <button class="btn btn-secondary btn-sm" onclick="addObjection()">Add an objection</button>
      <button class="btn btn-primary btn-sm" onclick="saveCompanySection('product', true)">Save</button>
    </div>
  </section>

  ${data.knowledge || data.competitors ? `<section class="card company-card" aria-labelledby="co-learned-h">
    <div class="company-card-head"><h3 id="co-learned-h">What Sellbird learned from your site</h3>
      <span class="hint">From training. Retrain with <code>sellbird train &lt;url&gt;</code></span></div>
    ${data.knowledge ? `<details class="company-learned"><summary>Product knowledge</summary><pre>${ce(data.knowledge)}</pre></details>` : ''}
    ${data.competitors ? `<details class="company-learned"><summary>Competitors</summary><pre>${ce(data.competitors)}</pre></details>` : ''}
  </section>` : ''}`;
  _offerIdeas = (o.entry_ideas || []).map(x => ({offer: x}));
  renderOfferIdeas();
  const badge = document.getElementById('nav-company');
  if (badge) badge.textContent = o.proposed ? '1' : '';
}

function objectionRow(k, v, i) {
  return `<div class="company-objection">
    <div class="form-group"><label class="form-label" for="co-ok-${i}">When they say</label>
      <input class="form-input co-ok" id="co-ok-${i}" value="${ce(k)}"></div>
    <div class="form-group"><label class="form-label" for="co-ov-${i}">Answer with</label>
      <textarea class="form-input co-ov" id="co-ov-${i}" rows="2">${ce(v)}</textarea></div>
  </div>`;
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
  if (!_offerIdeas.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="form-label">Ideas to start from (click one to put it in the box, then make it yours)</div>' +
    _offerIdeas.map((idea, i) => `<button type="button" class="offer-idea" onclick="useOfferIdea(${i})">
      <span class="offer-idea-text">${ce(idea.offer)}</span>
      ${idea.finding ? `<span class="offer-idea-meta">Pairs with: ${ce(idea.finding)}</span>` : ''}
      ${idea.why ? `<span class="offer-idea-meta">${ce(idea.why)}</span>` : ''}
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
    '<p class="desc">Sellbird is reading your product and coming up with offers that fit it...</p>';
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
  box.innerHTML = '<p class="desc">Writing a sample first email for one of your prospects. Nothing is saved or sent.</p>';
  box.scrollIntoView({block: 'nearest', behavior: 'smooth'});
  const r = await api('/api/offer/preview', {method: 'POST', headers: {'Content-Type': 'application/json'},
                                            body: JSON.stringify({entry})});
  btn.disabled = false; btn.textContent = 'Preview an email';
  if (!r || !r.ok) { box.innerHTML = `<p class="desc">${ce((r && r.message) || 'The preview failed. Try again.')}</p>`; return; }
  box.innerHTML = `<div class="form-label">Sample for ${ce(r.to)} (not saved, not sent)</div>
    <div class="offer-mail"><div class="offer-mail-subject">${ce(r.subject)}</div><pre>${ce(r.body)}</pre></div>`;
  box.scrollIntoView({block: 'nearest', behavior: 'smooth'});
}

async function saveOffer(entryOverride) {
  const entry = entryOverride != null ? entryOverride : document.getElementById('offer-entry').value.trim();
  const r = await api('/api/offer', {method: 'POST', headers: {'Content-Type': 'application/json'},
                                     body: JSON.stringify({entry})});
  if (r && r.success) { showToast(r.message, 'success'); loadCompany(); }
  else showToast((r && r.message) || 'Couldn\'t save the offer.', 'error');
}

async function useProposedOffer() {
  if (_company && _company.offer && _company.offer.proposed) await saveOffer(_company.offer.proposed.entry);
}

async function dismissProposedOffer() {
  await api('/api/offer/propose', {method: 'DELETE'});
  loadCompany();
}

(function wireInboxDialog() {
  const d = document.getElementById('inbox-dialog');
  if (!d) return;
  d.addEventListener('close', () => { if (_inboxPoll) { clearInterval(_inboxPoll); _inboxPoll = null; } });
  d.addEventListener('click', e => { if (e.target === d) closeInboxDialog(); });
})();
