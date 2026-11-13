"""Companies and Contacts tabs, rebuilt to the redesign.

The render functions are pulled out of app.js by name and run under node.
All data here is fictional (example.com).
"""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.test_dashboard_ui import KIT, extract

WEB = Path(__file__).resolve().parent.parent / "sellbird" / "web"


def _app_js() -> str:
    return (WEB / "app.js").read_text(encoding="utf-8")


def _const(name: str) -> str:
    """A top-level const holding an object or an array literal."""
    m = re.search(rf"^(?:const|let) {name} = (?:[\[{{]\n.*?^[\]}}];?|.*?;)\n", _app_js(), re.S | re.M)
    assert m, name
    return m.group(0)


HELPERS = ("own", "statusMeta", "parseTs", "relTime", "initials", "sourceLabel", "optOutPanel",
           "contactMatches", "listBar", "listCountTabs", "listFilterChip", "listPager", "listDetails", "listLink",
           "listStatusBadge", "companyStatusBadge", "companyStatusLabel", "companiesFilter", "companiesSummary",
           "companyWebsite", "companiesTableHtml", "companyLatestSignals", "companyInfoCard", "companySignalsTable",
           "companyContactsTable", "companyDetailPage",
           "contactEmailStatus", "contactEmailBadge", "contactName", "contactsFilter",
           "contactsSummary", "contactsTableHtml", "contactDetailPage")
CONSTS = ("STATUS", "SOURCE_LABELS", "OPT_OUT_RULES", "CONTACT_FILTERS", "COMPANY_COLUMNS", "CONTACT_COLUMNS",
          "COMPANY_DEFAULT_COLUMNS", "CONTACT_DEFAULT_COLUMNS", "COMPANY_STATUS_ORDER")


def run(call, prelude=""):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    script = ("let _optOut = {id: null, data: null, armed: false, busy: false};\n" + prelude + "\n"
              + "\n".join(_const(c) for c in CONSTS) + "\n" + extract(KIT + HELPERS)
              + f"\nPromise.resolve({call}).then(v => process.stdout.write("
                "typeof v === 'string' ? v : JSON.stringify(v ?? null)));")
    return subprocess.run([node, "-e", script], capture_output=True, text=True, encoding="utf-8",
                          check=True, timeout=30).stdout


COMPANIES = [
    {"id": "c1", "name": "Alpha Roofing", "domain": "alpha.example.com", "website": "https://alpha.example.com",
     "industry": "Roofer", "location": "Springfield", "fit": 62, "register_status": "Approved",
     "contact_count": 2, "profile_checked_at": "2026-11-01 10:00:00", "created_at": "2026-11-01 09:00:00"},
    {"id": "c2", "name": "Beta Dental", "domain": "", "website": "", "industry": "Dentist",
     "location": "Shelbyville", "fit": 20, "register_status": "Not processed yet", "contact_count": 0,
     "created_at": "2026-11-02 09:00:00"},
    {"id": "c3", "name": "gamma plumbing", "domain": "gamma.example.com", "website": "", "industry": "Plumber",
     "location": "Springfield", "fit": 35, "register_status": "Emailed", "contact_count": 1,
     "created_at": "2026-11-03 09:00:00"},
]

PROSPECTS = [
    {"id": "p1", "first_name": "Ada", "last_name": "Example", "title": "Owner", "company": "Alpha Roofing",
     "company_id": "c1", "email": "ada@alpha.example.com", "email_status": "verified", "status": "new", "score": 70},
    {"id": "p2", "first_name": "", "last_name": "", "title": "", "company": "Alpha Roofing", "company_id": "c1",
     "email": "info@alpha.example.com", "email_status": "risky", "status": "contacted", "score": 0},
    {"id": "p3", "first_name": "Cy", "last_name": "Sample", "title": "Founder", "company": "gamma plumbing",
     "company_id": "c3", "email": "cy@gamma.example.com", "email_status": "invalid", "status": "opted_out"},
]


# ── Companies ──


def test_companies_filter_is_case_insensitive_over_name_and_domain():
    names = json.loads(run(f"companiesFilter({json.dumps(COMPANIES)}, {{q: 'GAMMA'}}).map(c => c.name)"))
    assert names == ["gamma plumbing"]
    names = json.loads(run(f"companiesFilter({json.dumps(COMPANIES)}, {{q: 'Alpha.EXAMPLE'}}).map(c => c.name)"))
    assert names == ["Alpha Roofing"]


def test_companies_filter_chips():
    rows = json.dumps(COMPANIES)
    pick = lambda chips: json.loads(run(f"companiesFilter({rows}, {{chips: {json.dumps(chips)}}}).map(c => c.id)"))
    assert pick({"website": "no"}) == ["c2"]
    assert pick({"website": "yes"}) == ["c1", "c3"]
    assert pick({"contacts": True}) == ["c1", "c3"]
    assert pick({"contacted": True}) == ["c3"]
    assert pick({"industry": "Roofer"}) == ["c1"]
    assert pick({"location": "Springfield", "fit": "30"}) == ["c3"]
    assert pick({"fit": "50"}) == ["c1"]
    assert pick({"status": "Not processed yet"}) == ["c2"]


