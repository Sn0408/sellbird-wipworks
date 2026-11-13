"""The redesigned dashboard: tokens, assets and the pure render helpers.

Render helpers are top-level functions in app.js that turn data into an HTML
string. They are pulled out of app.js by name and run under node, the same
way tests/test_brain_provider.py and tests/test_dashboard_opt_out.py do.
All data here is fictional (example.com).
"""
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

import sellbird.dashboard as dash

WEB = Path(__file__).resolve().parent.parent / "sellbird" / "web"


def _app_js() -> str:
    return (WEB / "app.js").read_text(encoding="utf-8")


def _css() -> str:
    return (WEB / "app.css").read_text(encoding="utf-8")


def extract(names, source=None):
    """The source of each top-level function or const called ``names`` in app.js."""
    source = source if source is not None else _app_js()
    parts = []
    for name in names:
        match = re.search(rf"^(?:async )?function {name}\(.*?^}}\n|^(?:const|let) {name} = .*?^}};?\n",
                          source, re.S | re.M)
        assert match, name
        parts.append(match.group(0))
    return "\n".join(parts)


def run_js(names, call, prelude=""):
    """Run ``call`` (a JS expression) with ``names`` from app.js loaded; return stdout."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    script = prelude + "\n" + extract(names) + f"\nPromise.resolve({call}).then(v => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v ?? null)));"
    return subprocess.run([node, "-e", script], capture_output=True, text=True, encoding="utf-8",
                          check=True, timeout=30).stdout


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setattr(dash, "DB_PATH", Path(tmp) / "sellbird.db")
        monkeypatch.setattr(dash, "WEB_DIR", WEB)
        dash.token_store.configure(Path(tmp) / "data" / "dashboard-token")
        token = dash.token_store.get()
        with TestClient(dash.app, base_url="http://127.0.0.1:5555",
                        headers={"Authorization": f"Bearer {token}"}) as c:
            yield c


# ── Tokens, font and logo ──


def _block(css: str, selector: str) -> str:
    start = css.index(selector + " {")
    return css[start:css.index("\n}", start)]


def test_web_assets_are_self_hosted():
    # Help text may link out (<a href>); nothing may *load* from another host.
    assert not re.search(r"https?://", _css())
    assert "@import" not in _css()
    html = (WEB / "index.html").read_text(encoding="utf-8")
    assert not re.search(r"""(?:src|srcset)=["']?\s*(?:https?:)?//""", html)
    assert not re.search(r"""<link[^>]+href=["']?\s*(?:https?:)?//""", html)
    assert (WEB / "fonts" / "ubuntu-sans.woff2").is_file()
    assert (WEB / "fonts" / "LICENCE-ubuntu-sans.txt").is_file()
    faces = re.findall(r"@font-face\s*\{[^}]*\}", _css())
    assert any("font-family: 'Ubuntu Sans'" in f and "ubuntu-sans.woff2" in f for f in faces)


def test_brand_tokens():
    root = _block(_css(), ":root")
    assert "--brand: #003c3a;" in root
    assert "--accent-orange: #f86a24;" in root
    assert "--sans: 'Ubuntu Sans'" in root


def test_logo_served(client):
    r = client.get("/static/sellbird-logo.png")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert "/static/sellbird-logo.png" in (WEB / "index.html").read_text(encoding="utf-8")


# ── Contrast and layout ──


def _tokens(block: str) -> dict:
    """``--name: #hex`` pairs in a CSS block, with var(--x) resolved within it."""
    raw = dict(re.findall(r"--([\w-]+):\s*([^;]+);", block))
    out = {}
    for name, value in raw.items():
        value = value.strip()
        seen = 0
        while value.startswith("var(--") and seen < 5:
            value = raw.get(value[6:-1], "").strip()
            seen += 1
        if re.fullmatch(r"#[0-9a-fA-F]{6}", value):
            out[name] = value
    return out


