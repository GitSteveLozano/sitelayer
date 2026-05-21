# Context Handoff Architecture Inventory

- **Status:** proposed 2026-05-21
- **Related docs:** `docs/CONTEXT_HANDOFF_ARCHITECTURE.md`, `docs/CONTEXT_HANDOFF_IMPLEMENTATION_PLAN.md`
- **Purpose:** inventory where each piece lives, who owns it, how it communicates, and what breaks as the system moves from 1-5 people to 5-10 people

## Boundary Summary

The system should be Sitelayer-centered.

Sitelayer owns the work item, context packet, timeline, permissions, redaction, review, and resolution. Mesh is an execution adapter. GitHub is the collaborator-visible code and review surface. Linear is deferred and summary-only.

That keeps the system usable by 1-5 people without requiring everyone to use Taylor's control-plane, while still leaving a path to hand it off to a small team later.

## Architecture Inventory

| Piece                        | Lives In                                | Served From                             | Owner                                 | Source Of Truth               | Primary Risk                                     |
| ---------------------------- | --------------------------------------- | --------------------------------------- | ------------------------------------- | ----------------------------- | ------------------------------------------------ |
| Work Request UI              | `apps/web`                              | Sitelayer web app at `/work`, `/m/work` | Sitelayer product                     | No                            | UI can imply authority that lives in API/DB      |
| Create sheet/context preview | `apps/web/src/components/work-requests` | Browser                                 | Sitelayer product                     | No                            | leaking raw state or showing misleading context  |
| Page Probe/Capture           | `apps/web/src/lib/probe`                | Browser                                 | Sitelayer frontend                    | No                            | incomplete page coverage, stale client state     |
| API routes                   | `apps/api/src/routes/work-requests.ts`  | Sitelayer API                           | Sitelayer backend                     | No                            | route permissions and transaction gaps           |
| Handoff helpers              | `apps/api/src/context-handoff.ts`       | Sitelayer API/worker                    | Sitelayer backend                     | No                            | duplicate sanitizer or inconsistent event writes |
| Support packets              | `support_debug_packets`                 | Postgres via Sitelayer API              | Sitelayer backend/support             | Evidence packet               | sensitive data retention/leakage                 |
| Support packet access log    | `support_packet_access_log`             | Postgres via Sitelayer API              | Sitelayer backend/security            | Packet access audit           | noisy reads, missed best-effort rows             |
| Work items                   | `context_work_items`                    | Postgres via Sitelayer API              | Sitelayer backend/product             | Current coordination state    | split brain with event timeline                  |
| Handoff events               | `context_handoff_events`                | Postgres via Sitelayer API              | Sitelayer backend                     | Handoff audit trail           | volume, payload creep, weak redaction            |
| Domain audit                 | `audit_events`                          | Postgres via Sitelayer API              | Sitelayer backend                     | Domain/user audit             | overloading it as chat/task bus                  |
| Workflow replay              | `workflow_event_log`                    | Postgres via Sitelayer API              | Workflow owners                       | Deterministic workflow replay | pollution by non-replay handoff chatter          |
| Async dispatch               | `mutation_outbox`                       | Postgres via worker                     | Sitelayer worker                      | Delivery/retry state          | duplicate queue machinery or stuck rows          |
| Sync ledger                  | `sync_events`                           | Postgres via worker/API                 | Integration owners                    | Integration audit             | confusing sync audit with handoff timeline       |
| Mesh adapter                 | Sitelayer worker + Mesh API             | Worker HTTP to Mesh                     | Operator automation                   | Execution telemetry only      | Mesh unavailability or endpoint drift            |
| Agent callback               | Sitelayer API                           | Public Sitelayer callback route         | Sitelayer backend/operator automation | No, appends events            | broad bearer token, replay, wrong company        |
| GitHub export                | Sitelayer API/worker or manual          | GitHub API / human copy                 | Repo maintainers                      | Code discussion/PR trail      | exporting raw customer context                   |
| Linear export                | Deferred                                | Linear API                              | Product owner                         | Planning projection only      | becoming accidental authority                    |
| Debug trace integration      | `apps/api/src/routes/system.ts`         | Sitelayer API                           | Sitelayer backend/ops                 | No                            | expensive joins under incident load              |
| Stale proposal sweeper       | `apps/worker`                           | Sitelayer worker                        | Sitelayer ops                         | No                            | incorrectly expiring active work                 |

## Where The Core Tables Live

### `support_debug_packets`

Location: existing Postgres table from `docker/postgres/init/018_support_debug_packets.sql`.

Role:

- bounded evidence bundle
- app/server context snapshot
- request IDs, trace IDs, route, build SHA
- existing expiry behavior

