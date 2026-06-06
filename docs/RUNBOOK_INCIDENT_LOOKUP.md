# Runbook: incident → trace → LLM-debuggable bundle

Goal: from an incident report — in-app capture, **or just an email** ("the
estimate page errored around 2pm") — get to the request/trace, the **events that
led up to it**, and a bundle you can paste straight to an LLM to diagnose.

## TL;DR

```bash
# you have the request id (best case — the UI now shows it on errors):
DATABASE_URL="$PROD_RO_DATABASE_URL" npx tsx scripts/incident.ts --request-id <uuid> > incident.md

# you only have an email + rough time (the email case):
DATABASE_URL=... npx tsx scripts/incident.ts \
  --email someone@company.com --around "2026-06-06T14:30" --window 30 --route /estimate > incident.md

# then: paste incident.md to an LLM — the bundle ends with the exact prompt to use.
```

`scripts/incident.ts` resolves email→company, time-slices `audit_events` +
`mutation_outbox` + `sync_events` + `context_work_items` + `capture_sessions`,
ranks **candidate requests** by error count, builds the chronological
**timeline**, resolves the **trace_id** from the rows' `sentry_trace`, and emits
markdown with the Sentry links + "go deeper" pointers.

## What the user can give you (and what to do with it)

| They report                                                             | Use                                                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| a **request id** (shown in the error UI footer / `x-request-id` header) | `--request-id <id>` — direct, one shot                                                                           |
| a **trace id**                                                          | `--trace-id <hex>`                                                                                               |
| an **error id** (the unhandled-error screen now shows one)              | look it up in Sentry → get the trace → `--trace-id`                                                              |
| just **email + time + page**                                            | `--email … --around … --window … --route …` → pick a candidate → re-run `--request-id`                           |
| an **in-app capture** (the Capture button)                              | it already created a `context_work_item` with `route` + `capture_session_id`; time-slice around its `created_at` |

## The pieces that make this work (all in sitelayer today)

- **request_id** on every request (`x-request-id` header + 500 response body), stamped on `audit_events` / `mutation_outbox` / `sync_events` rows and Sentry tags.
- **Error UI surfaces it**: data-fetch errors show a copyable Trace ID (`components/shell/ErrorState.tsx`); the unhandled-error screen (`main.tsx` `RootError`) now shows **error id + time + page** for the user to quote.
- **trace propagation**: `sentry_trace` flows API→worker; the worker re-enters the trace, so the queue hop is a child span.
- **`GET /api/debug/traces/:id?by=request_id`** — joins the Sentry trace + the local queue/audit/work-item rows (Bearer `DEBUG_TRACE_TOKEN`; prod needs `DEBUG_ALLOW_PROD=1`). The incident tool prints the exact call.
- **Sentry** holds the spans + structured logs (keyed by `trace_id`, `enableLogs:true`). Set `SENTRY_ORG` + `SENTRY_AUTH_TOKEN` and the tool inlines the trace + gives the logs URL.
- **App logs** are otherwise ephemeral (Docker json-file). Deep dive: `ssh sitelayer@<droplet> 'docker logs sitelayer-api-1 2>&1 | grep <request_id>'` (the tool prints this line).

## Gaps / when this falls short

- **A pure 5xx with no DB write** leaves no `audit_events`/queue row — the timeline is thin; lean on the Sentry trace + the container-log grep (the tool points you there).
- **No log aggregator** (Loki/Axiom) — only Sentry-by-trace + ephemeral container logs. If incident volume grows, add one; the request_id/trace_id are already on every line.
- **No event-id→trace reverse index** — a Sentry error id needs one Sentry-UI hop to get the trace.
