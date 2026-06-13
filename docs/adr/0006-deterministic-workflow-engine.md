# ADR 0006 — Deterministic temporal-style workflow engine (pure reducers), not a workflow runtime

**Status:** accepted
**Date:** 2026-06-13 (documents a decision in force since 2026-04-28; see `docs/DETERMINISTIC_WORKFLOWS.md`)
**Supersedes:** —
**Superseded by:** —

## Context

SiteLayer has many multi-step business processes — rental billing, estimate
push, project lifecycle, time review, labor payroll, crew schedule, field event,
QBO sync, shipment, damage-charge settlement, daily log, notification, … Modeled
naively, each becomes scattered `if (status === 'foo')` branches across routes,
the worker, and React components, with no single place that says which
transitions are legal or where side effects happen. The eventual options are a
real durable workflow runtime (Temporal) or a hand-rolled convention.

This ADR records the choice that has governed the codebase since the first
rental-billing slice and was hardened again on 2026-06-13 (the per-module
dispatch-descriptor refactor, ADR-adjacent).

## Decision

**Model every multi-step process as a deterministic state machine: a pure
reducer + state version + append-only event log + headless UI, on Postgres —
Temporal-compatible by design but not adopted.**

Concretely:

1. **Pure reducers in `packages/workflows/`.** Each workflow exports state/event
   types, a pure `(snapshot, event) → snapshot` transition (no clock, no IO, no
   db, no random), a `nextEvents(state)` selector, and self-registers in
   `registry.ts`. 20 workflows are registered (guarded by
   `registry-docs.test.ts`).
2. **One dispatch primitive.** `apps/api/src/workflow-dispatch.ts`
   `dispatchWorkflowEvent` runs load → optimistic version-check → pure-reduce →
   persist → `recordWorkflowEvent` (always) → side-effects, inside one tx. A lint
   ratchet (`workflow-dispatch-ratchet.test.ts`, scanning all of
   `apps/api/src/`) bans new hand-rolled event-log writes.
3. **Append-only `workflow_event_log` + replay harness.** Every transition
   appends one row keyed `(entity_id, state_version)`. `packages/workflows/src/replay.ts`
   and `scripts/replay-workflow.ts` replay a row's history through the registered
   reducer and assert bit-for-bit equality with live state. Property
   (`fast-check`) and golden (`nextEvents` snapshot) tests per workflow.
4. **Side effects are outbox rows, never inline.** QBO pushes / notifications
   are enqueued to `mutation_outbox` with stable idempotency keys; the worker
   drains them and emits `*_SUCCEEDED` / `*_FAILED` back through the same reducer.
5. **UI is a thin renderer.** Frontend orchestration uses XState
   (`apps/web/src/machines/`) for UI-interaction state only (loading / submitting
   / error); it derives business state from the server snapshot and **never
   invents a transition the reducer doesn't allow** (`headless-workflow.ts`).

## Why not Temporal (yet)

Temporal is attractive only once a production workflow needs durable timers
across days, multi-step external retries, human-approval waits, cancellation, and
painful recovery if the process dies mid-flow — see
`docs/DETERMINISTIC_WORKFLOWS.md` "When To Introduce Temporal." Until then it is
infrastructure overhead. The pure reducer is precisely the deterministic
transition core a Temporal activity would later wrap, so adopting Temporal is
additive, not a rewrite. `workflow_engine='postgres'` today; `'temporal'` later
if it earns its place.

## Consequences

**Positive:** transitions are reviewable, unit-testable in isolation, and
replayable; the event log is a regression net; the UI can't drift from the
backend's allowed transitions; migrating one workflow to Temporal later doesn't
disturb the rest.

**Negative:** the discipline is load-bearing — the ratchet, the registry, and
the `dispatchWorkflowEvent` convention have to be enforced (they are, by tests).
A contributor who hand-rolls `set status = …` on a workflow table is the failure
mode; that's exactly what the ratchet + `recordWorkflowEvent` guard.

## References

- `docs/DETERMINISTIC_WORKFLOWS.md` — the full design contract.
- `packages/workflows/`, `apps/api/src/workflow-dispatch.ts`,
  `workflow-dispatch-ratchet.test.ts`, `registry-docs.test.ts`.
- 2026-06-13: collapsed the last parallel transition table (estimate-share
  lifecycle) onto the registered reducer; moved per-route dispatch descriptors
  into their modules.
