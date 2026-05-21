# Context Handoff Implementation Plan

- **Status:** proposed 2026-05-21
- **Parent architecture:** `docs/CONTEXT_HANDOFF_ARCHITECTURE.md`
- **Goal:** ship context-aware work requests with an append-only audit trail and composable agent/human handoffs

## Target Outcome

A Sitelayer user can file a Work Request from the website and the system already knows the state they were in: route, entity, workflow state, recent requests, trace IDs, queue state, build SHA, and safe domain context.

The resulting work item has a durable timeline that shows the messages, agent dispatches, proposals, reviews, external links, and resolution path that built or fixed the feature. That timeline lives in Sitelayer, not Mesh, Linear, GitHub, or `workflow_event_log`.

## Serving Boundaries

| Surface                | Served From                                               | Owner                     | Authority                                |
| ---------------------- | --------------------------------------------------------- | ------------------------- | ---------------------------------------- |
| Work Request UI        | Sitelayer web app, canonical `/work` and legacy `/m/work` | Sitelayer product         | Current user-facing coordination         |
| Work Request API       | Sitelayer API, `/api/work-requests*`                      | Sitelayer backend         | Work item lifecycle and handoff timeline |
| Evidence packet        | Sitelayer DB, `support_debug_packets`                     | Sitelayer backend/support | Bounded redacted app/server state        |
| Handoff timeline       | Sitelayer DB, `context_handoff_events`                    | Sitelayer backend         | Canonical handoff audit trail            |
| Coordination row       | Sitelayer DB, `context_work_items`                        | Sitelayer backend         | Mutable current state in v1              |
| Workflow replay        | Sitelayer DB, `workflow_event_log`                        | Sitelayer workflows       | Deterministic reducer state only         |
| Domain audit           | Sitelayer DB, `audit_events`                              | Sitelayer backend         | Domain/user action audit                 |
| Async adapter dispatch | Sitelayer worker, `mutation_outbox`                       | Sitelayer worker          | Delivery/retry state                     |
| Agent execution        | Mesh/control-plane API                                    | Operator automation       | Execution telemetry only                 |
| Code implementation    | GitHub issues/PRs                                         | Repo maintainers          | Collaborator-visible code/review trail   |
| Product planning       | Linear, deferred                                          | Product owner             | Optional summary projection only         |

The rule is: Sitelayer owns context, permissions, redaction, lifecycle, review, and timeline. External systems receive projections or tasks.

## Product Placement

Serve Work Requests inside the active mobile-first workspace shell, not the retired desktop shell.

- Add `/work` as a canonical authenticated route in `MobileShell`.
- Let `/m/work` work through the existing legacy mobile mount.
- Do not add a sixth permanent bottom tab.
- Link Work Requests from `More`, source-page actions, entity status indicators, and review banners.
- Use existing mobile component primitives from `components/m`.

Initial product surfaces:

1. `WorkRequestAction`: reusable button/action mounted on entity/detail pages.
2. `WorkRequestCreateSheet`: summary, category, severity, lane recommendation, context preview.
3. `WorkRequestsInbox`: `/work`, status tabs and list rows.
4. `WorkRequestDetail`: `/work/:id`, context card, timeline, messages, dispatch/review controls.
5. Entity indicator: source pages show open request counts like `Agent running` or `1 review ready`.

First pages to wire:

- mobile estimate push detail
- project detail
- takeoff/estimate review surfaces
- rental requests/detail
- foreman field issue/detail

## Data Ownership

### `support_debug_packets`

Owns the starting evidence packet.

Responsibilities:

- bounded client context
- server context joins
- request IDs and trace IDs
- workflow and queue tails
- domain snapshot
- redaction and expiry

It does not own lifecycle state, comments, triage, or resolution.

### `context_work_items`

Owns the current coordination view in v1.

Responsibilities:

- status
- lane
- severity
- assignee
- source route/entity
- support packet link
- latest summary/resolution metadata

In v1, update this row transactionally with timeline events. If lifecycle rules get complex, make it a projection from `context_handoff_events`.

### `context_handoff_events`

Owns the semantic audit timeline.

Responsibilities:

- work item creation
- messages
- human assignment
- status changes
- agent dispatches
- agent callbacks
- proposals
- review decisions
- GitHub/PR links
- resolution/reopen events

It does not rebuild deterministic workflow state. That remains `workflow_event_log`.