Security:

- full retrieval should stay admin-only in v1
- creators can see work item summaries, not necessarily raw packets
- external systems get packet IDs and redacted summaries only

Performance:

- JSON payload can grow quickly
- never recursively embed support packets into work item events
- keep packet retention bounded

Problem exposed:

- Work items may need to outlive support packet expiry. The work item must keep a minimal redacted summary so the timeline still makes sense after the packet expires.

### `context_work_items`

Location: new Sitelayer Postgres table, migration `088_context_handoff.sql`.

Role:

- current state for inbox/detail views
- assignee/lane/status/severity
- source route/entity
- support packet pointer

Security:

- company-scoped RLS from day one
- list visibility depends on role
- workers should not see unrelated admin/accounting work

Performance:

- hot list queries need `(company_id, status, updated_at desc)`
- entity indicators need `(company_id, entity_type, entity_id, status)`

Problem exposed:

- If status can be updated without appending an event, the audit trail lies. In v1, every status mutation must append an event in the same transaction. At 5-10 people, consider making this table a projection from `context_handoff_events`.

### `context_handoff_events`

Location: new Sitelayer Postgres table, migration `088_context_handoff.sql`.

Role:

- canonical handoff timeline
- messages, assignments, dispatches, agent callbacks, proposals, reviews, external links, resolutions

Security:

- redacted before insert
- no raw tokens, cookies, PDFs, blueprint rasters, Sentry replays, private PEL logs, or raw support packet bodies
- event payloads should default to summaries and pointers

Performance:

- append-only write path should be cheap
- list/detail reads should fetch by `work_item_id`
- avoid broad scans by payload JSON
- promote metadata into columns only when query behavior demands it

Problem exposed:

- If this table becomes a dumping ground for raw context, it will become the highest-value breach target in the app. Keep payloads small and pointer-based.

### `workflow_event_log`

Location: existing Postgres table from `docker/postgres/init/020_workflow_event_log.sql`.

Role:

- deterministic reducer event replay
- workflow state snapshots
- state version assertions

Security/performance:

- already hot for replay/debug
- should not absorb chat, triage, GitHub links, or agent commentary

Problem exposed:

- It is tempting to treat this as the event bus because it already exists. Do not. It has a different contract.

### `mutation_outbox`

Location: existing Postgres table from `docker/postgres/init/001_schema.sql`.

Role:

- async dispatch to Mesh first
- later GitHub/Linear exports if needed
- retry and idempotency

Security:

- payload must be redacted because workers and logs can expose it
- adapter payload contains work item refs and callback URL, not raw packet

Performance:

- reuse current `FOR UPDATE SKIP LOCKED` pattern
- add dedicated mutation type for Mesh work request dispatch
- do not add `context_dispatches` until outbox cannot support adapter state

Problem exposed:

- Outbox rows are pruned; they are not the durable audit trail. The durable semantic record must be `context_handoff_events`.

## Communication Paths

### Human Creates A Work Request

1. Browser captures page context with Probe/Capture.
2. Browser posts to `POST /api/work-requests`.
3. API sanitizes client payload.
4. API builds server context from support packet helpers.
5. API transaction inserts:
   - `support_debug_packets`
   - `context_work_items`
   - `context_handoff_events(work_item.created)`
6. Browser navigates to `/work/:id` or shows created state.

Permissions:

- any authenticated company member can create
- packet retrieval remains narrower than work item visibility

Security:

- redaction happens before DB insert
- request and trace IDs propagate from the existing client/API trace path

### Human Adds Message Or Review

1. Browser posts `POST /api/work-requests/:id/events`.
2. API checks role and company access.
3. API locks `context_work_items`.
4. API appends a handoff event.
5. API updates status/assignee if needed.
6. API commits both together.

Permissions:

- creator can add messages to their own item
- admin/office/foreman can triage relevant items
- only review-capable roles can accept resolution or close accounting/workflow-sensitive items

Security:

- event types are allowlisted
- state changes are server-derived, not client-trusted

### Agent Dispatch To Mesh

1. Human or rule triggers `POST /api/work-requests/:id/dispatch/mesh`.
2. API appends `agent.dispatch_requested`.
3. API inserts `mutation_outbox(dispatch_mesh_work_request)`.
4. Worker claims the outbox row.
5. Worker calls Mesh orchestration API with `execution_context.context_handoff`.
6. Worker appends `agent.dispatch_acknowledged`.
7. Mesh agent calls Sitelayer callback with proposal/completion.
8. API appends callback event and moves work item to `review_ready` when appropriate.

Permissions:

- dispatch requires admin/office/foreman or explicit operator role
- Mesh receives no DB credentials
- Mesh receives a callback URL and redacted refs

