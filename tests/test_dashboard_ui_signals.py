"""The redesigned Signals and Discover tabs: pure render helpers under node.

Same harness as tests/test_dashboard_ui.py. All data is fictional.
"""
import json
import re
from pathlib import Path

from tests.test_dashboard_ui import KIT, run_js

WEB = Path(__file__).resolve().parent.parent / "sellbird" / "web"

SIGNALS = KIT + ("signalRow", "signalGroups", "signalsSummary", "signalGroupCard", "signalTabsFor")
DISCOVER = KIT + ("parseTs", "relTime", "lastDiscoverRun", "discoverSummary", "sourcesTable",
                  "sourceBadge", "sourceDetailPage", "estimateHtml", "profileCard")


def sig(call):
    return run_js(SIGNALS, call)


def disc(call):
    return run_js(DISCOVER, call)


def _sig(**kw):
    base = {"code": "HAS_SITE", "label": "Has a site", "description": "d", "cost_note": "free",
            "status": "proposed", "companies": 0, "category": "profile"}
    base.update(kw)
    return base


# ── Signals ──


def test_proposed_signal_has_confirm_and_skip_and_no_switch():
    html = sig(f"signalRow({json.dumps(_sig())})")
    assert ">Confirm<" in html and ">Skip<" in html
    assert 'role="switch"' not in html
    assert "setSignals([" in html and "'confirmed'" in html and "'rejected'" in html


def test_decided_signals_show_a_switch():
    on = sig(f"signalRow({json.dumps(_sig(status='confirmed', companies=3))})")
    off = sig(f"signalRow({json.dumps(_sig(status='rejected'))})")
    assert 'role="switch"' in on and " checked" in on and ">Confirm<" not in on
    assert "Confirmed" in on and "seen on 3 companies so far" in on
    assert 'role="switch"' in off and " checked" not in off and ">Skip<" not in off
    assert "Off" in off
    # Flipping the switch calls the existing status endpoint wrapper.
    assert "setSignals([" in on and "this.checked" in on


def test_signal_description_is_escaped():
    html = sig(f"signalRow({json.dumps(_sig(description='<script>alert(1)</script>', label='<b>L</b>'))})")
    assert "<script>" not in html and "&lt;script&gt;" in html and "&lt;b&gt;L" in html


def test_paid_signal_has_paid_badge_and_free_does_not():
    paid = sig(f"signalRow({json.dumps(_sig(cost_note='~$0.002 per search'))})")
    free = sig(f"signalRow({json.dumps(_sig(cost_note='Free: reads the homepage'))})")
    assert ">Paid<" in paid and ">Paid<" not in free
    assert "not collected yet" in free or "seen on" in free


def test_signal_groups_map_categories_to_four_tabs():
    groups = [{"key": "discovery", "label": "Discovery — who exists", "blurb": "b1",
               "signals": [_sig(code="A", category="discovery")]},
              {"key": "verification", "label": "Contactability — can you reach them", "blurb": "b4",
               "signals": [_sig(code="B", category="verification")]},
              {"key": "mystery", "label": "M", "blurb": "", "signals": [_sig(code="C", category="mystery")]}]
    out = json.loads(sig(f"JSON.stringify(signalGroups({json.dumps(groups)}))"))
    assert [g["key"] for g in out] == ["discovery", "profile", "people", "verification"]
    assert [g["tab"] for g in out] == ["Discovery", "Profile", "People", "Contactability"]
    by = {g["key"]: [s["code"] for s in g["signals"]] for g in out}
    assert by == {"discovery": ["A"], "profile": ["C"], "people": [], "verification": ["B"]}
    assert out[0]["title"] == "Discovery: who exists"


def test_signals_summary_has_four_numbers_and_no_nan():
    html = sig("signalsSummary({summary: {}, groups: []})")
    for label in ("Confirmed", "Waiting on you", "Turned off", "Companies scored"):
        assert label in html
    assert "NaN" not in html and "undefined" not in html
    html = sig("signalsSummary({summary: {confirmed: 9, proposed: 0, rejected: 1}, groups: "
               "[{signals: [{companies: 4}, {companies: 12}]}]})")
    assert "90% of signals" in html and "nothing to decide" in html and ">12<" in html


