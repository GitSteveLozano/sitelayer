# Support Debug Packets

Support packets are the handoff artifact for investigating user-reported issues.
They are intentionally bounded and redacted: collect request IDs, route/state
summaries, API statuses, audit events, queue rows, and safe entity summaries
without storing broad request/response bodies.

## User Flow

1. The signed-in app records a rolling browser timeline in session storage:
   route changes, UI actions, toasts, frontend errors, API request metadata,
   and compact app-shell state.
2. The user clicks the support button in the app header, describes the problem,
   and submits.
3. `POST /api/support-packets` stores the client packet and enriches it with
   server-side context.
4. The response returns a `support_id` that can be shared with support.

## Agent Flow

Give the agent a support ID, then fetch:

```text
GET /api/support-packets/<support_id>
```

The response includes:

- `support_packet.client`: browser timeline, request timeline, state snapshots,
  browser/build metadata, and offline queue summary.
- `support_packet.server_context`: request IDs, trace IDs, queue depth, audit
  events, mutation outbox rows, sync event rows, and a safe project-domain
  snapshot when a project ID was visible.
- `agent_prompt`: a compact investigation prompt that names the problem, route,
  build, actor, request IDs, and trace IDs.

The expected investigation order is:

1. Read the user's problem and current route.
2. Follow the client timeline around the reported time.
3. Correlate failing API calls by `request_id`.
4. Check audit events for the same request IDs or actor.
5. Check `mutation_outbox` and `sync_events` for pending, failed, or dropped
   async work.
6. Use trace IDs with Sentry or `/api/debug/traces/:id` when a deeper trace is
   needed.

## Retention And Access

Support packets expire after `SUPPORT_PACKET_RETENTION_DAYS`, defaulting to 30
days. Creation is available to any authenticated company member. Retrieval and
listing require the `admin` company role.

## Privacy Rules

The recorder and API redaction remove obvious secrets, auth headers, cookies,
tokens, emails, and phone numbers. Do not add raw request bodies, response
bodies, PDFs, media, or unmasked Sentry replay data to support packets.
