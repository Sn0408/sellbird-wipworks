"""The redesigned System tabs: Conversations, Activity, Usage, Controls,
Settings and Help. Pure render helpers run under node; all data is fictional
(example.com)."""
import json
import re
from pathlib import Path

from tests.test_dashboard_ui import KIT, run_js

WEB = Path(__file__).resolve().parent.parent / "sellbird" / "web"
HTML = (WEB / "index.html").read_text(encoding="utf-8")

BASE = KIT + ("parseTs", "relTime", "dayLabel", "timeOfDay", "own", "statusMeta", "initials",
              "actionText", "activityWhen", "activityTable", "fmtTokens", "formatDate")
CONVO = BASE + ("convoActions", "convoStatusBadge", "convoLast", "convoSummary", "convoTiles",
                "convoTable", "convoThread", "convoDetailPage")
PRELUDE = ("const AGENT_ICONS = {};\n"
           "const STATUS = {needs_human: ['Needs you', 'waiting'], open: ['Open', 'active'],"
           " closed: ['Closed', 'idle'], awaiting_reply: ['Awaiting reply', 'active'],"
           " interested: ['Interested', 'good']};\n"
           "const STAGE_LABELS = {engaged: 'Engaged'};\n"
           "const CONVO_FILTERS = [['needs', 'Needs you', c => !!c.draft || c.status === 'needs_human'],"
           " ['open', 'Open', c => c.status !== 'closed' && c.status !== 'awaiting_reply'],"
           " ['awaiting', 'Awaiting reply', c => c.status === 'awaiting_reply'],"
           " ['closed', 'Closed', c => c.status === 'closed'], ['all', 'All', () => true]];\n")


def js(names, call):
    return run_js(names, call, PRELUDE)


CONVOS = [
    {"id": "c1", "status": "needs_human", "intent": "interested", "stage": "engaged",
     "first_name": "<b>Ann</b>", "last_name": "Lee", "company": "Example Co",
     "prospect_email": "ann@example.com", "prospect_id": "p1", "prospect_status": "replied",
     "created_at": "2099-01-01 10:00:00", "updated_at": "2099-01-01 10:00:00",
     "thread": [{"sender": "prospect", "content": "<script>x</script> sounds good",
                 "timestamp": "2099-01-01 10:00:00"}],
     "emails": [{"step": 1, "subject": "Hi", "body": "Body", "sent_at": "2098-12-30 10:00:00"}]},
    {"id": "awaiting-p2", "status": "awaiting_reply", "intent": "", "stage": "",
     "first_name": "", "last_name": "", "company": "", "prospect_email": "bo@example.com",
     "prospect_id": "p2", "thread": [], "emails": [{"step": 1, "subject": "Hello there",
                                                  "body": "B", "sent_at": "2099-01-01 09:00:00"}]},
]


# ── Conversations ──


def test_convo_table_rows_escape_and_open_the_detail_page():
    html = js(CONVO, f"convoTable({json.dumps(CONVOS)}, 'all')")
    assert "&lt;b&gt;Ann&lt;/b&gt;" in html and "<b>Ann" not in html
    assert "&lt;script&gt;" in html and "<script>" not in html
    assert "openConvo(" in html and "Needs you" in html and "Awaiting reply" in html
    assert "bo@example.com" in html and "undefined" not in html and "NaN" not in html


def test_convo_tiles_count_the_existing_filters():
    html = js(CONVO, f"convoTiles({json.dumps(CONVOS)}, 'needs')")
    for label in ("Needs you", "Open", "Awaiting reply", "Closed", "All"):
        assert label in html
    assert "setConvoFilter('needs')" in html and 'aria-selected="true"' in html


def test_convo_summary_with_nothing_has_no_nan():
    html = js(CONVO, "convoSummary([])")
    assert "Replies" in html and "Interested" in html and "Opted out" in html
    assert "NaN" not in html and "undefined" not in html


def test_convo_table_empty_filter_says_so():
    html = js(CONVO, f"convoTable({json.dumps(CONVOS)}, 'closed')")
    assert "No conversation matches this filter" in html


def test_convo_detail_page_has_crumbs_thread_and_the_existing_actions():
    html = js(CONVO, f"convoDetailPage({json.dumps(CONVOS[0])})")
    assert "Conversations" in html and "closeConvo()" in html
    assert "&lt;script&gt;" in html and "<script>" not in html
    assert "Hand back to Sellbird" in html and "setConvoStatus(" in html
    assert "Email 1" in html


# ── Activity ──

ACT = BASE + ("activityFilterChip", "activityRows", "activityFeed", "activitySummary")


def test_activity_feed_empty():
    html = js(ACT, "activityFeed([], {date: 'all', agent: '', type: '', offset: 0})")
    assert "No activity yet" in html and "undefined" not in html