def test_group_card_bulk_buttons_only_for_proposed():
    g = {"key": "profile", "tab": "Profile", "title": "Profile: what", "blurb": "b",
         "signals": [_sig(code="A"), _sig(code="B", status="confirmed")]}
    html = sig(f"signalGroupCard({json.dumps(g)})")
    assert "Confirm all 1" in html and "Skip all 1" in html
    assert "setSignals([&quot;A&quot;], 'confirmed')" in html and "&quot;A&quot;,&quot;B&quot;" not in html
    assert "2 signals · 1 on" in html
    g["signals"] = [_sig(code="B", status="confirmed")]
    assert "Confirm all" not in sig(f"signalGroupCard({json.dumps(g)})")


def test_signal_tabs_include_cohort_builder():
    html = sig("signalTabsFor([{key:'discovery', tab:'Discovery', signals:[{status:'proposed'}]}], 'cohort')")
    assert "Discovery" in html and "Cohort builder" in html and 'aria-selected="true"' in html


def test_cohort_functions_keep_their_order():
    src = (WEB / "app.js").read_text(encoding="utf-8")
    assert src.index("function renderCohortBuilder(") < src.index("async function runCohort(") \
        < src.index("async function exportCohort(") < src.index("function pageCohort(")


# ── Discover ──


def _prov(**kw):
    base = {"key": "osm", "label": "Open map", "blurb": "Free map data. More text.", "cost_note": "free",
            "free_tier": "unlimited", "env_keys": [], "configured": True, "needs_key": False,
            "signup_url": "", "caveat": ""}
    base.update(kw)
    return base


def test_provider_missing_keys_shows_needs_key_badge():
    rows = [_prov(), _prov(key="paid", label="Paid one", configured=False, needs_key=True,
                           env_keys=["EXAMPLE_KEY"], signup_url="https://example.com/signup")]
    html = disc(f"sourcesTable({json.dumps(rows)}, [])")
    assert "Needs a key" in html and "Ready" in html and "never" in html
    assert "openSource(" in html


def test_sources_table_shows_last_run_per_provider():
    runs = [{"stage": "discover", "provider": "osm", "started_at": "2020-01-01 00:00:00", "records": 5}]
    html = disc(f"sourcesTable({json.dumps([_prov()])}, {json.dumps(runs)})")
    assert "never" not in html


def test_source_detail_escapes_and_links_safely():
    p = _prov(label="<b>X</b>", needs_key=True, configured=False, env_keys=["EXAMPLE_KEY"],
              signup_url="javascript:alert(1)", caveat="<i>careful</i>")
    html = disc(f"sourceDetailPage({json.dumps(p)})")
    assert "&lt;b&gt;X" in html and "javascript:" not in html and "&lt;i&gt;careful" in html
    assert "EXAMPLE_KEY" in html and "Needs a key" in html and "Discover" in html


def test_estimate_has_no_nan_when_cost_is_zero():
    html = disc("estimateHtml({estimated_cost: 0, query_count: 0, queries: [], free: false}, 1)")
    assert "NaN" not in html and "undefined" not in html and "$0.0000" in html
    html = disc("estimateHtml({free: true, query_count: 2, queries: ['a <b>', 'c']}, 1)")
    assert "Free" in html and "2 queries" in html and "a &lt;b&gt;" in html
    over = disc("estimateHtml({estimated_cost: 5, query_count: 1, queries: ['q'], free: false}, 1)")
    assert "Over your cap" in over


def test_discover_summary_counts_ready_and_spend():
    runs = [{"stage": "discover", "provider": "osm", "cost_usd": 0.02, "records": 9, "started_at": "2020-01-01 00:00:00"},
            {"stage": "profile", "provider": "http", "cost_usd": 0, "records": 3, "started_at": "2020-01-02 00:00:00"}]
    html = disc(f"discoverSummary({json.dumps([_prov(), _prov(key='k', configured=False)])}, {json.dumps(runs)}, 7)")
    assert "Sources ready" in html and "1 need a key" in html and ">7<" in html
    assert "$0.02" in html and "NaN" not in html
    empty = disc("discoverSummary([], [], undefined)")
    assert "NaN" not in empty and "undefined" not in empty and "never" in empty.lower()


def test_profile_card_only_when_companies_wait():
    assert disc("profileCard(0, false)") == ""
    html = disc("profileCard(3, false)")
    assert "3 companies not looked at yet" in html and "runProfile(this)" in html
    assert "disabled" in disc("profileCard(1, true)")


def test_presets_stay_in_index_html():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    assert 'value="accelerator"' in html and 'value="funding"' in html
    for i in ("disc-preset", "disc-cities", "disc-limit", "disc-depth", "disc-cap", "disc-run", "disc-stop",
              "discover-estimate", "cohort-builder", "cohort-result"):
        assert re.search(rf'id="{i}"', html), i
