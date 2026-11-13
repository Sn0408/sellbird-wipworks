"""The rebuilt Outbox and Inboxes tabs: pure render helpers and the review shortcuts.

Same node harness as tests/test_dashboard_ui.py. All data is fictional (example.com).
"""
import json

from tests.test_dashboard_ui import KIT, run_js

# ── Outbox ──

OUTBOX = KIT + ("own", "formatDate", "heldReason", "outboxBuckets", "outboxStatusBadge", "outboxStep",
                "outboxSummary", "outboxTable", "parseTs", "renderDeskContext", "outboxEmailPage")
PRE = ("const HELD_PREFIX = 'held for your review: ';\n"
       "const CONTACT_SOURCES = {company_website: 'team page on their site'};\n")

DATA = {
    "pending": [{"id": 1, "status": "pending_review", "to_email": "ana@example.com", "step": 1,
                 "subject": "a note", "body": "hi", "send_at": "2026-11-14 09:00:00", "kind": "sequence"}],
    "approved": [{"id": 2, "status": "approved", "to_email": "bo@example.com", "step": 2,
                  "subject": "follow", "send_at": "2026-11-15 09:00:00"}],
    "sent": [{"id": 3, "status": "sent", "to_email": "cy@example.com", "step": 1, "subject": "s",
              "sent_at": "2026-11-12 09:00:00"}],
    "failed": [{"id": 4, "status": "failed", "to_email": "di@example.com", "step": 1, "error": "smtp down"},
               {"id": 5, "status": "cancelled", "to_email": "ed@example.com", "step": 3},
               {"id": 6, "status": "rejected", "to_email": "fa@example.com", "step": 1}],
}


def outbox(call):
    return run_js(OUTBOX, call, PRE)


def test_buckets_put_failed_and_cancelled_in_didnt_send():
    b = json.loads(outbox(f"outboxBuckets({json.dumps(DATA)})"))
    assert [r["id"] for r in b["didnt"]] == [4, 5, 6]
    assert [r["id"] for r in b["review"]] == [1]
    assert [r["id"] for r in b["scheduled"]] == [2] and [r["id"] for r in b["sent"]] == [3]
    # A cancelled row that arrives in another list still lands under Didn't send.
    odd = {"approved": [{"id": 9, "status": "cancelled"}]}
    assert json.loads(outbox(f"outboxBuckets({json.dumps(odd)})"))["didnt"][0]["id"] == 9
    assert json.loads(outbox("outboxBuckets({})")) == {"review": [], "scheduled": [], "sent": [], "didnt": []}


def test_summary_counts_and_empty():
    html = outbox(f"outboxSummary(outboxBuckets({json.dumps(DATA)}), {json.dumps(DATA)})")
    assert "To review" in html and "Scheduled" in html and "Sent" in html and "Didn’t send" in html
    assert "next sends" in html
    empty = outbox("outboxSummary(outboxBuckets({}), {})")
    assert "nothing waiting" in empty and "NaN" not in empty and "undefined" not in empty
    capped = {"sent": [{"id": i, "status": "sent", "sent_at": "2020-01-01 00:00:00"} for i in range(25)]}
    assert "last 25" in outbox(f"outboxSummary(outboxBuckets({json.dumps(capped)}), {json.dumps(capped)})")


def test_table_rows_badges_and_escaping():
    rows = [{"id": 7, "status": "failed", "to_email": "<b>x</b>@example.com", "step": 2,
             "subject": "<i>s</i>", "error": "<u>boom</u>"}]
    html = outbox(f"outboxTable({json.dumps(rows)}, 'didnt')")
    assert "&lt;b&gt;x" in html and "&lt;i&gt;s" in html and "&lt;u&gt;boom" in html
    assert "Failed" in html and "is-danger" in html and "Email 2" in html
    assert "openOutboxEmail(" in html
    assert "Nothing" in outbox("outboxTable([], 'review')")
    held = outbox("outboxTable([{id:1,status:'pending_review',error:'held for your review: links out',step:1}], 'review')")
    assert "Held" in held and "Approve" in held