def _contrast(a: str, b: str) -> float:
    def lum(h):
        rgb = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        rgb = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
        return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    hi, lo = sorted((lum(a), lum(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


@pytest.mark.parametrize("selector", [":root", ":root[data-theme='dark']"])
def test_contrast_meets_aa(selector):
    t = _tokens(_block(_css(), selector))
    pairs = [("text", "surface"), ("text-2", "surface"), ("text-3", "surface"), ("text-3", "surface-2")]
    pairs += [(s, s + "-bg") for s in ("good", "wait", "bad", "active", "note")]
    for fg, bg in pairs:
        assert _contrast(t[fg], t[bg]) >= 4.5, (selector, fg, bg)
    assert _contrast("#ffffff", t["brand"]) >= 4.5, (selector, "white on brand")


def test_system_dark_matches_explicit_dark():
    css = _css()
    explicit = _tokens(_block(css, ":root[data-theme='dark']"))
    system = _tokens(_block(css, "  :root:not([data-theme='light'])"))
    assert explicit == system


def test_wide_tables_scroll_inside_card():
    rule = re.search(r"\.ui-table-wrap\s*\{([^}]*)\}", _css())
    assert rule and "overflow-x: auto" in rule.group(1)


# ── Top bar ──

TOPBAR = ("escHtml", "icon", "topbarHtml")


def _topbar(state):
    return run_js(TOPBAR, f"topbarHtml({json.dumps(state)})")


def test_topbar_running():
    html = _topbar({"running": True, "busy": False, "waiting": 0})
    assert "Sellbird running" in html
    assert re.search(r'<input[^>]*type="checkbox"[^>]*\schecked(?=[\s>])', html)
    assert "has-dot" not in html
    assert 'aria-label="Notifications"' in html and "goTab('today')" in html
    assert "loadCurrentTab()" in html


def test_topbar_stopped_with_waiting_items_shows_dot():
    html = _topbar({"running": False, "busy": False, "waiting": 3})
    assert not re.search(r"<input[^>]*\schecked(?=[\s>])", html)
    assert "has-dot" in html


def test_topbar_unknown_status_disables_switch():
    html = _topbar({"running": None, "busy": False, "waiting": 0})
    assert re.search(r"<input[^>]*\sdisabled(?=[\s>])", html)
    busy = _topbar({"running": True, "busy": True, "waiting": 0})
    assert re.search(r"<input[^>]*\sdisabled(?=[\s>])", busy)


def _set_running(on, reply):
    prelude = (
        "let _topbar = {running: " + json.dumps(not on) + ", busy: false, waiting: 0};\n"
        "const toasts = [], calls = [];\n"
        "const api = async (path, opts) => { calls.push(path); return " + json.dumps(reply) + "; };\n"
        "const showToast = (m, t) => toasts.push(t);\n"
        "const loadSellbirdStatus = () => {};\n"
        "let rendered = '';\n"
        "const document = {getElementById: () => ({set innerHTML(v) { rendered = v; }})};\n"
    )
    call = f"setRunning({json.dumps(on)}).then(() => JSON.stringify({{state: _topbar, toasts, calls}}))"
    return json.loads(run_js((*TOPBAR, "renderTopbar", "setRunning"), call, prelude))


def test_running_switch_reverts_on_failure():
    out = _set_running(True, {"error": "x"})
    assert out["state"]["running"] is False and out["state"]["busy"] is False
    assert out["toasts"] == ["error"]
    assert out["calls"] == ["/api/sellbird/start"]


def test_running_switch_keeps_state_on_success():
    out = _set_running(False, {"success": True})
    assert out["state"]["running"] is False
    assert out["toasts"] == ["success"]
    assert out["calls"] == ["/api/sellbird/stop"]
    lost = _set_running(True, None)  # API offline
    assert lost["state"]["running"] is False and lost["toasts"] == ["error"]


# ── UI kit ──

KIT = ("escHtml", "jsq", "safeHref", "icon", "uiDash", "uiBadge", "uiPageHead", "uiCard", "uiMetricStrip", "uiTabs",
       "uiChips", "uiSwitch", "uiTable", "uiPager", "uiRowMenu", "uiEmpty", "uiBanner", "uiColumns",
       "loadColumns", "saveColumns", "pageSlice")


def kit(call, prelude=""):
    return run_js(KIT, call, prelude)


def test_badge_tones_and_escaping():
    assert "is-neutral" in kit("uiBadge('bogus', 'X')")
    assert "is-success" in kit("uiBadge('success', 'Done', 'check')")
    assert "&lt;b&gt;x&lt;/b&gt;" in kit("uiBadge('success', '<b>x</b>')")


def test_table_empty_escape_and_visible_columns():
    cols = "[{key:'a', header:'A'}, {key:'b', header:'B'}]"
    assert "Nothing here yet" in kit(f"uiTable({{columns:{cols}, rows:[]}})")
    html = kit(f"uiTable({{columns:{cols}, rows:[{{a:'<img src=x onerror=1>', b:'y'}}]}})")
    assert "<img" not in html and "ui-table-wrap" in html
    only = kit(f"uiTable({{columns:{cols}, rows:[{{a:'1', b:'2'}}], visible:['a']}})")
    assert ">A<" in only and ">B<" not in only
    empty_cell = kit(f"uiTable({{columns:{cols}, rows:[{{a:null, b:''}}]}})")
    assert "—" in empty_cell and "null" not in empty_cell


def test_table_row_click():
    html = kit("uiTable({columns:[{key:'a', header:'A'}], rows:[{a:'1', id:7}], onRow: r => 'open(' + r.id + ')'})")
    assert 'onclick="open(7)"' in html and "ui-row-link" in html


def test_metric_strip_missing_value():
    html = kit("uiMetricStrip([{label:'Sent'}, {label:'Found', value: 4, delta:'+4', sub:'this week'}])")
    assert "—" in html and "undefined" not in html and "+4" in html


def test_pager_ends():
    last = kit("uiPager({total:120, offset:100, size:50, onPage: o => 'go(' + o + ')'})")
    assert re.search(r"<button[^>]*disabled[^>]*>Next", last)
    first = kit("uiPager({total:120, offset:0, size:50, onPage: o => 'go(' + o + ')'})")
    assert re.search(r"<button[^>]*disabled[^>]*>Previous", first)
    assert "120 results" in first


def test_page_slice_clamps():
    assert json.loads(kit("JSON.stringify(pageSlice([1,2,3,4,5], 99, 2))")) == [5]
    assert json.loads(kit("JSON.stringify(pageSlice([1,2,3], -4, 2))")) == [1, 2]


def test_page_head_crumbs_escaped():
    html = kit("uiPageHead({title:'Outbox', crumbs:[{label:'<i>x</i>', js:'goTab(\"outbox\")'}]})")
    assert "ui-crumbs" in html and "&lt;i&gt;" in html and "<i>x" not in html


def test_columns_storage_failure_falls_back():
    prelude = "const localStorage = {getItem(){ throw new Error('no'); }, setItem(){ throw new Error('no'); }};"
    assert json.loads(kit("JSON.stringify(loadColumns('t', ['a','b']))", prelude)) == ["a", "b"]
    kit("saveColumns('t', ['a'])", prelude)  # must not throw
    ok = "const store = {}; const localStorage = {getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; }};"
    assert json.loads(kit("(saveColumns('t', ['b']), JSON.stringify(loadColumns('t', ['a','b'])))", ok)) == ["b"]


def test_tabs_chips_switch_menu_empty_banner():
    tabs = kit("uiTabs([{key:'r', label:'To review', count:3}, {key:'s', label:'Sent'}], 'r', k => 'pick(' + JSON.stringify(k) + ')')")
    assert 'aria-selected="true"' in tabs and "To review" in tabs and ">3<" in tabs
    assert "&lt;" in kit("uiChips([{key:'a', label:'<x>', on:true}], k => 'f()')")
    sw = kit("uiSwitch({id:'s1', checked:true, label:'On', onChange:'go(this.checked)'})")
    assert re.search(r"\schecked(?=[\s>])", sw) and 'role="switch"' in sw
    menu = kit("uiRowMenu([{label:'Delete', js:'del()', danger:true}])")
    assert "danger" in menu and "del()" in menu
    assert "&lt;" in kit("uiEmpty('<t>', 'd')")
    assert "&lt;" in kit("uiBanner({title:'<t>', body:'b'})")
    assert "&lt;" in kit("uiCard({title:'<t>', body:'x'})")


# ── Today ──

TODAY = KIT + ("parseTs", "relTime", "dayLabel", "timeOfDay", "own", "actionText", "activityWhen", "stepBadge", "runBadge",
               "todaySummary", "todayNext", "todayNeedsYou", "pipelineTable", "stageGrid", "runsTable", "activityTable")


def today(call):
    return run_js(TODAY, call, "const AGENT_ICONS = {};")


def test_pipeline_table_all_zero_is_waiting():
    live = {"steps": [{"label": "Find businesses", "detail": "", "state": "waiting", "done": 0, "total": 0},
                      {"label": "Sent", "detail": "awaiting approval", "state": "waiting", "done": 0, "total": 3}],
            "cost_usd": 0}
    html = today(f"pipelineTable({json.dumps(live)})")
    assert html.count("Waiting") == 2 and "NaN" not in html and "undefined" not in html
    assert "0 of 3" in html and "—" in html


def test_pipeline_states_map_to_badges():
    live = {"steps": [{"label": "A", "state": "done", "done": 2, "total": 2},
                      {"label": "B", "state": "running", "done": 1, "total": 5},
                      {"label": "<b>C</b>", "state": "partial", "done": 1, "total": 5}]}
    html = today(f"pipelineTable({json.dumps(live)})")
    assert "Done" in html and "In progress" in html and "is-success" in html and "is-info" in html
    assert "&lt;b&gt;C" in html


def test_needs_you_empty_and_escaped():
    assert today("todayNeedsYou([])") == ""
    html = today("todayNeedsYou([{title:'<b>x</b>', detail:'d', action:'Open', tab:'outbox', tone:'warn'}])")
    assert "&lt;b&gt;x" in html and "goTab(" in html


def test_next_banner_says_nothing_needs_you_when_queue_empty():
    html = today("todayNext({next:'Find emails', next_tab:'prospects'}, 0)")
    assert "Next · Find emails" in html and "Nothing needs you right now" in html and "Go" in html
    assert "Nothing needs you" not in today("todayNext({next:'Find emails'}, 2)")
    assert today("todayNext({}, 0)").count("Nothing needs you") == 1


def test_stage_grid_zero_total():
    html = today("stageGrid({}, 0)")
    assert "0%" in html and "NaN" not in html and "To write" in html and "Closed out" in html


def test_summary_missing_stats():
    html = today("todaySummary({}, null)")
    assert "Contacts found" in html and "Waiting on you" in html and "undefined" not in html and "NaN" not in html


def test_runs_and_activity_tables():
    runs = today("runsTable([{stage:'profile', status:'completed', records:3, cost_usd:0, started_at:'2026-01-01 10:00:00'}])")
    assert "Profile" in runs and "Completed" in runs and "3 records · free" in runs
    assert "Nothing" in today("runsTable([])")
    act = today("activityTable([{action_type:'outbox_edited', agent:'<i>dashboard</i>', created_at:'2026-01-01 10:00:00'}])")
    assert "You edited a draft" in act and "&lt;i&gt;" in act
