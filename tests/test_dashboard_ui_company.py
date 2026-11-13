"""Your company and Campaigns, rebuilt to the new design.

The render helpers are pulled out of app.js by name and run under node.
All data here is fictional (example.com).
"""
import json

from tests.test_dashboard_ui import KIT, run_js

STATUS_HELPERS = ("own", "STATUS", "statusMeta", "parseTs", "relTime")
COMPANY = KIT + STATUS_HELPERS + (
    "companySections", "companySummary", "companySectionsTable", "companySectionPage",
    "objectionRow", "knowledgeFacts", "competitorItems", "uiDetails", "lines", "coStatusBadge",
    "coField", "coInput", "coArea",
)
CAMPAIGNS = KIT + STATUS_HELPERS + (
    "cpBadge", "cpFilterKey", "campaignStats", "campaignCadence", "campaignsTable", "campaignCountTabs",
    "campaignDetailPage", "campaignRecipientActions", "campaignProgress", "fillMergeVars",
    "uiDetails",
)

FULL = {
    "offer": {"entry": "a free audit of your booking page", "entry_ideas": [], "proposed": None},
    "product": {"name": "Example Sites", "description": "Websites for local shops", "pricing": "Fixed monthly fee",
                "key_benefits": ["Fast", "Cheap"], "objection_responses": {"Too pricey": "It pays back in a month"}},
    "icp": {"industries": ["Dental clinics"], "titles": ["Owner"], "company_size": "1-50",
            "geography": ["Springfield"]},
    "persona": {"name": "Alex Example", "role": "Founder", "company": "Example Co", "email": "alex@example.com",
                "tone": "Plain"},
    "knowledge": "# Product\n\n## What We Sell\nWebsites for local shops.\n\n## Pricing\n- Fixed monthly fee\n",
    "competitors": "# Cards\n\n## vs. Example Agency\nLarge upfront bills.\n",
}


def _company(call, data):
    return run_js(COMPANY, call, prelude="const data = " + json.dumps(data) + ";")


def test_company_section_with_no_value_is_missing_with_dash():
    html = _company("companySectionsTable(data)", {})
    assert "Missing" in html
    assert "—" in html
    assert "undefined" not in html and "NaN" not in html


def test_company_full_sections_are_set_and_trained():
    html = _company("companySectionsTable(data)", FULL)
    assert html.count("is-success") == 6
    assert "Trained" in html and "Missing" not in html
    assert "openCompanySection(" in html


def test_company_value_is_escaped():
    data = dict(FULL, product=dict(FULL["product"], name="<b>Bold</b>"))
    html = _company("companySectionsTable(data)", data)
    assert "<b>Bold" not in html and "&lt;b&gt;Bold&lt;/b&gt;" in html


def test_company_summary_counts_and_empty():
    html = _company("companySummary(data)", FULL)
    assert "6 of 6" in html and "Alex Example" in html
    empty = _company("companySummary(data)", {})
    assert "0 of 6" in empty and "undefined" not in empty and "NaN" not in empty


def test_company_offer_page_keeps_proposed_offer_and_actions():
    data = dict(FULL, offer=dict(FULL["offer"], proposed={"entry": "<i>a free plan</i>", "why": "fits"}))
    html = _company("companySectionPage('offer', data)", data)
    for needle in ("useProposedOffer()", "dismissProposedOffer()", "saveOffer()", "previewOffer()",
                   "suggestOffers()", 'id="offer-entry"', 'id="offer-ideas"', 'id="offer-preview"',
                   "Your company"):
        assert needle in html, needle
    assert "<i>a free plan" not in html


def test_company_section_pages_keep_their_save_handlers():
    assert "saveCompanySection('product')" in _company("companySectionPage('sell', data)", FULL)
    assert "saveCompanySection('icp')" in _company("companySectionPage('audience', data)", FULL)
    assert "saveCompanySection('persona')" in _company("companySectionPage('from', data)", FULL)
    objections = _company("companySectionPage('objections', data)", FULL)
    assert "saveCompanySection('product', true)" in objections and "addObjection()" in objections
    assert "Too pricey" in objections


def test_company_learned_page_shows_facts_and_competitors():
    html = _company("companySectionPage('learned', data)", FULL)
    assert "What We Sell" in html and "Websites for local shops." in html
    assert "Example Agency" in html and "Large upfront bills." in html
    empty = _company("companySectionPage('learned', data)", {})
    assert "sellbird train" in empty and "undefined" not in empty


CAMPAIGN = {
    "id": "c1", "name": "Dental outreach", "status": "active", "created_at": "2026-01-01 10:00:00",
    "prospect_ids": ["p1"], "footer": "", "send_as": "",
    "sequence": [{"step": 1, "subject": "Hi {{first_name}}", "body": "Hello {{first_name}} at {{company}}",
                  "delay_days": 0},
                 {"step": 2, "subject": "Again", "body": "Following up", "delay_days": 3}],
    "recipients": [{"id": "p1", "email": "ann@example.com", "first_name": "<b>Ann</b>", "last_name": "",
                    "company": "Example Dental", "status": "new", "email_status": "verified",
                    "source": "company_website", "sent_by_hand": False, "can_mark_sent": True,
                    "can_send_by_hand": True}],
}


def _campaigns(call, data):
    return run_js(CAMPAIGNS, call, prelude="const data = " + json.dumps(data) + ";")


def test_campaign_detail_with_no_contacts_shows_empty_state():
    c = dict(CAMPAIGN, recipients=[], prospect_ids=[])
    html = _campaigns("campaignDetailPage(data, 0)", c)
    assert "No contacts in this campaign" in html
    assert "undefined" not in html and "NaN" not in html


def test_campaign_preview_fills_merge_vars_escaped():
    html = _campaigns("campaignDetailPage(data, 0)", CAMPAIGN)
    assert "Hello &lt;b&gt;Ann&lt;/b&gt; at Example Dental" in html
    assert "<b>Ann</b>" not in html and "{{first_name}}" not in html


def test_campaign_detail_keeps_hand_send_actions_and_feedback():
    html = _campaigns("campaignDetailPage(data, 0)", CAMPAIGN)
    assert "openInGmail(0,0,0)" in html and "markSent(0,0,this.checked)" in html
    assert "fbCampaign(0)" in html and "closeCampaign()" in html


def test_campaign_follow_up_actions_for_people_emailed_by_hand():
    r = dict(CAMPAIGN["recipients"][0], sent_by_hand=True, can_mark_sent=False, can_send_by_hand=False)
    html = _campaigns("campaignDetailPage(data, 0)", dict(CAMPAIGN, recipients=[r]))
    assert "Sent by you" in html and "openInGmail(0,1,0)" in html


def test_campaigns_table_escapes_and_handles_empty():
    rows = [dict(CAMPAIGN, name="<img src=x onerror=1>")]
    html = _campaigns("campaignsTable(data)", rows)
    assert "<img" not in html and "openCampaign(" in html and "3 days" not in html
    assert "day 0, +3" in html
    empty = _campaigns("campaignsTable(data)", [])
    assert "No campaigns" in empty and "undefined" not in empty


def test_campaign_count_tabs():
    rows = [CAMPAIGN, dict(CAMPAIGN, id="c2", status="paused")]
    html = _campaigns("campaignCountTabs(data, 'all')", rows)
    assert "All" in html and "Paused" in html and 'aria-selected="true"' in html