Security:

- callback token must be separate from operator chat token
- new dispatches use per-dispatch scoped bearer tokens stored only as hashes
- `SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN` is legacy fallback for old rows

Performance:

- Mesh downtime should not block the app
- outbox retry keeps work item usable
- UI should show `dispatch pending`, `agent running`, or `dispatch failed`

### GitHub Export

1. Human chooses export/link GitHub.
2. API generates redacted summary.
3. API creates GitHub issue or records manually supplied URL.
4. API appends `external.github_linked`.

Permissions:

- maintainer/admin only
- GitHub token is adapter-side, never browser-side

Security:

- no raw support packet JSON
- no private PEL/operator logs
- no customer-sensitive payloads unless explicitly reviewed and suitable for the repo visibility

### Cross-Person Handoff

For 1-5 people:

1. Sitelayer work item remains canonical.
2. New person gets a redacted work item link or GitHub issue.
3. If they have Sitelayer access, role controls packet/timeline visibility.
4. If they do not, they get a redacted export plus repo/PR context.

For 5-10 people:

1. Add a named support/reviewer role.
2. Use GitHub issues/PRs for external implementation work.
3. Use Sitelayer work item for private customer/context truth.
4. Use signed handoff bundles for non-Sitelayer collaborators:
   - title
   - summary
   - allowed purpose
   - evidence refs
   - redaction version
   - expiry
   - contact/owner
   - link back to canonical work item if authorized

## Permission Inventory

| Role                  |       Create |              View Own |           View Company Inbox |          View Raw Packet |          Triage |  Dispatch Agent | Review Proposal |         Resolve | Export GitHub |
| --------------------- | -----------: | --------------------: | ---------------------------: | -----------------------: | --------------: | --------------: | --------------: | --------------: | ------------: |
| worker                |          yes |                   yes |           field-related only |                       no |              no |              no |              no | own/simple only |            no |
| foreman               |          yes |                   yes |          field/project scope |            no by default |   yes for field |   yes for field |   yes for field |   yes for field |            no |
| office                |          yes |                   yes |                          yes |   limited/admin decision |             yes |             yes |             yes |             yes |         maybe |
| bookkeeper            |          yes |                   yes |             accounting scope |   limited/admin decision | accounting only | accounting only | accounting only | accounting only | no by default |
| admin                 |          yes |                   yes |                          yes |                      yes |             yes |             yes |             yes |             yes |           yes |
| agent                 | no direct UI |                scoped | scoped via packet/projection | no raw packet by default |              no |              no |   proposes only |              no |            no |
| external collaborator |           no | exported summary only |                           no |                       no |              no |              no |              no |              no |    via GitHub |

Permission problems exposed:

- "Raw packet access" and "work item access" must be separate permissions.
- Agent callback cannot be treated as a user.
- GitHub export permission is not the same as Sitelayer admin permission because repo visibility may differ from customer visibility.
- If more than five people use this, `admin` is too coarse; add `support_reviewer`, `agent_dispatcher`, and `external_exporter` style capabilities.

## Security Implications

High-value data:

- support packet JSON
- handoff event payloads
- callback URLs/tokens
- request/trace IDs
- internal links to entities
- Mesh task payloads
- GitHub exports

V1 controls:

- RLS on new tables from day one
- `withMutationTx` for writes
- `withCompanyClient` for reads
- sanitize before insert
- event type allowlist
- per-dispatch scoped webhook token for Work Request callbacks
- no raw support packet export
- no direct agent workflow mutation

Next-level controls:

- HMAC request signatures for callbacks
- immutable audit of export decisions
- capability-style grants for non-Sitelayer people
- support packet access log
- security review for any external adapter that receives payloads

Security problems exposed:

- A single fallback bearer token is tolerable only for legacy rows; it is too broad for normal 5-10 person dispatch.
- Packet expiry does not erase derived event summaries. Retention language must be honest about what survives.
- GitHub can become an accidental data leak if exports are too convenient.

## Performance Implications

Expected v1 scale is tiny: 1-5 people, low write volume. The main risk is not throughput; it is accidental heavy JSON and debug joins.

Hot paths:

- inbox list by company/status
- entity indicator by company/entity/status
- detail timeline by work item
- support packet creation with server context joins
- outbox claim/retry

Controls:

- bounded support packet payloads
- bounded timeline page size
- pointer-based events
- indexes on status/entity/work item/request/trace
- no payload JSON scans in v1 UI
- async adapter dispatch through outbox

Next-level controls:

- pagination on timelines
- payload size budget per handoff event
- event archival policy
- materialized/latest-event fields if inbox queries get expensive
- rate limit Work Request creation and agent dispatch