### `mutation_outbox`

Owns adapter delivery and retry.

Responsibilities:

- Mesh dispatch requests
- later GitHub/Linear export requests
- retry/failure visibility

Do not create `context_dispatches` until `mutation_outbox` cannot express adapter state.

## Schema Slice

Add `docker/postgres/init/088_context_handoff.sql`.

Create `context_work_items`:

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

Create `context_handoff_events`:

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

V1 check constraints:

- statuses: `new`, `triaged`, `agent_running`, `human_assigned`, `review_ready`, `review_stale`, `proposal_expired`, `resolved`, `reopened`, `wont_do`
- lanes: `triage`, `human`, `agent`, `both`, `done`
- severity: `low`, `normal`, `high`, `urgent`
- actor kind: `user`, `agent`, `system`, `external`

Indexes:

- `context_work_items(company_id, status, updated_at desc)`
- `context_work_items(company_id, entity_type, entity_id, status)`
- `context_work_items(company_id, created_by_user_id, created_at desc)`
- `context_handoff_events(company_id, work_item_id, recorded_at asc)`
- `context_handoff_events(company_id, event_type, recorded_at desc)`
- `context_handoff_events(company_id, request_id)` where present
- `context_handoff_events(company_id, sentry_trace)` where present
- unique partial `context_handoff_events(company_id, idempotency_key)` where present

RLS:

- add company isolation policies in the same migration
- enable and force RLS from day one
- ensure all reads use `withCompanyClient`
- ensure all writes use `withMutationTx`

Update `scripts/check-db-schema.sh` so schema drift checks know these tables.

## API Slice

Add `apps/api/src/context-handoff.ts`.

Exports:

- `sanitizeHandoffJson`
- `createContextWorkItemTx`
- `appendContextHandoffEventTx`
- `updateContextWorkItemWithEventTx`
- `listContextWorkItems`
- `getContextWorkItemWithEvents`
- `buildWorkRequestAgentPrompt`

Extract or reuse support-packet helpers instead of duplicating:

- `sanitizeSupportJson`
- `buildSupportServerContext`
- support packet insert logic

Add `apps/api/src/routes/work-requests.ts`.

Routes:

- `POST /api/work-requests`
- `GET /api/work-requests`
- `GET /api/work-requests/:id`
- `POST /api/work-requests/:id/events`
- `POST /api/work-requests/:id/dispatch/mesh`
- `POST /api/work-requests/:id/agent-callback`

Wire the route in `apps/api/src/routes/dispatch.ts` near support packets.

### `POST /api/work-requests`

Single transaction:

1. sanitize client context
2. build server context
3. insert `support_debug_packets`
4. insert `context_work_items`
5. append `work_item.created`

Returns:

- work item ID
- support packet ID
- status
- route/entity summary

### `POST /api/work-requests/:id/events`

Allowed v1 events:

- `message.added`
- `human.assigned`
- `work_item.status_changed`
- `human.reviewed`
- `resolution.accepted`
- `resolution.reopened`
- `external.github_export_prepared`
- `external.github_linked`

For state-changing events, lock the work item row, append the event, and update `context_work_items` in the same transaction.

### `POST /api/work-requests/:id/dispatch/mesh`

Single transaction:

1. lock work item
2. append `agent.dispatch_requested`
3. update status to `agent_running`
4. insert `mutation_outbox`

Outbox row:

- `entity_type = 'context_work_item'`
- `entity_id = work_item_id`
- `mutation_type = 'dispatch_mesh_work_request'`
- deterministic idempotency key
- payload contains redacted prompt inputs, work item ID, support packet ID, callback URL, route/entity refs

### `POST /api/work-requests/:id/agent-callback`

Callbacks use a per-dispatch scoped bearer token generated when the dispatch is
queued and stored only as a SHA-256 hash on the work item. The
`SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN` env remains a legacy fallback for rows
that predate scoped tokens.

Allowed callback events:

- `agent.message_received`
- `agent.artifact_attached`
- `agent.proposal_ready`
- `agent.completed`

Callback can set status to `review_ready`, but must not mutate production workflow state.

## Mesh Adapter

Use Sitelayer worker plus `mutation_outbox`.

Worker behavior:

1. claim `dispatch_mesh_work_request`
2. call Mesh orchestration API
3. pass `execution_context.context_handoff`
4. append `agent.dispatch_acknowledged`
5. mark outbox applied or retryable failed

