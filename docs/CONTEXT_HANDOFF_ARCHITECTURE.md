# Context Handoff And Audit Trail Architecture

- **Status:** proposed 2026-05-21
- **Scope:** Sitelayer work requests, support packets, agent/human handoffs, and audit/event timelines
- **Inputs:** local repo inspection, six parallel agent sweeps, Gemini critique

## Decision

Build a first-party Sitelayer **Work Request** flow backed by support packets and a dedicated append-only handoff event table.

Do not make Mesh, Linear, or `workflow_event_log` the canonical work tracker. Sitelayer owns customer-visible context, permissions, redaction, and review. Mesh is an optional operator execution adapter. GitHub remains the collaborator-facing issue/PR surface when repo work needs to leave Sitelayer.

The architecture is:

1. `Probe/Capture` gathers compact browser and page state.
2. `support_debug_packets` stores the bounded evidence packet.
3. `context_work_items` stores the current coordination view.
4. `context_handoff_events` stores the append-only timeline of messages, decisions, dispatches, proposals, reviews, and resolution.
5. `mutation_outbox` handles async adapter delivery.
6. Mesh/GitHub/Linear adapters are optional sinks, not authorities.

## Why This Fits The Current System

Sitelayer already has most of the substrate:

- `support_debug_packets` is the right context artifact. It already captures client context, server context, request IDs, traces, domain snapshots, queue rows, audit rows, and workflow events.
- `audit_events` is the domain and human action audit trail. It should keep recording entity mutations and operator-visible actions.
- `workflow_event_log` is the deterministic reducer replay log. It must stay clean: workflow events, state versions, reducer snapshots, and replay assertions only.
- `mutation_outbox` and `sync_events` are side-effect and delivery ledgers. They are not the long-term semantic timeline.
- `ai-chat` already proves the loop: stage message, audit it, dispatch to Mesh, receive response, record response.
- Mesh already has tasks, runs, append-only task events, task traces, execution context, and PEL context injection. Those are useful for operator execution, not required for every collaborator.

The missing piece is a local timeline that can say: this issue was filed from this app state, this packet supported it, this human or agent said these things, these decisions were made, this task was dispatched, this proposal came back, this person reviewed it, and this is how it resolved.

## Product Shape

Add a first-party Work Request flow:

1. A global or page-level **Work Request** action opens a sheet.
2. The sheet captures a summary, category, severity, optional notes, and a compact state preview.
3. The preview shows route, entity, company/user, workflow state/version, last workflow events, recent request IDs, trace IDs, queue status, and relevant domain snapshot.
4. Submit creates a `support_debug_packet`, a `context_work_items` row, and a first `context_handoff_events` row in one server-side transaction.
5. Triage chooses `Human`, `Agent`, or `Both`.
6. Agents can investigate, draft fixes, or propose actions. Production workflow mutations still require existing deterministic workflow events and review gates.
7. Humans can review, assign, ask follow-up, link a PR, mark resolved, or reopen.

Minimal UI surfaces:

- Global/page **Work Request** button.
- Create request sheet with context preview.
- `/work` inbox with status tabs.
- Work request detail page with original packet, timeline, dispatch status, and review controls.
- Source-page indicator such as "2 open requests for this estimate/project."

## Data Model

### `context_work_items`

This is a read and coordination model, not the audit authority.

Suggested v1 columns:

```sql
id uuid primary key default gen_random_uuid(),
company_id uuid not null references companies(id) on delete cascade,
support_packet_id uuid not null references support_debug_packets(id) on delete restrict,
title text not null,
summary text,
status text not null,
lane text not null default 'triage',
severity text,
route text,
entity_type text,
entity_id text,
assignee_user_id text,
created_by_user_id text,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
resolved_at timestamptz,
metadata jsonb not null default '{}'::jsonb
```

Suggested statuses:

- `new`
- `triaged`
- `agent_running`
- `human_assigned`
- `review_ready`
- `resolved`
- `reopened`
- `wont_do`

The row may be updated transactionally with handoff events in v1. If this grows into complex state, define a reducer and make `context_work_items` a projection.

