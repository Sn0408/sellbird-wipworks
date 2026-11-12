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