Mesh execution context:

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

Important correction: new Work Request dispatch should standardize on Mesh orchestration (`/api/orchestrate/tasks`) rather than copying the older operator-chat `/api/tasks` path unless that older path is confirmed current.

Mesh owns task execution, run telemetry, task events, and task trace. It does not own Sitelayer work item status or production workflow transitions.

## GitHub Adapter

v1 is human-triggered: preparing the redacted GitHub issue body appends
`external.github_export_prepared`; manually linking the issue/PR appends
`external.github_linked`. GitHub is not the authority for Work Request state.

GitHub issue content:

- title
- observed behavior
- expected behavior
- reproduction route
- safe request/build IDs
- internal Sitelayer work item link
- linked PR/checks

Never export raw support packet JSON, raw PDFs, tokens, presigned URLs, Sentry replays, or private PEL/operator logs.

Append `external.github_linked` with issue/PR refs in `context_handoff_events`.

## Linear Adapter

Do not build in v1.

Linear can later receive roadmap summaries, but it should not own implementation truth, support packets, lifecycle state, or agent execution.

## Frontend Slice

Add API client:

- `apps/web/src/lib/api/work-requests.ts`

Add components:

- `apps/web/src/components/work-requests/WorkRequestAction.tsx`
- `apps/web/src/components/work-requests/WorkRequestCreateSheet.tsx`
- `apps/web/src/components/work-requests/WorkRequestContextPreview.tsx`
- `apps/web/src/components/work-requests/WorkRequestStatusPill.tsx`
- `apps/web/src/components/work-requests/WorkRequestTimeline.tsx`

Add screens:

- `apps/web/src/screens/mobile/work-requests.tsx`
- `apps/web/src/screens/mobile/work-request-detail.tsx`

Wire routes in `MobileShell`:

- `work`
- `work/:workItemId`

Create sheet requirements:

- summary
- category
- severity
- lane recommendation
- context preview
- redaction notice
- submit

Detail page requirements:

- status/lane/severity header
- source context card
- support packet link for admins
- ordered timeline
- message composer
- assign human
- ask agent
- review proposal
- mark resolved
- reopen
- link GitHub/PR

Source-page indicator:

- query open work items by entity type/id
- show compact state: `2 open`, `agent running`, `review ready`
- link to work item or entity-scoped list

## Support Packet Enrichment

Extend `buildSupportServerContext` to include related work requests when:

- client includes `work_item_id`
- request IDs match
- entity refs match open work items

Include only bounded rows:

- work item summary rows
- latest handoff events
- safe event payload summaries

Do not embed full support packet bodies inside events or recursively inside new packets.

## Permissions And Privacy

Creation:

- any authenticated company member can create a Work Request

Reading:

- admin/office/foreman can list relevant company work items
- workers can see their own created items and assigned field-related items
- support packet full retrieval remains admin-only unless a support role is added

Agent scope:

- `investigate`: read redacted context and source refs
- `draft`: produce patch/PR/task suggestion
- `propose`: return proposed resolution or next action
- `apply`: not allowed through callback in v1