### `context_handoff_events`

This is the canonical handoff timeline.

Gemini's strongest critique was correct: a dedicated table is justified, but v1 should not promote the entire ontology into top-level columns. Keep only fields that the app immediately filters, joins, or enforces. Put evidence, delegation, reversibility, retention, and capability metadata into `metadata` until concrete behavior depends on them.

Suggested v1 columns:

```sql
id uuid primary key default gen_random_uuid(),
company_id uuid not null references companies(id) on delete cascade,
work_item_id uuid not null references context_work_items(id) on delete cascade,
event_type text not null,
actor_kind text not null,
actor_user_id text,
actor_ref text,
source_system text not null default 'sitelayer',
payload jsonb not null default '{}'::jsonb,
metadata jsonb not null default '{}'::jsonb,
idempotency_key text,
causation_event_id uuid,
correlation_id uuid,
request_id text,
sentry_trace text,
sentry_baggage text,
build_sha text,
redaction_version text not null default 'v1',
occurred_at timestamptz not null default now(),
recorded_at timestamptz not null default now()
```

Suggested constraints and indexes:

```sql
unique (company_id, idempotency_key) where idempotency_key is not null;
index on (company_id, work_item_id, recorded_at desc);
index on (company_id, event_type, recorded_at desc);
index on (company_id, request_id);
index on (company_id, sentry_trace);
```

Useful v1 event types:

- `work_item.created`
- `work_item.updated`
- `work_item.status_changed`
- `message.added`
- `support_packet.linked`
- `agent.dispatch_requested`
- `agent.dispatch_acknowledged`
- `agent.dispatch_retried`
- `agent.message_received`
- `agent.artifact_attached`
- `agent.proposal_ready`
- `agent.completed`
- `human.assigned`
- `human.review_requested`
- `human.reviewed`
- `external.github_linked`
- `resolution.accepted`
- `resolution.reopened`

Metadata keys to reserve, but not necessarily enforce in v1:

```json
{
  "evidence_refs": [],
  "evidence_level": "correlated_operational_trace",
  "canon_layer": "derived",
  "delegation": {
    "class": "investigate",
    "scope": {},
    "reversibility_class": "easy",
    "reversibility_deadline": null,
    "revocation_status": "active"
  },
  "retention_policy": "default",
  "raw_status": "metadata_only",
  "capability": {
    "issuer": null,
    "audience": null,
    "ttl": null,
    "token_hash": null
  }
}
```

## Adapter Rules

### Mesh

Mesh is an optional execution adapter.

On dispatch:

1. Append `agent.dispatch_requested`.
2. Insert a `mutation_outbox` row with a Mesh dispatch mutation type.
3. Worker claims the row and creates a Mesh task.
4. Store the returned task ID as `agent.dispatch_acknowledged`.
5. Mesh callback appends `agent.message_received`, `agent.proposal_ready`, or `agent.completed`.

Mesh task `execution_context` should carry:

```json
{
  "project_hint": "sitelayer",
  "source_system": "sitelayer",
  "context_handoff": {
    "work_item_id": "...",
    "support_packet_id": "...",
    "callback": {
      "path": "/api/work-requests/.../agent-callback",
      "token_type": "scoped_bearer"
    },
    "request_id": "...",
    "entity": { "type": "...", "id": "..." }
  }
}
```

Mesh completion should never directly mutate canonical Sitelayer workflow state. It proposes, attaches evidence, or links a patch. A human or trusted workflow reducer applies production state transitions.

### GitHub

GitHub is the collaborator-facing implementation surface when the request becomes repo work.

Do not dump raw support packets into GitHub issues. Create a redacted summary with:

- title
- expected behavior
- observed behavior
- reproduction route
- safe build/request IDs
- internal Sitelayer work item link
- PR/check references when they exist

### Linear

Defer Linear. It can later receive summaries for product-roadmap visibility, but it should not own implementation truth or context packets.

## Privacy And Redaction

Redact before insertion into `context_handoff_events`, not only during export.

Never store these in handoff payloads:

- auth headers
- cookies
- Clerk/session tokens
- QBO tokens
- presigned URLs
- raw PDFs
- raster blueprint images
- raw Sentry replays
- raw private PEL logs

Store pointers and hashes instead:

- support packet ID
- entity refs
- request IDs
- trace IDs
- workflow event IDs
- storage paths only when safe
- content hash, mime type, byte size, page count

Cross-person PEL exchange should use redacted projections or capability-scoped summaries, not raw personal logs. The shared work item receives the projection and provenance reference; each person keeps their own private event substrate.

Support packet retention is intentionally narrower than Work Request retention:
expired packets stop joining into Work Request detail, while the durable redacted
timeline and support packet ID remain. Prompt/raw packet reads are audited in
`support_packet_access_log`.

## Failure Modes To Guard

### Split Brain Between Events And Work Items

If `context_handoff_events` and `context_work_items` diverge, the UI can show a resolved item while the timeline says it is still pending. In v1, update both in the same transaction. If lifecycle complexity grows, make the work item row a deterministic projection from events.

### Approval Limbo

Agents should not apply production state without review, but proposals can rot forever. Add stale states:

- `review_ready`
- `review_stale`
- `proposal_expired`

Start with a simple scheduled check that marks old unreviewed proposals stale after a configurable interval.

### Lost Responses And Duplicate Work

Browser-created work items need a stable `client_request_id`, scoped to the
creator. If the API commits but the response is lost, retrying the same create
should replay that user's existing work item instead of writing a second support
packet and timeline. Dispatch has the same rule at the queue layer: one work
item owns one Mesh dispatch idempotency key, and repeated dispatch calls observe
the existing outbox row without resetting retry backoff.

### Context Leakage

Adapters must not forward raw `client` or `server_context` JSON. External systems get redacted summaries and links back into Sitelayer.

### Rebuilding Queue Machinery

Use `mutation_outbox` first. Add a separate `context_dispatches` table only when multiple adapters need independent retries, leases, priorities, or delivery state that does not fit the existing outbox.

### Polluting Workflow Replay

Do not put messages, agent comments, GitHub links, or triage changes into `workflow_event_log`. That table is for deterministic reducer replay only.

## Smallest Shippable Slice

1. Add this architecture doc.
2. Add migrations for `context_work_items` and lean `context_handoff_events`.
3. Add writer helpers in the API mutation layer.
4. Dual-write `support_debug_packets` creation into a `work_item.created` handoff event when the request is created from the new Work Request flow.
5. Add API endpoints:
   - `POST /api/work-requests`
   - `GET /api/work-requests`
   - `GET /api/work-requests/:id`
   - `POST /api/work-requests/:id/events`
   - `POST /api/work-requests/:id/dispatch/mesh`
6. Add the create sheet and `/work` inbox.
7. Use `mutation_outbox` for Mesh dispatch and writeback.
8. Extend support packet server context to include handoff events for the selected work item.
9. Add stale proposal handling.
10. Add GitHub summary export only after the Sitelayer-to-Mesh round trip works.

## Open Design Choices

- Whether `context_work_items.status` stays transactionally updated or becomes a reducer projection.
- Whether `ai-chat` migrates immediately to `context_handoff_events` or first dual-writes while existing audit rows remain stable.
- Which actor taxonomy to use for `actor_kind`: likely `user`, `agent`, `system`, `external`.
- How long support packets should remain available after a work item resolves.
- Whether agent prompts should be stored as full redacted snapshots, hashes plus artifact refs, or both.

## Bottom Line

This is not a new tracker monolith. It is a local context-and-handoff layer over primitives Sitelayer already has.

`support_debug_packets` answer "what state was the user in?"
`context_work_items` answers "what is the current coordination state?"
`context_handoff_events` answers "what happened in the handoff, who said what, and what evidence did they use?"
`workflow_event_log` answers "what deterministic workflow state changed?"
`audit_events` answers "what domain/user action was audited?"
`mutation_outbox` answers "what async side effect is being delivered or retried?"
Mesh answers "what did the operator agent system do after Sitelayer asked for help?"