def test_activity_feed_filters_escapes_and_pages():
    rows = [{"action_type": "outbox_edited", "agent": "<i>dashboard</i>", "created_at": "2026-01-01 10:00:00",
             "details": {}}] + [{"action_type": "prospect", "agent": "scout", "created_at": "2026-01-01 09:00:00",
                                 "details": {"prospects_found": i}} for i in range(30)]
    html = js(ACT, f"activityFeed({json.dumps(rows)}, {{date: 'all', agent: '', type: '', offset: 0}})")
    assert "&lt;i&gt;" in html and "<i>dashboard" not in html
    assert "31 results" in html and "Next" in html
    only = js(ACT, f"activityFeed({json.dumps(rows)}, {{date: 'all', agent: 'scout', type: '', offset: 0}})")
    assert "You edited a draft" not in only and "30 results" in only
    none = js(ACT, f"activityFeed({json.dumps(rows)}, {{date: 'today', agent: '', type: '', offset: 0}})")
    assert "No activity matches" in none


def test_activity_summary_missing_values():
    html = js(ACT, "activitySummary([])")
    assert "Events today" in html and "—" in html and "NaN" not in html and "undefined" not in html


# ── Usage ──

USAGE = BASE + ("usageCallsCard", "usageDays", "usageDailyCard", "usageTabs", "quotaCardHtml")


def test_usage_tabs_table_and_empty():
    data = {"by_agent": [{"agent": "<b>writer</b>", "calls": 9, "input_tokens": 86900, "output_tokens": 7900,
                          "cache_read_tokens": 14300}], "by_task": [], "by_model": [], "by_provider": []}
    html = js(USAGE, f"usageTabs({json.dumps(data)}, 'agent')")
    assert "By agent" in html and "By task" in html and "By model" in html
    assert "&lt;b&gt;writer" in html and "86.9k" in html and "7.9k" in html
    empty = js(USAGE, f"usageTabs({json.dumps(data)}, 'task')")
    assert "No usage recorded" in empty


def test_usage_cards_with_no_data_have_no_nan():
    calls = js(USAGE, "usageCallsCard({})")
    assert "Today" in calls and "Last 30 days" in calls and "NaN" not in calls and "undefined" not in calls
    daily = js(USAGE, "usageDailyCard([], '2026-11-13')")
    assert "Output tokens per day" in daily and "NaN" not in daily
    days = json.loads(js(USAGE, "JSON.stringify(usageDays([{day: '2026-11-12', output_tokens: 5}], '2026-11-13'))"))
    assert len(days) == 14 and days[-2]["output_tokens"] == 5 and days[-1]["output_tokens"] == 0


def test_quota_card_reads_as_metrics():
    html = js(USAGE, "quotaCardHtml({quota_provider: 'claude', quota: {five_hour: {utilization: 9, resets_at: ''}}})")
    assert "5-hour window" in html and "9% used" in html and "ui-card" in html


# ── Controls ──

CTRL = BASE + ("controlsBadge", "controlsAgentCard")


def test_controls_running_stopped_offline():
    run = js(CTRL, "controlsAgentCard({running: true, pid: 4242, started_at: '2026-01-01T10:00:00'})")
    assert "Running" in run and "4242" in run and 'id="btn-stop"' in run and "stopSellbird()" in run
    stop = js(CTRL, "controlsAgentCard({running: false, pid: null})")
    assert "Stopped" in stop and 'id="btn-start"' in stop and "startSellbird()" in stop and "—" in stop
    off = js(CTRL, "controlsAgentCard(null)")
    assert "reach" in off and "undefined" not in off


# ── Settings ──

SET = BASE + ("PROVIDER_LABELS", "settingsSummary")


def test_settings_summary_counts_and_escapes():
    html = js(SET, "settingsSummary({provider: 'smtp', smtp_username: '<b>me</b>@example.com',"
                   " reoon_api_key_set: true, hunter_api_key_set: true}, {mode: 'approval'})")
    assert "Approval" in html and "SMTP" in html and "&lt;b&gt;me" in html
    assert "2 set" in html and "Reoon, Hunter" in html and "0 of 2" in html
    blank = js(SET, "settingsSummary(null, null)")
    assert "—" in blank and "undefined" not in blank and "NaN" not in blank


def test_secret_settings_fields_stay_masked():
    for fid in ("gmail-secret", "smtp-pass", "imap-pass", "instantly-key", "reoon-key", "zerobounce-key",
                "hunter-key", "linkedin-password", "cf-api-token"):
        assert re.search(rf'type="password"[^>]*id="{fid}"', HTML), fid
    src = (WEB / "app.js").read_text(encoding="utf-8")
    load = src[src.index("async function loadSettings"):src.index("function saveGmail")]
    assert "el.value = '';" in load and "Saved — enter new value to change" in load


def test_every_settings_handler_and_panel_is_still_on_the_page():
    for h in ("saveGmail()", "saveSmtp()", "saveMicrosoft()", "saveInstantly()", "testInstantly()",
              "saveVerifiers()", "saveLinkedIn()", "saveCloudflare()", 'id="sending-mode-card"',
              'id="imap-same-pass"', "showSettingsTab('provider'", "showSettingsTab('verify'",
              "showSettingsTab('optional'", "showSettingsTab('sending'"):
        assert h in HTML, h


def test_help_keeps_its_content_and_links():
    for text in ("What is Sellbird?", "Getting started", "Where everything lives", "Getting your API keys",
                 "Common issues", "data/sellbird.log", "Codex calls fail", "https://instantly.ai",
                 "https://dash.cloudflare.com", "On this page"):
        assert text in HTML, text