Metadata vocabulary:

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
  "raw_status": "metadata_only"
}
```

Keep this in `metadata` until the app needs top-level query/enforcement behavior.

## Observability

Metrics:

- `sitelayer_context_handoff_total{action}`
- `sitelayer_context_dispatch_outbox_count{status}`
- `sitelayer_queue_pending_count{queue="mutation_outbox"}`
- `sitelayer_queue_oldest_pending_age_seconds{queue="mutation_outbox"}`
- `sitelayer_queue_dead_count{queue="mutation_outbox"}`

Logs should include:

- `work_item_id`
- `support_packet_id`
- `request_id`
- `sentry_trace`
- `mutation_outbox_id`
- external task/issue ID

Extend `/api/debug/traces/:id` later to include:

- matching work items
- handoff events
- dispatch outbox rows
- Mesh task refs

Backpressure invariants:

- repeated create with the same creator and `client_request_id` replays the existing work item
- repeated Mesh dispatch for the same work item returns the existing outbox row
- API retries do not reset `attempt_count`, `next_attempt_at`, or `error`
- failed rows are reset explicitly by `/dispatch/mesh/retry` after dependency recovery, not by another dispatch click

## Stale Proposal Handling

Add a small worker job after Mesh dispatch works.

Behavior:

- find `review_ready` older than `WORK_REQUEST_REVIEW_STALE_HOURS`, default 72
- append `work_item.status_changed`
- set status `review_stale`

This prevents agent proposals from sitting in permanent limbo.

## Implementation Order

### Phase 0: Contract

- keep `docs/CONTEXT_HANDOFF_ARCHITECTURE.md`
- add this implementation plan
- reconcile later docs that still say Mesh is the Sitelayer issue tracker authority

### Phase 1: Local Data And API

- add migration `088_context_handoff.sql`
- add schema checks
- add backend helper module
- add `POST /api/work-requests`
- add list/detail/event routes
- add route tests

Acceptance:

- create route writes one support packet, one work item, one handoff event
- list/detail return scoped company rows
- event append and status update happen in one transaction
- RLS blocks cross-company reads/writes

### Phase 2: Website UI

- add `/work` and `/work/:id` in `MobileShell`
- add create sheet and context preview
- wire first page action on estimate push detail
- add inbox and detail timeline
- add entity status indicator

Acceptance:

- user can file from a page
- preview shows route/entity/state/request/build context
- raw sensitive fields are absent
- detail page shows ordered timeline

### Phase 3: Support Context Loop

- enrich support packets with linked work items/handoff rows
- expose admin support packet link from Work Request detail
- add debug trace integration

Acceptance:

- support packet can explain the work item that came from it
- work item can point back to the support packet
- debug trace shows request/queue/timeline context

### Phase 4: Mesh Adapter

- add dispatch route
- add outbox mutation type
- add worker handler
- add agent callback route
- add stale proposal worker

Acceptance:

- Mesh unavailable leaves work item usable and dispatch retryable
- successful dispatch appends ack with Mesh task ID
- callback appends proposal/completion and moves to `review_ready`
- callback cannot mutate production workflow state

### Phase 5: GitHub Export

- add redacted issue/PR link flow
- append `external.github_linked`
- update GitHub issue templates only if needed

Acceptance:

- exported issue has enough reproduction context
- no raw support packet data leaves Sitelayer
- PR/check links round-trip into work item timeline

### Phase 6: Hardening

- decide if `context_work_items` should become a reducer projection
- decide if evidence refs need their own table
- decide retention behavior for resolved work items and expired support packets
- add capability-scoped projections only if cross-person PEL exchange becomes real

## Step-By-Step Execution Checklist

Work this list in order. Each step should leave the repo buildable and should not require Mesh unless the step explicitly says it is adapter work.

| Step | Slice                                  | Primary Files                                                  | Owner                    | Exit Gate                                              |
| ---- | -------------------------------------- | -------------------------------------------------------------- | ------------------------ | ------------------------------------------------------ |
| 0    | Lock contracts                         | `docs/CONTEXT_HANDOFF_*.md`                                    | architecture/backend     | docs agree on authority and serving boundaries         |
| 1    | Add DB tables                          | `docker/postgres/init/088_context_handoff.sql`                 | backend                  | migration applies from scratch                         |
| 2    | Add schema/RLS checks                  | `scripts/check-db-schema.sh`, route/RLS tests                  | backend                  | new tables are company-scoped and schema-checked       |
| 3    | Extract support packet write seam      | `apps/api/src/routes/support-packets.ts`, new helper if needed | backend                  | Work Request route can reuse sanitizer/context builder |
| 4    | Add handoff helper module              | `apps/api/src/context-handoff.ts`                              | backend                  | helpers append events and update items transactionally |
| 5    | Implement create route                 | `apps/api/src/routes/work-requests.ts`, `dispatch.ts`          | backend                  | create writes packet + item + event in one tx          |
| 6    | Implement read/event routes            | `work-requests.ts`                                             | backend                  | list/detail/events work with role checks               |
| 7    | Add API tests                          | `apps/api/src/routes/work-requests.test.ts`                    | backend                  | local data/API slice is covered                        |
| 8    | Add support context loop               | `support-packets.ts`, support tests                            | backend/support          | packets can include linked work item context           |
| 9    | Add web API client                     | `apps/web/src/lib/api/work-requests.ts`                        | frontend                 | typed client covers create/list/detail/events          |
| 10   | Add `/work` shell routes               | `apps/web/src/screens/mobile-shell.tsx`, new screens           | frontend                 | inbox/detail routes render in `MobileShell`            |
| 11   | Add create sheet and first page action | work-request components, estimate push page                    | frontend                 | user can file from one real page                       |
| 12   | Add entity status indicators           | work-request components, first source pages                    | frontend                 | source page shows open/request state                   |
| 13   | Add observability hooks                | metrics/logging/debug trace                                    | backend/ops              | trace/debug can find work item context                 |
| 14   | Add Mesh dispatch API/outbox           | `work-requests.ts`, `mutation_outbox` usage                    | backend/worker           | dispatch creates event + retryable outbox row          |
| 15   | Add Mesh worker adapter                | `apps/worker` or `packages/queue`                              | worker/ops               | worker creates Mesh task and appends ack               |
| 16   | Add agent callback route               | `work-requests.ts`                                             | backend/security         | callbacks append proposals without workflow mutation   |
| 17   | Add stale proposal sweeper             | `apps/worker`                                                  | worker/ops               | old `review_ready` items become `review_stale`         |
| 18   | Add GitHub export                      | API/worker/manual UI                                           | repo/product             | redacted GitHub link round-trips into timeline         |
| 19   | Add runbooks and dashboards            | docs, metrics dashboards                                       | ops                      | operators can triage stuck dispatches                  |
| 20   | Scale hardening                        | roles, grants, projections, retention                          | product/security/backend | ready for 5-10 people                                  |

### Step 0: Lock The Contract

Scope:

- keep `docs/CONTEXT_HANDOFF_ARCHITECTURE.md`
- keep `docs/CONTEXT_HANDOFF_IMPLEMENTATION_PLAN.md`
- keep `docs/CONTEXT_HANDOFF_ARCHITECTURE_INVENTORY.md`

Acceptance:

- Sitelayer is the authority for Work Requests and handoff timeline
- Mesh is an adapter only
- GitHub is collaborator-facing implementation coordination only
- Linear is deferred
- `workflow_event_log` stays deterministic replay only

Verification:

- `git diff --check` on the docs

### Step 1: Add The Database Tables

Write scope:

- `docker/postgres/init/088_context_handoff.sql`

Tasks:

1. Create `context_work_items`.
2. Create `context_handoff_events`.
3. Add check constraints for status, lane, severity, and actor kind.
4. Add indexes for inbox, entity indicators, timeline reads, request IDs, trace IDs, and idempotency.
5. Add company isolation RLS policies in the same migration.
6. Enable and force RLS from day one.

Acceptance:

- migration works from a clean database
- new tables have `company_id`
- handoff event idempotency is enforced by partial unique index
- no schema changes touch older migrations

Verification:

- run the repo's DB/schema check path
- run migration tests if present
- inspect generated schema if this repo has a schema dump step

### Step 2: Add Schema And RLS Checks

Write scope:

- `scripts/check-db-schema.sh`
- existing RLS/schema test files, or new focused test file

Tasks:

1. Teach schema checks about `context_work_items`.
2. Teach schema checks about `context_handoff_events`.
3. Add cross-company read/write tests.
4. Add a test that writes through `withMutationTx` and reads through `withCompanyClient`.

Acceptance:

- company A cannot read company B work items
- company A cannot append events to company B work items
- owner dump behavior does not break local dev checks

Verification:

- focused schema/RLS tests
- `git diff --check`

### Step 3: Extract The Support Packet Write Seam

Write scope:

- `apps/api/src/routes/support-packets.ts`
- optional `apps/api/src/support-packets.ts` or `apps/api/src/support-packet-store.ts`

Tasks:

1. Keep `sanitizeSupportJson` reusable.
2. Keep `buildSupportServerContext` reusable.
3. Extract support packet insert logic so `POST /api/work-requests` does not duplicate it.
4. Preserve existing `/api/support-packets` behavior.

Acceptance:

- old support packet create/list/get tests still pass
- Work Request create can call one support-packet helper inside its own transaction
- sanitizer behavior is unchanged

Verification:

- existing support packet tests
- focused TypeScript compile/test slice

### Step 4: Add Handoff Helper Module

Write scope:

- `apps/api/src/context-handoff.ts`

Tasks:

1. Define TypeScript types for work item rows and handoff event rows.
2. Add `sanitizeHandoffJson`.
3. Add `appendContextHandoffEventTx`.
4. Add `createContextWorkItemTx`.
5. Add `updateContextWorkItemWithEventTx`.
6. Add list/detail query helpers.
7. Add `buildWorkRequestAgentPrompt`.

Acceptance:

- helpers accept an executor/client so callers can keep one transaction
- every status update path appends an event
- payloads are sanitized before insert
- idempotency conflicts are handled intentionally

Verification:

- helper unit tests if local patterns support them
- route tests in later steps

### Step 5: Implement `POST /api/work-requests`

Write scope:

- `apps/api/src/routes/work-requests.ts`
- `apps/api/src/routes/dispatch.ts`

Tasks:

1. Add route context type.
2. Parse title/summary/category/severity/lane/client context.
3. Create support packet inside `withMutationTx`.
4. Create work item.
5. Append `work_item.created`.
6. Return work item ID, support packet ID, route/entity summary, and status.

Acceptance:

- one request writes exactly one support packet, one work item, and one handoff event
- transaction rolls back all three if any insert fails
- create is allowed for authenticated company members
- raw secrets are absent from inserted handoff payload

Verification:

- route test with fake pool/client
- sanitizer assertion
- `npm`/test command used by API package

### Step 6: Implement List, Detail, And Event Routes

Write scope:

- `apps/api/src/routes/work-requests.ts`

Tasks:

1. `GET /api/work-requests`
2. `GET /api/work-requests/:id`
3. `POST /api/work-requests/:id/events`
4. Role-based filters for worker/foreman/office/bookkeeper/admin.
5. Lock work item row for state-changing events.
6. Append event and update status/assignee in the same transaction.

Acceptance:

- inbox queries are company-scoped and bounded
- detail returns ordered timeline
- workers do not see unrelated admin/accounting items
- status changes cannot occur without a timeline event

Verification:

- route tests for each role
- transaction rollback test for event append failure

### Step 7: Complete Local API Test Coverage

Write scope:

- `apps/api/src/routes/work-requests.test.ts`
- nearby fixtures/helpers

Tasks:

1. Create happy path.
2. Create rollback path.
3. List filters.
4. Detail timeline ordering.
5. Event append.
6. Idempotency conflict.
7. Cross-company denial.
8. Redaction.

Acceptance:

- Phase 1 is safe to ship without UI
- API can be exercised by curl or tests

Verification:

- focused route tests
- repo API verification command if available

### Step 8: Add Support Packet Enrichment

Write scope:

- `apps/api/src/routes/support-packets.ts`
- support packet tests

Tasks:

1. Add bounded lookup for related work items by request IDs/entity refs.
2. Add bounded lookup for latest handoff events.
3. Include safe summaries in `server_context`.
4. Do not recursively include support packet bodies.

Acceptance:

- support packet can explain which work item came from it
- work item can point back to support packet
- expired/missing packet degrades cleanly

Verification:

- support packet route tests
- payload size/redaction tests

### Step 9: Add Web API Client

Write scope:

- `apps/web/src/lib/api/work-requests.ts`
- `apps/web/src/lib/api/index.ts` if needed

Tasks:

1. Add request/response types.
2. Add create/list/detail/event/dispatch functions.
3. Add entity-open-work query helper.
4. Keep API client using existing request and active company behavior.

Acceptance:

- frontend screens do not hand-roll fetch calls
- types match API route responses

Verification:

- TypeScript check
- client unit tests if existing pattern is lightweight

### Step 10: Add `/work` And `/work/:id` Routes

Write scope:

- `apps/web/src/screens/mobile-shell.tsx`
- `apps/web/src/screens/mobile/work-requests.tsx`
- `apps/web/src/screens/mobile/work-request-detail.tsx`

Tasks:

1. Lazy-load the new screens.
2. Add `work` and `work/:workItemId` routes.
3. Do not add a sixth permanent bottom tab.
4. Add entry link from More/settings route if appropriate.
5. Render skeleton inbox and detail from mocked/empty API state first.

Acceptance:

- `/work` renders inside canonical `MobileShell`
- `/m/work` works through legacy mount
- unauthorized/empty states are clear

Verification:

- frontend typecheck
- route smoke test if existing route tests support it

### Step 11: Add Create Sheet And First Real Page Action

Write scope:

- `apps/web/src/components/work-requests/*`
- first page: mobile estimate push detail or current estimate push screen

Tasks:

1. Build `WorkRequestAction`.
2. Build `WorkRequestCreateSheet`.
3. Build `WorkRequestContextPreview`.
4. Use existing Probe/Capture where available.
5. Submit to `POST /api/work-requests`.
6. Navigate/link to `/work/:id`.

Acceptance:

- a user can file from one real page
- preview shows route/entity/workflow/request/build context
- redaction notice is visible
- sensitive raw values are not displayed

Verification:

- component tests if practical
- Playwright smoke for first page action

### Step 12: Add Inbox, Detail Timeline, And Entity Indicators

Write scope:

- `apps/web/src/screens/mobile/work-requests.tsx`
- `apps/web/src/screens/mobile/work-request-detail.tsx`
- `apps/web/src/components/work-requests/*`
- first source pages

Tasks:

1. Add status tabs.
2. Add list rows with latest event.
3. Add detail timeline.
4. Add message composer.
5. Add assign/resolve/reopen controls.
6. Add source-page status pill for first entity type.

Acceptance:

- user can create, find, inspect, comment, and resolve a work item
- source page shows open work state
- timeline order is stable

Verification:

- frontend tests
- manual smoke through dev server

### Step 13: Add Observability And Debug Trace Links

Write scope:

- API metrics/logging
- `apps/api/src/routes/system.ts`
- docs/runbook sections

Tasks:

1. Add bounded metrics for create/event/dispatch.
2. Add structured logs with work item IDs and packet IDs.
3. Extend debug trace by request/trace ID to include work item rows and handoff events.
4. Keep debug trace admin-only and bounded.

Acceptance:

- an operator can answer "what happened to this request?"
- debug trace does not perform unbounded JSON scans

Verification:

- focused route test or manual query
- metric/log smoke if local tooling supports it

### Step 14: Add Mesh Dispatch Route And Outbox Row

Write scope:

- `apps/api/src/routes/work-requests.ts`
- `apps/api/src/context-handoff.ts`

Tasks:

1. Add `POST /api/work-requests/:id/dispatch/mesh`.
2. Require triage-capable role.
3. Append `agent.dispatch_requested`.
4. Set status to `agent_running`.
5. Insert `mutation_outbox` with `dispatch_mesh_work_request`.
6. Use deterministic idempotency key.

Acceptance:

- Mesh unavailable does not affect route transaction
- dispatch is retryable through outbox
- raw support packet JSON is not in outbox payload

Verification:

- route test for outbox row
- idempotency test
- permission denial test

### Step 15: Add Mesh Worker Adapter

Write scope:

- `apps/worker` or `packages/queue/src/pushers`
- queue tests

Tasks:

1. Register dedicated mutation type.
2. Claim rows with existing queue pattern.
3. Call Mesh orchestration endpoint.
4. Include `execution_context.context_handoff`.
5. Append `agent.dispatch_acknowledged` on success.
6. Mark outbox applied/failed using existing retry behavior.

Acceptance:

- successful dispatch records Mesh task ID
- failed dispatch retries without corrupting work item
- endpoint choice is confirmed and documented

Verification:

- worker unit tests with fake fetch
- local queue test slice

### Step 16: Add Agent Callback Route

Write scope:

- `apps/api/src/routes/work-requests.ts`
- route tests

Tasks:

1. Use per-dispatch scoped callback tokens; keep
   `SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN` only as a legacy fallback.
2. Resolve company from work item ID.
3. Validate callback event type.
4. Append `agent.message_received`, `agent.artifact_attached`, `agent.proposal_ready`, or `agent.completed`.
5. Move to `review_ready` only for proposal/completion events.
6. Reject any attempt to mutate production workflow state.

Acceptance:

- duplicate callbacks are idempotent
- wrong token fails
- wrong company cannot be injected by body
- callback only appends timeline/proposal state

Verification:

- webhook route tests
- auth failure tests
- idempotency tests

### Step 17: Add Stale Proposal Sweeper

Write scope:

- `apps/worker`
- worker tests

Tasks:

1. Find `review_ready` older than `WORK_REQUEST_REVIEW_STALE_HOURS`.
2. Append system `work_item.status_changed`.
3. Set status `review_stale`.
4. Keep query bounded.

Acceptance:

- old proposals no longer sit forever
- active/recent proposals are not touched

Verification:

- worker test with old/recent fixtures

### Step 18: Add Redacted GitHub Export

Write scope:

- API route or manual UI action
- optional worker adapter
- GitHub issue/PR link UI

Tasks:

1. Generate redacted issue body.
2. Include repro route, expected/observed behavior, safe request/build IDs, and internal link.
3. Create GitHub issue or accept manual URL.
4. Append `external.github_linked`.

Acceptance:

- no raw support packet data leaves Sitelayer
- GitHub link appears in timeline
- PR/check links can be added later

Verification:

- redaction test
- mocked GitHub API test or manual-link route test

### Step 19: Add Operational Runbooks

Write scope:

- docs
- dashboards/metrics config if stored in repo

Tasks:

1. Document pending dispatch query.
2. Document timeline query.
3. Document divergence query.
4. Document callback failure triage.
5. Document support packet expiry behavior.

Acceptance:

- someone other than Taylor can triage a stuck item
- runbook does not require private context unless explicitly marked

Verification:

- dry-run SQL against dev database when available

### Step 20: Scale Hardening For 5-10 People

Write scope:

- schema/API/UI/security docs as needed

Tasks:

1. Add capability roles beyond broad `admin`: v1 keeps raw support packets
   admin-only, lets member creators message their own items, and gives
   admin/office/foreman/bookkeeper triage/export/dispatch rights.
2. Add support packet access log: implemented as
   `support_packet_access_log` with per-packet read/prompt/export rows.
3. Add export approval events: GitHub export preparation appends
   `external.github_export_prepared` with hash/length metadata, not raw body.
4. Replace broad callback bearer token with per-dispatch scoped token:
   dispatch stores a SHA-256 hash and Mesh receives the raw scoped token in
   `execution_context.context_handoff.callback`.
5. Decide whether work items become event projections: defer. Direct row
   updates remain acceptable while every status mutation appends an event in
   the same transaction.
6. Decide retention for resolved work and expired packets: expired support
   packets stop joining into Work Request detail; long-lived work items retain
   the redacted timeline and stable support packet ID.
7. Add pagination/archive behavior for long timelines: Work Request detail is
   bounded by `limit`/`offset` with a 200-event default and 500-event cap.

Acceptance:

- a small team can operate without Taylor in the loop
- external collaborators can receive redacted handoff bundles
- private operational context remains in Sitelayer

Verification:

- security review
- role matrix tests
- handoff drill with a non-admin collaborator

## Test Plan

Backend:

- migration from scratch
- schema check
- RLS cross-company tests
- sanitizer tests
- create route transaction test
- event append/idempotency tests
- list/detail filter tests
- dispatch route/outbox tests
- callback auth/idempotency tests
- stale proposal worker test

Frontend:

- API client tests
- create sheet validation
- context preview redaction
- inbox filter/status tests
- detail timeline ordering
- review controls
- entity status indicator

E2E:

- open estimate push
- create Work Request
- verify support packet/work item/timeline rows
- dispatch to stub Mesh adapter
- verify review-ready callback
- mark resolved

Ops:

- runbook SQL for pending dispatch
- runbook SQL for timeline inspection
- runbook SQL for work item/event divergence
- dashboard panel for oldest pending dispatch

## Runbook Seeds

Pending dispatches:

```sql
select id, entity_id, mutation_type, status, attempt_count, next_attempt_at, error, created_at
from mutation_outbox
where entity_type = 'context_work_item'
order by created_at desc
limit 50;
```

Timeline:

```sql
select event_type, actor_kind, idempotency_key, request_id, recorded_at, payload, metadata
from context_handoff_events
where company_id = $1 and work_item_id = $2
order by recorded_at asc;
```

Divergence check:

```sql
select w.id, w.status, e.event_type, e.recorded_at
from context_work_items w
left join lateral (
  select event_type, recorded_at
  from context_handoff_events
  where company_id = w.company_id and work_item_id = w.id
  order by recorded_at desc
  limit 1
) e on true
where w.company_id = $1
order by w.updated_at desc
limit 100;
```

## Non-Goals For V1

- replacing GitHub
- adopting Linear
- making Mesh required for collaborators
- storing raw PEL logs
- storing raw support packets in external systems
- building a new queue system
- using `workflow_event_log` for chat or triage
- letting agents mutate production workflow state through callback
- promoting every ontology concept into top-level SQL columns

## Next Concrete Commit

Implement Phase 1:

1. `088_context_handoff.sql`
2. `apps/api/src/context-handoff.ts`
3. `apps/api/src/routes/work-requests.ts`
4. route wiring in `dispatch.ts`
5. route/schema tests
6. schema check update
