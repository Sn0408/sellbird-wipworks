# Dashboard redesign: what the mockup shows that the dashboard doesn't

The redesign changed only the dashboard's HTML, CSS and JavaScript. A few things in the
design mockup need data or actions no endpoint provides, so they were left out or shown
with an honest label instead. Each could come back with a backend change.

## Left out (no endpoint)

| Tab | Mockup element | Why |
|---|---|---|
| Today | Sparkline charts in the summary strip | Not in the mockup's final strip; the numbers stay |
| Outbox | "Sent today of N daily limit" | `/api/outbox` doesn't return the daily limit |
| Outbox | Which inbox an email goes out from; "Rewrite with Sellbird" | No field / no endpoint |
| Inboxes | Bounces metric, "Scheduled from this inbox", SMTP host, connected date | Not returned per inbox |
| Signals | Cohort "Preview" and "Save cohort" | No save endpoint; the count is already live |
| Your company | "Updated" column, training time, trained-site URL and fact count | Not stored |
| Campaigns | New campaign wizard, Pause, Add prospects, "Sends from", audience/window/limit details, opened counts, Edit sequence | No endpoints |
| Companies | Per-company Export, "Approve for outreach", "Write emails", discovery run/query | No endpoints / not returned |
| Contacts | Row selection, "Do not contact", "Write email", per-contact replies | No bulk actions / endpoints |
| Controls | Restart button, heartbeat interval | No restart endpoint; interval not returned |
| Settings | SMTP "Test connection" | Only Instantly has a test endpoint |
| Help | Getting-started done ticks | Help can't know which steps are done |

## Shown with an honest label

- Outbox Sent and Didn't send: "last 25" when the endpoint's 25-row cap is reached.
- Discover Spent: "last 25 runs" (`/api/runs` returns at most 25), not "this month".
- Signals "Companies scored": the most-collected signal's count, labelled so.
- Activity "Events today": "in the last 100 events" when the 100-row cap is reached.
- Pipeline steps that started but aren't running show "Partly done", not "In progress".
