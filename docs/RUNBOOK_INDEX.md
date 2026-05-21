# Runbook Index

Operational playbooks for sitelayer's most common production incidents.
Each runbook is one page — single engineer at 3am should not need to read
an essay.

For broad on-call orientation (5xx spikes, DB down, Clerk outage, cert
renewal, etc.), see [`INCIDENT_RESPONSE.md`](./INCIDENT_RESPONSE.md). The
runbooks below are deeper dives on specific failure modes that the
ops-readiness audit identified as likely.

## Templates

| File                                                 | Purpose                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`POSTMORTEM_TEMPLATE.md`](./POSTMORTEM_TEMPLATE.md) | 30-minute blameless postmortem skeleton. Save filled copies under `docs/postmortems/`. |

## Runbooks

| File                                                                   | Symptom                                                                                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [`RUNBOOK_QBO_CIRCUIT.md`](./RUNBOOK_QBO_CIRCUIT.md)                   | QBO push halted; `CircuitOpenError` in Sentry; mutation_outbox depth growing for QBO types.                                               |
| [`RUNBOOK_NOTIFICATION_BACKLOG.md`](./RUNBOOK_NOTIFICATION_BACKLOG.md) | `notifications.status='pending'` count > 100; users say confirmations never arrived.                                                      |
| [`RUNBOOK_CONNECTION_POOL.md`](./RUNBOOK_CONNECTION_POOL.md)           | API 503s; `Connection terminated unexpectedly` / `timeout exceeded when trying to connect`.                                               |
| [`RUNBOOK_SPACES_UPLOAD.md`](./RUNBOOK_SPACES_UPLOAD.md)               | Blueprint upload 500s; `Failed to upload to Spaces` in API logs.                                                                          |
| [`RUNBOOK_SPACES_CORS.md`](./RUNBOOK_SPACES_CORS.md)                   | Web client throws CORS errors fetching presigned blueprint URLs; flipping `BLUEPRINT_DOWNLOAD_PRESIGNED=1`.                               |
| [`RUNBOOK_CHAT_DISPATCH.md`](./RUNBOOK_CHAT_DISPATCH.md)               | Operator-context chat widget reply loop wiring (MESH_API_URL, SITELAYER_PUBLIC_BASE, SITELAYER_CHAT_WEBHOOK_TOKEN) + rotation discipline. |

## Existing runbooks

| File                                                                               | Purpose                                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`runbooks/qbo-labor-payroll-cutover.md`](./runbooks/qbo-labor-payroll-cutover.md) | Flipping `QBO_LIVE_LABOR_PAYROLL=1` against real QBO TimeActivity.   |
| [`DR_RESTORE.md`](./DR_RESTORE.md)                                                 | Postgres restore — PITR fork and logical-dump replay.                |
| [`SECRET_ROTATION.md`](./SECRET_ROTATION.md)                                       | Rotating Clerk, QBO, DO Spaces, deploy-SSH credentials.              |
| [`SUPPORT_DEBUG_PACKETS.md`](./SUPPORT_DEBUG_PACKETS.md)                           | Capturing a debug packet to investigate a single user's broken flow. |

## Authoring a new runbook

Keep them one page. The format that has worked:

1. **Symptom** — what the operator actually sees, not the underlying cause.
2. **Detection** — which Sentry tag / Prometheus metric / API endpoint
   surfaces the signal.
3. **Common causes** — ordered by frequency, not severity.
4. **Diagnosis** — bash blocks the operator can paste, in the order they
   should try them.
5. **Mitigation (in order)** — wait-it-out first, escalations last.
6. **Verifying recovery** — the smoke check that confirms the fix.
7. **Post-incident** — link back to `POSTMORTEM_TEMPLATE.md`.

Cross-link from the [Operating Rules](../CLAUDE.md#operating-rules-post-mvp-operate-mode)
section of `CLAUDE.md` so on-call agents find the runbook from the rule
that gestures at the relevant footgun.
