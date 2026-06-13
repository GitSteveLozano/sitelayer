# ADR 0008 — `@operator/projectkit` emit-only seam: the app is a testbed that emits; mesh is one swappable subscriber

**Status:** accepted
**Date:** 2026-06-13 (documents the locked decision of 2026-06-04; see capture → issue-board in `CLAUDE.md`)
**Supersedes:** —
**Superseded by:** —

## Context

SiteLayer accumulated cross-cutting machinery that is not construction-domain:
capture (feedback/diagnostics), logging, context-handoff, project-event emission,
task generation, the issue board, agent-feed, and onsite-ops diagnostics. The
risk is that this machinery couples tightly to the operator's private `mesh`
control-plane, turning SiteLayer into a mesh-internal component instead of an
independent product. The opposing pull (and the operator's standing directive) is
that this seam must be **between-repos**, captured in a published contract, with
mesh as merely one adapter.

## Decision

**Capture / logging / context-handoff / project-event / task-gen live OUTSIDE
the app, in the published `@operator/projectkit` contract. SiteLayer is a
testbed that EMITS through that contract. Mesh is ONE subscriber/adapter behind a
URL — never the owner of the data.**

Concretely:

1. **The contract is a versioned dependency**, consumed via git-ref tags
   (`@operator/projectkit`), bridged in `packages/projectkit-bridge` with a
   conformance gate (`packages/projectkit-bridge/src/index.test.ts`). The
   dispatch payload carries a `Concern`/`WorkRequest` snapshot; the inbound
   agent callback carries a `Callback` snapshot.
2. **Mesh is a swappable backend behind a URL.** `MESH_API_URL` is the default
   dispatch backend; the One-Line Boundary Test is that you can swap mesh for a
   second adapter (e.g. projectkit's `local-executor`) without changing the
   Probe / Concern / Dispatch / Callback shapes. A deployment with no mesh access
   degrades cleanly (the AI-chat widget feature-flags OFF, etc.).
3. **Two domains stay permanently separate.** `app_issue` = software bugs/feedback
   about the app (a platform-superadmin capability a normal company role can
   never hold) vs `field_request` = the contractor's real-world job problems (a
   crew feature). They were wrongly merged once; never again.
4. **Onsite-ops diagnostics ride the same seam.** The onsite/ops-diagnostics
   layer (control tokens, agent-feed delivery, leave-behind captures) is internal
   operator/agent-support tooling that emits through projectkit — not customer
   scope.

## Consequences

**Positive:** the platform breadth is the emit-seam, not product scope-creep
(see [`VISION.md`](../../VISION.md)); SiteLayer stays an independent product;
swapping or removing mesh is a config change, not a refactor; the same contract
backs the operator's other testbeds.

**Negative:** the seam needs active policing — the failure mode is mesh-coupling
creeping back in, or onsite-ops telemetry blurring the customer emit-seam vs
internal fleet telemetry. The conformance gate + the boundary test are the
guards; the standing operator directive is the doctrine.

## References

- `CLAUDE.md` — "Capture → issue board (`app_issue`) — locked decisions"
  (Decision C, 2026-06-04) + the operator-intent emit-seam doctrine.
- `packages/projectkit-bridge/`, `~/notes/how-capture-works-across-testbeds-2026-06-06.md`.
- [`VISION.md`](../../VISION.md) — why this makes the breadth coherent.