def test_companies_empty_result_and_unsafe_website():
    assert "No companies match" in run("companiesTableHtml([], null, 0)")
    bad = [{"id": "x", "name": "<b>Evil</b>", "website": "javascript:x", "domain": "", "fit": 5,
            "register_status": "Approved"}]
    html = run(f"companiesTableHtml({json.dumps(bad)}, null, 0)")
    assert 'href="javascript' not in html
    assert "&lt;b&gt;Evil&lt;/b&gt;" in html and "<b>Evil" not in html
    assert "undefined" not in html and "NaN" not in html


def test_companies_summary_empty_and_full():
    empty = run("companiesSummary([])")
    assert "undefined" not in empty and "NaN" not in empty and "—" in empty
    full = run(f"companiesSummary({json.dumps(COMPANIES)})")
    assert "Approved for outreach" in full and "39" in full  # (62 + 20 + 35) / 3 rounded
    assert "1 have no site" in full


def test_company_detail_page_escapes_and_shows_contacts():
    profile = {"company": COMPANIES[0], "register": {"status": "Approved", "why_selected": "<i>fits</i>"},
               "observations": [{"signal_code": "TECH_STACK", "label": "Tech stack", "value_text": "<script>",
                                 "value_num": None, "evidence_url": "javascript:alert(1)"}]}
    html = run(f"companyDetailPage({json.dumps(COMPANIES[0])}, {json.dumps(profile)}, {json.dumps(PROSPECTS[:2])})")
    assert "Companies" in html and "Alpha Roofing" in html
    assert "&lt;i&gt;fits&lt;/i&gt;" in html and "&lt;script&gt;" in html
    assert 'href="javascript' not in html
    assert "ada@alpha.example.com" in html and "Verified" in html
    assert "undefined" not in html and "NaN" not in html


def test_company_detail_page_with_nothing():
    html = run("companyDetailPage({id: 'z', name: 'Zed'}, null, null)")
    assert "Zed" in html and "No contacts found" in html
    assert "undefined" not in html and "NaN" not in html


# ── Contacts ──


def test_contacts_filter_by_email_status():
    ids = json.loads(run(f"contactsFilter({json.dumps(PROSPECTS)}, {{emailStatus: 'verified'}}).map(p => p.id)"))
    assert ids == ["p1"]
    ids = json.loads(run(f"contactsFilter({json.dumps(PROSPECTS)}, {{status: 'contacted', q: 'ALPHA'}}).map(p => p.id)"))
    assert ids == ["p2"]
    ids = json.loads(run(f"contactsFilter({json.dumps(PROSPECTS)}, {{status: 'closed'}}).map(p => p.id)"))
    assert ids == ["p3"]
    ids = json.loads(run(f"contactsFilter({json.dumps(PROSPECTS)}, {{company: 'gamma plumbing'}}).map(p => p.id)"))
    assert ids == ["p3"]


def test_contacts_table_escapes_email_and_has_badges():
    rows = [dict(PROSPECTS[0], email="<x@example.com>")]
    html = run(f"contactsTableHtml({json.dumps(rows)}, null)")
    assert "&lt;x@example.com&gt;" in html and "<x@example.com>" not in html
    assert "Verified" in html
    assert "No contacts match" in run("contactsTableHtml([], null)")


def test_contacts_summary_counts():
    html = run(f"contactsSummary({json.dumps(PROSPECTS)})")
    assert "across 2 companies" in html and "Catch-all" in html and "Invalid" in html
    empty = run("contactsSummary([])")
    assert "undefined" not in empty and "NaN" not in empty


def test_contact_detail_page_embeds_opt_out_panel():
    p = PROSPECTS[2]
    data = {"opted_out": True, "recorded": True, "why": "Asked to stop", "rule": "phrase", "history": []}
    prelude = f"_optOut = {{id: 'p3', data: {json.dumps(data)}, armed: false, busy: false}};"
    html = run(f"contactDetailPage({json.dumps(p)}, {{outbox: [], index: 2}})", prelude)
    panel = run(f"optOutPanel({json.dumps(p)})", prelude)
    assert panel in html
    assert "Contacts" in html and "Cy Sample" in html and "Invalid" in html


def test_contact_detail_page_lists_its_emails_and_escapes():
    p = dict(PROSPECTS[0], email="<x@example.com>")
    outbox = [{"id": "o1", "prospect_id": "p1", "step": 2, "subject": "<b>hi</b>", "status": "pending_review",
               "send_at": "2026-11-20 10:00:00"}]
    html = run(f"contactDetailPage({json.dumps(p)}, {{outbox: {json.dumps(outbox)}, index: 0}})")
    assert "&lt;x@example.com&gt;" in html and "&lt;b&gt;hi&lt;/b&gt;" in html
    assert "Email 2" in html and "Waiting on you" in html
    assert "undefined" not in html and "NaN" not in html
    empty = run(f"contactDetailPage({json.dumps(PROSPECTS[1])}, {{outbox: [], index: 1}})")
    assert "No emails" in empty and "info@alpha.example.com" in empty


def test_index_keeps_export_buttons():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    assert "downloadCsv('/api/export/prospects.csv'" in html
    assert "downloadCsv('/api/export/prospects.csv?all=true'" in html
    assert "downloadCsv('/api/export/companies.csv'" in html