def test_email_page_escapes_and_shows_position():
    item = {"id": 1, "status": "pending_review", "to_email": "ana@example.com", "step": 1,
            "subject": "<b>subj</b>", "body": "<script>x</script>", "kind": "sequence",
            "error": "held for your review: <i>links out</i>"}
    ctx = {"company": "<b>Co</b>", "website": "javascript:alert(1)", "contact": "Ana",
           "signals": {"<b>k</b>": "<b>v</b>"}}
    html = outbox(f"outboxEmailPage({json.dumps(item)}, {json.dumps(ctx)}, {{index: 1, count: 10}}, {{}})")
    assert "&lt;b&gt;subj" in html and "&lt;script&gt;" in html and "<script>" not in html
    assert "&lt;b&gt;Co" in html and "&lt;i&gt;links out" in html and "&lt;b&gt;k" in html
    assert 'href="javascript' not in html
    assert "2 of 10" in html and "Outbox" in html and "ana@example.com" in html
    assert "Approve" in html and "Reject" in html and "Edit" in html and "btn-primary" in html
    assert html.index("Reject") < html.index("Approve")
    sent = outbox("outboxEmailPage({id:3,status:'sent',to_email:'cy@example.com',step:1,subject:'s',body:'b'}, null, null, {})")
    assert "Approve" not in sent and "undefined" not in sent and "Sent" in sent


def test_email_page_editing_shows_save():
    html = outbox("outboxEmailPage({id:1,status:'pending_review',to_email:'a@example.com',subject:'s',body:'b',step:1}, null,"
                  " {index:0,count:1}, {editing:true, unsaved:{subject:'<b>new</b>', body:'t'}})")
    assert 'id="desk-subject"' in html and 'id="desk-body"' in html and "Save" in html
    assert "&lt;b&gt;new" in html and "outboxAct(" not in html


# ── Keyboard shortcuts ──

KEY_PRE = """
let currentTab = 'outbox';
const calls = [];
let _desk = {items: [{id: 'a'}, {id: 'b'}, {id: 'c'}], i: 0, open: 'a', editing: null};
function outboxAct(id, action) { calls.push(['act', id, action]); }
function deskEdit(id) { calls.push(['edit', id]); }
function deskBusy() { if (_desk.editing) { calls.push(['busy']); return true; } return false; }
function renderOutboxEmail() { calls.push(['render', _desk.i]); }
function openOutboxEmail(id) { calls.push(['open', id]); }
const key = (k, tag, extra) => outboxKey(Object.assign({key: k, target: {tagName: tag}}, extra || {}));
"""


def keys(script):
    return json.loads(run_js(("outboxKey", "deskGo"), "(() => {" + script + "; return JSON.stringify(calls);})()", KEY_PRE))


def test_shortcuts_ignored_while_typing():
    for tag in ("TEXTAREA", "INPUT", "SELECT"):
        assert keys(f"key('a', '{tag}'); key('r', '{tag}'); key('e', '{tag}'); key('j', '{tag}')") == []
    assert keys("outboxKey({key: 'a', target: {tagName: 'DIV', isContentEditable: true}})") == []
    assert keys("key('a', 'BODY')") == [["act", "a", "approve"]]
    assert keys("key('r', 'BODY')") == [["act", "a", "reject"]]
    assert keys("key('e', 'BODY')") == [["edit", "a"]]
    # Another tab, or a modifier: nothing.
    assert keys("currentTab = 'today'; key('a', 'BODY')") == []
    assert keys("key('a', 'BODY', {metaKey: true})") == []


def test_shortcuts_only_on_a_pending_email():
    # On the list (no email open) A/R/E do nothing.
    assert keys("_desk.open = null; key('a', 'BODY'); key('r', 'BODY'); key('e', 'BODY')") == []
    # A sent email open: not pending, so nothing to approve.
    assert keys("_desk.open = 'zz'; key('a', 'BODY')") == []


