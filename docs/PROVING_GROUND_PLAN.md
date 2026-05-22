# Sitelayer Proving-Ground Plan

**Status:** Draft, 2026-05-22
**Owner:** Taylor
**Companions:** `CONTEXT_HANDOFF_ARCHITECTURE.md`, `CONTEXT_HANDOFF_IMPLEMENTATION_PLAN.md`, `qbo-live-flip-checklist.md`

## Thesis

Sitelayer is the lead live exemplar of the operator's bespoke-individual pattern: consume vendor primitives (Clerk, QBO, Sentry, Postgres, DO Spaces, Cloudflare) and hold a richer authority + evidence + reversibility model in a policy layer above them. The work in this plan turns operator ideas (drift concepts, 7+1 control points, PEL substrate, audit escrow) into shipped code inside sitelayer, where real money is on the line and the policy layer can be stress-tested against a paying pilot.

Strategic framing references (digital-ontology):

- `ontology-maintenance-architecture.md` (5 drift concepts; reversibility flagged critical)
- `agent-control-plane-vendor-map.md` (7+1 control points; sitelayer named the lead bespoke product)
- `subscription-leverage-plan-2026-05-21.md` (28-day Gemini-sunset window; QBO live flip ranked #1)
- `personal-event-log-system-design.md` (PEL substrate; sitelayer already runs Sentry + reconciliation in prod)

Sitelayer ADRs already settled and load-bearing for this plan:

- ADR 0019 — Page-Context Dispatch Contract (gave us context handoff)
- ADR 0023 — Collaborator Telemetry via HMAC Ingress
- ADR 0024 — Sitelayer/Control-Plane Default Decoupled
- ADR 0025 — Operator-SDK Standalone

## Current state we are working from

Mesh ledger:

- G_SITELAYER_MVP and G_SITELAYER_OPERATE both **completed** (49/49, 41/41).
- 13 open tasks; **all** are runtime health-check alerts. Zero feature work in flight.
- Working models exist for sitelayer architecture, MVP, rental-closeout automation, droplet/registry optimization.

Sitelayer maturity per the 7 control points:

| Control point      | State      | Where                                                                              |
| ------------------ | ---------- | ---------------------------------------------------------------------------------- |
| Runtime            | Mature     | `packages/workflows/`, `apps/worker/src/worker.ts`, migration 020                  |
| Identity           | Mature     | `apps/api/src/auth.ts`, migrations 001/066/085                                     |
| Data               | Mature     | 92 migrations, `audit_events`, `support_debug_packets`, RLS                        |
| Tool               | Scaffolded | `context-work-dispatch.ts`; no MCP registry yet                                    |
| Payment            | Partial    | QBO live for rentals; estimates/payroll behind flags; no dunning                   |
| Observability      | Partial    | Sentry traces in audit chain; trace propagation broken at API edge; sparse metrics |
| Kill-switch        | Scaffolded | Env flags + QBO circuit breaker; no lanes, no policy gates                         |
| Audit-escrow (8th) | Missing    | All evidence still in primary Postgres                                             |

Drift concepts in sitelayer:

| Concept       | State                            | Notes                                                                                                                                                                                          |
| ------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval      | Scaffolded (status-as-gate)      | Implicit in `review_ready` / `review_stale`                                                                                                                                                    |
| Evidence      | Mature                           | `audit_events` + `context_handoff_events` + `support_debug_packets`, redaction versioned                                                                                                       |
| Delegation    | Scaffolded (token-as-delegation) | Hardcoded 72h callback token TTL; no first-class delegation object                                                                                                                             |
| Obstruction   | Partial (status, not signal)     | `review_stale`, `proposal_expired`, `wont_do`, `dead` are terminal states; not queryable as signals                                                                                            |
| Reversibility | Wedge present                    | `reversibility_window_seconds: 86_400` already sent outbound to mesh in `apps/worker/src/runners/context-work-dispatch.ts:152` but not tracked inbound, not visible in UI, no reverse endpoint |

## Ranked wedges

### Wedge 1 — Reversibility end-to-end visible

Proves: ontology drives schema; vendor-untouched primitive; closes the most-flagged drift concept.

Why now: sitelayer already sends `reversibility_window_seconds` outbound; mesh side has no column for it; the corpus has 30/60/180-day classes documented. The whole stack lights up from one column.

Work:

1. Migration: add `reversibility_window_seconds` to `context_work_items` (default 86_400, severity-derived overrides — `urgent=3600`, `low=604800`).
2. Populate at creation in `createContextWorkItemTx` (`apps/api/src/context-handoff.ts`).
3. API: include computed `expires_at` in `GET /api/work-requests/:id`.
4. UI: "Recall until 14:23 UTC" badge in `apps/web/src/screens/mobile/work-request-detail.tsx`; countdown when within 1h.
5. API: `POST /api/work-requests/:id/reverse` — guards on window, cancels mesh task if `agent_running`, emits `work_item.reversed` event, transitions to `cancelled`.
6. Mesh-side mirror: new migration adds `reversibility_window_seconds` on `tasks`; populate from inbound dispatch payload; expose on task fetch.

Estimate: 1 day, single-agent.

### Wedge 2 — Audit Escrow MVP on sitelayer evidence

Proves: 8th control point (the moat per `agent-control-plane-vendor-map.md`); evidence as first-class above Sentry's trace-only model.

Why sitelayer first: `audit_events` + `context_handoff_events` + `support_debug_packets` are already redacted, already trace-correlated, already legally interesting (construction-ops disputes have real money at stake).

Work:

1. New worker runner `sitelayer-audit-escrow-tick` (hourly): pulls last hour of `audit_events`, canonicalizes JSON, hashes, signs with Ed25519, writes signed bundle to DO Spaces with S3 Object Lock (WORM).
2. Submit hash to OpenTimestamps (free; pennies in API egress). Store `.ots` proof next to bundle.
3. Migration: add `escrow_anchor_id` column to `audit_events`; backfill nightly worker.
4. API: `GET /api/audit/escrow/:bundle_id` — returns bundle, signature, OTS proof, reconstructable hash chain.
5. Runbook: `RUNBOOK_AUDIT_ESCROW.md` — verification command for a third party.

Estimate: 2 days. No vendor offers this; cost is single-digit dollars/month.

### Wedge 3 — Delegation as first-class object

Proves: bespoke-individual policy layer above two vendors at once (Clerk + QBO); enforceable budget refund for steerer subagents.

Today, the callback token in `apps/api/src/routes/work-requests.ts:393-445` IS delegation, by accident. Promote it.

Work:

1. New table `delegations`: `id, principal_user_id, agent_actor, scope_kind (readonly|propose|execute), scope_tags[], reversibility_window_seconds, expires_at, revoked_at, evidence_event_id, created_at`.
2. Re-back callback tokens off the `delegations` row; old shape preserved by view for compat.
3. UI on work-request detail: "Foreman Steve delegated `propose` to claude/operator_assistant for 72h" with Revoke button.
4. API: `POST /api/delegations/:id/revoke` — flips `revoked_at`, calls mesh `cancel_task` for any active downstream tasks holding this delegation, writes evidence.
5. Wire prod-mode `ActingAs` (`apps/api/src/auth.ts:24-36`, dev-only today) into the delegation pipeline as a logged principal swap with justification.

Estimate: 2-3 days.

### Wedge 4 — Obstruction signals, queryable

Proves: same vocabulary across mesh and sitelayer; merged-dashboard view of operator friction.

Work:

1. API: `GET /api/work-requests/obstructions` — returns open work items in `review_stale | proposal_expired | wont_do | dead` with `blocked_reason`, `blocked_since`, suggested next action.
2. Worker: emit `observation_events` to mesh ingress on state transition into those terminal-ish states.
3. Mesh view: register `view_sitelayer_obstructions` PEL view (follows PR 115 pattern — view definitions live in code, no migration).
4. Operator UI: surface in `/work` inbox header.

Estimate: 1 day.

### Wedge 5 — Kill-switch lanes

Proves: closes the 7th control-point gap; required gate before the QBO live flip.

Work:

1. New table `dispatch_lanes`: `name, state (active|paused|degraded), pause_reason, paused_at, resume_after, last_decided_by`.
2. Worker `apps/worker/src/worker.ts:72-103` runners read lane state before draining; if paused, sleep + heartbeat with reason.
3. Auto-pause keeper (every 30s): evaluates lane health from `integration_circuit_state` + `mutation_outbox` lag + Sentry error rate; pauses with reason.
4. Operator UI `/admin/lanes` — manual pause/resume with required reason field; resume writes audit + delegation event.
5. Plumb the QBO*LIVE*\* env flags through the lane state (flag flip = lane decision, audited).

Estimate: 2 days. **Block on this before flipping `QBO_LIVE_ESTIMATE_PUSH=1` in prod.**

## Quick-win wedges (≤4 hours each)

- **Reversibility badge only** — read `expires_at` from outbound dispatch payload; display countdown on work-request detail page. Proves the concept in an hour without a migration.
- **PEL view `view_sitelayer_handoffs`** — register a view UNIONing `context_handoff_events` + `audit_events`. Operator dashboard surface for free.
- **Estimate-push approval chat thread** — mount existing chat-widget machine on `estimate-push-detail.tsx` keyed by `estimate_id`. Captures field-to-office context currently lost in SMS.
- **Trace propagation patch** — Sentry SDK middleware on API + worker entry points. ~30 min lift; unblocks every observability claim downstream.
- **Sitelayer-aware counsel class** — one entry in `mesh/core/counsel_of_models_registry.go` routing `sitelayer_implementation` tasks to Claude instead of Haiku.

## Capability foundation (prerequisite for agent-delivered wedges)

Without these, every wedge above is operator-hand-coded. With them, an operator files a work request and an agent ships a tested PR within 1-2 hours.

1. **Steerer workflow `sitelayer_implementation_fan`** in `mesh/core/steerer_workflows.go` — primary Claude, sequential fan, output: PR branch + test results + migration checksums.
2. **SessionStart hook pre-materialization** in `orchestrator/src/agent-lib/hooks/` — if task `project_name=sitelayer`, run `npm install && npm run typecheck` in the freshly-allocated worktree before agent claims.
3. **Counsel class entry** routing sitelayer implementation tasks away from `operator_assistant` (Haiku) to Claude.

Total estimate: ~2 hours.

## What to avoid

- **Don't couple sitelayer back to control-plane.** ADR 0024 is default-decoupled. Anything new flows through HMAC ingress (ADR 0023 pattern) or PEL view reads. No mesh task queue dependency in the request path; no cross-FK joins.
- **Don't ship LLM schema discovery for PEL.** Manual schemas win at this cohort size.
- **Don't burn the 28-day Gemini window (until 2026-06-18) on infra polish.** `subscription-leverage-plan-2026-05-21.md` ranks QBO live flip + first pilot onboard as #1. Wedges 1 and 5 directly support that flip; wedges 2-4 stage in after pilot live.
- **Don't push to `main` from agent worktrees.** Rule 13/18; agent branches only; pre-push hook will reject.
- **Don't create migrations without `claim_migration_number` first** (rule 16). Use `mesh claim_migration_number` before adding any `NNN_*.sql` under `mesh/postgres/migrations/`; sitelayer's own migration sequence has its own ordering (next is 093+).

## Suggested 14-day sequence

| Days  | Work                                                        | Why now                                                                  |
| ----- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1     | Trace propagation patch + capability-foundation 3 additions | Unblocks observability + makes every other wedge agent-deliverable       |
| 2-3   | **Wedge 1: Reversibility end-to-end**                       | Cheapest, most operator-visible, closes biggest drift concept            |
| 4-5   | **Wedge 5: Kill-switch lanes**                              | Required gate before QBO live flip                                       |
| 6-7   | **QBO live flip + first pilot onboard**                     | `subscription-leverage-plan` #1; runbook in `qbo-live-flip-checklist.md` |
| 8-10  | **Wedge 2: Audit Escrow MVP**                               | First pilot's audit trail becomes legally-anchored                       |
| 11-12 | **Wedge 4: Obstruction signals**                            | Operator sees first pilot's friction in real time                        |
| 13-14 | **Wedge 3: Delegation as first-class**                      | Foundation for scaling beyond first pilot                                |

## Open questions to resolve before any wedge starts

1. Sitelayer migration numbering — confirm next sequential migration is 093 (`init/092_*.sql` is highest under `docker/postgres/init/`).
2. Audit Escrow signing key — generate fresh Ed25519, store where? (operator-private vs sitelayer-prod-env)
3. Delegation revoke semantics — does revoke cascade to in-flight QBO writes? (recommend: no; revoke is forward-only; in-flight writes complete with a `revoked_during_execution` flag).
4. PEL view registration — confirm with mesh PR 115 author whether sitelayer-side views need any specific naming convention beyond `view_sitelayer_*`.

## Cross-references

- Operator thesis: `~/projects/digital-ontology/docs/agent-control-plane-vendor-map.md`
- Drift concepts: `~/projects/digital-ontology/docs/ontology-maintenance-architecture.md`
- 28-day window: `~/projects/digital-ontology/docs/subscription-leverage-plan-2026-05-21.md`
- Context handoff design: `docs/CONTEXT_HANDOFF_ARCHITECTURE.md`, `docs/CONTEXT_HANDOFF_IMPLEMENTATION_PLAN.md`, `docs/RUNBOOK_CONTEXT_HANDOFF.md`
- QBO live gate: `docs/qbo-live-flip-checklist.md`, `docs/RUNBOOK_QBO_CIRCUIT.md`
- Coupling boundary: `~/projects/control-plane/docs/adr/0024-sitelayer-control-plane-coupling-default.md`
- Audit escrow concept: `~/projects/digital-ontology/docs/agent-control-plane-vendor-map.md` §8