Performance problems exposed:

- Support packet creation already fans out to audit, workflow, queue, and domain snapshot reads. Do not put it on every page load. It should run only on explicit create.
- Entity status indicators should query small `context_work_items` rows, not support packets or event payloads.
- Debug trace integration should be bounded and admin-only.

## Ownership Model

### 1-5 People

Keep ownership simple:

- Product/API owner: Sitelayer maintainer.
- Ops owner: whoever owns Sitelayer deploy and worker health.
- Review owner: admin/office user assigned in the work item.
- Agent owner: Mesh/operator automation only when dispatched.
- Repo owner: GitHub maintainer for PR review.

Operating rule:

- If it is customer/context-sensitive, it stays in Sitelayer.
- If it is code implementation, it can go to GitHub after redaction.
- If it is agent execution, Mesh can do it but Sitelayer records the result.

### 5-10 People

Split authority:

- Product owner: owns statuses, lanes, priority rules.
- Backend owner: owns schema, API, RLS, retention.
- Frontend owner: owns Work Request UX and source-page integration.
- Ops owner: owns worker/outbox/adapter health.
- Security/privacy owner: owns redaction, exports, access review.
- Repo maintainer: owns GitHub issue/PR flow.
- Support lead: owns triage queue and stale proposal review.

Add process:

- weekly triage review
- stale proposal sweep
- export review before GitHub issue creation when customer context is involved
- CODEOWNERS for schema/API/worker/web surfaces
- onboarding doc for how to take a Work Request from report to PR to resolution

## Handoff Plan If Taylor Is Not Involved

Minimum handoff bundle:

- Sitelayer work item URL
- redacted summary
- source route/entity
- current status and owner
- latest timeline events
- support packet access level
- GitHub issue/PR links
- Mesh task ID if an agent ran
- what is allowed: investigate, draft, propose, review, or apply
- what is out of scope
- expiry/review deadline

For someone with Sitelayer access:

- grant company role
- assign work item
- they operate in `/work/:id`
- they use GitHub only for code changes

For someone without Sitelayer access:

- create GitHub issue from redacted export
- include enough reproduction detail
- omit raw packet and private timelines
- maintainer bridges results back into Sitelayer as handoff events

For an agent:

- dispatch through Mesh
- provide support packet/work item refs and redacted prompt
- require callback into Sitelayer
- do not give DB credentials
- do not allow production workflow mutation through callback

## Problems In The Current Thinking

1. `context_work_items` is called a read model, but v1 plans to mutate it directly. That is acceptable only if every mutation happens in the same transaction as an append-only event. If that discipline slips, the audit trail becomes untrustworthy.

2. Support packets expire, but work items may be long-lived. The design needs a minimal durable redacted work item snapshot so old items do not become empty shells.

3. Mesh callback auth now uses per-dispatch scoped callback credentials; next-level hardening is HMAC signatures and expiry enforcement.

4. Raw packet access and work item access are different permissions. The UI must not imply that seeing a work item means seeing the whole evidence packet.

5. GitHub export is the easiest privacy failure. The product should make the default export intentionally boring and redacted.

6. Debug trace integration can get expensive. It should be admin-only, bounded, and not part of the normal work item list path.

7. The active serving surface is `MobileShell`, not the older desktop `AppShell`. Any implementation plan that mounts this only in the retired shell is wrong.

8. The existing operator chat path proves the loop, but it should not become the user-facing Work Request UX. It is operator-specific and audit-events-based; Work Requests need their own timeline.

9. At 5-10 people, `admin` becomes too blunt. v1 separates creator messaging, triage/export/dispatch roles, and raw packet admin access; repeated external access still needs capability-style grants.

## Next-Level Trigger Points

Move beyond the 1-5 person design when any of these happen:

- more than five regular users triage or resolve work requests
- external collaborators need repeated access
- GitHub exports happen more than a few times per week
- agent callbacks perform more than investigation/proposal
- support packet access needs audit reports
- work item timelines exceed a few hundred events
- multiple teams disagree on status ownership

At that point, implement:

- HMAC callback signatures and expiry enforcement
- support packet access reports
- external collaborator capability grants
- capability roles
- status projection/reducer
- event pagination and retention jobs
- collaborator handoff bundle generator

## Bottom Line

For now, the architecture can stay small:

- Sitelayer owns the truth.
- Postgres stores the context, work item, and timeline.
- Workers deliver adapter tasks.
- Mesh executes agents.
- GitHub carries redacted implementation work.
- Humans review before production state changes.

The main thing to protect is the boundary between private operational context and shareable work coordination. If that boundary stays clean, this can scale from Taylor plus a few agents to a small team without making everyone adopt the whole control-plane stack.