def test_mid_edit_only_escape_works():
    assert keys("_desk.editing = 'a'; key('a', 'BODY')") == [["busy"]]
    assert keys("_desk.editing = 'a'; key('a', 'TEXTAREA')") == []
    assert keys("_desk.editing = 'a'; key('Escape', 'TEXTAREA')") == [["edit", None]]


def test_j_and_k_do_not_wrap_past_the_ends():
    assert keys("key('k', 'BODY')") == []
    assert keys("key('j', 'BODY'); key('j', 'BODY'); key('j', 'BODY')") == [["render", 1], ["render", 2]]
    assert keys("_desk.i = 2; _desk.open = 'c'; key('j', 'BODY')") == []
    assert keys("_desk.i = 2; _desk.open = 'c'; key('k', 'BODY')") == [["render", 1]]


# ── Inboxes ──

INBOXES = KIT + ("own", "inboxBadge", "inboxMeter", "inboxDate", "inboxProvider", "inboxCount", "uiCountText", "inboxSub", "inboxSummary", "inboxesTable",
                 "inboxDetailPage")
IB_PRE = ("const INBOX_STATE = {sending: ['Sending', 'success'], paused: ['Paused', 'warning'],"
          " not_connected: ['Not connected', 'danger']};\n"
          "const INBOX_KINDS = {gmail: ['Gmail', ''], microsoft: ['Microsoft 365', ''], smtp: ['Other (SMTP)', '']};\n"
          "function connectSetupNotice() { return ''; }\n")


def inboxes(call):
    return run_js(INBOXES, call, IB_PRE)


def test_inbox_with_no_warmup_or_counts_shows_dash():
    bare = {"id": "x1", "address": "a@example.com", "state": "sending"}
    table = inboxes(f"inboxesTable([{json.dumps(bare)}])")
    page = inboxes(f"inboxDetailPage({json.dumps(bare)}, {{}})")
    for html in (table, page):
        assert "NaN" not in html and "undefined" not in html and "—" in html
    assert "openInbox(0)" in table
    assert "Nothing" in inboxes("inboxesTable([])") or "No inboxes" in inboxes("inboxesTable([])")
    summary = inboxes("inboxSummary({})")
    assert "Inboxes" in summary and "NaN" not in summary and "undefined" not in summary


def test_inbox_name_is_escaped():
    ib = {"id": "x1", "address": "<b>a</b>@example.com", "name": "<b>Sam</b>", "state": "paused",
          "paused_reason": "<i>why</i>", "cold_cap": 20, "cold_sent_today": 5, "first_emails_waiting": 2,
          "provider": "smtp"}
    table = inboxes(f"inboxesTable([{json.dumps(ib)}])")
    page = inboxes(f"inboxDetailPage({json.dumps(ib)}, {{campaigns: [{{id: 'c', name: '<b>Camp</b>'}}], pools: {{}}}})")
    for html in (table, page):
        assert "<b>Sam</b>" not in html and "&lt;b&gt;Sam" in html and "&lt;b&gt;a" in html
    assert "Paused" in table and "5 / 20" in table
    assert "&lt;i&gt;why" in page and "&lt;b&gt;Camp" in page
    assert "inboxAction(" in page and "testInbox(" in page and "saveInboxCap(" in page
    assert "saveInboxName(" in page and "removeInbox(" in page and "Inboxes" in page


def test_main_mailbox_page_keeps_connect_and_settings_note():
    ib = {"id": "main", "main": True, "address": "me@example.com", "state": "not_connected", "provider": "gmail",
          "cold_cap": 30, "cold_sent_today": 0, "first_emails_waiting": 0}
    page = inboxes(f"inboxDetailPage({json.dumps(ib)}, {{can_connect: {{gmail: true}}}})")
    assert "connectMainMailbox(" in page and 'id="main-status"' in page and "Main mailbox" in page
    assert "removeInbox(" not in page and "per_inbox_daily_cap" in page
