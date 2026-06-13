# SiteLayer — Vision (the one statement)

> The single source for "what are we building and why." Every dated plan doc
> under `docs/` (the `*_PLAN.md`, `ROADMAP_NEXT`, `MORE_TO_BUILD` files) is a
> child of this — when they disagree with this file, this file wins. Last
> reconciled 2026-06-13.

## The pilot bar (success = this, nothing more)

**One EIFS / stucco / scaffolding contractor — Cavy Braun (the `la-operations`
seed slug) — runs a real job end to end with no manual intervention:**

> login → upload blueprint → PlanSwift-lite takeoff → estimate (scope-vs-bid +
> per-scope pricing) → QBO sync → automated rental invoicing.

As of 2026-06-13 this loop is **wired and tested end-to-end**; shipping it is an
**operator/config gate, not a code gate** (provision the company, flip the live
QBO env, run the DR drill). It is NOT 4-6 weeks of code away. See
[`CRITICAL_PATH.md`](./CRITICAL_PATH.md) for the live state and the residual
gaps.

The customer's actual asks are the spec — [`docs/CUSTOMER_REQUIREMENTS_CAVY.md`](./docs/CUSTOMER_REQUIREMENTS_CAVY.md).
Anything Cavy did not ask for is a nice-to-have until he does.

## The named-open pilot gaps (the only product distance to "ships")

Three product gaps remain between "loop wired" and "Cavy runs it daily" (from
`CUSTOMER_REQUIREMENTS_CAVY.md`):

1. **Live QBO actual-cost pull** — close the estimate-vs-actual loop with real
   QBO costs, not just sitelayer-side labor.
2. **Per-customer rate-template editor** — let the contractor edit negotiated
   per-customer rates without a dev.
3. **Volume / count takeoff depth** — the remaining PlanSwift-parity takeoff
   modes.

Everything else the audits flag is debt, ops, or polish — not pilot distance.

## The durable asset (why the platform breadth is NOT scope-creep)

SiteLayer is **two things, deliberately**:

1. **The product** — the Cavy contractor loop above.
2. **A published contract, `@operator/projectkit`** — capture, logging,
   context-handoff, project-event, and task-gen live **outside** the app in the
   versioned contract (`packages/projectkit-bridge`, conformance-gated). The
   operator's projects (chess / nhl / learn / sitelayer / …) are **testbeds that
   emit**; **mesh is ONE subscriber/adapter behind a URL, never the owner**
   (swap it without changing the Probe / Concern / Dispatch / Callback shapes —
   the One-Line Boundary Test). **SiteLayer is testbed #1.**

So the capture / issue-board / onsite-ops / agent-feed breadth in the tree is
**the emit-seam**, not a second product. It is governed by
[`docs/adr/0008-projectkit-emit-seam.md`](./docs/adr/0008-projectkit-emit-seam.md)
and the locked decisions in `CLAUDE.md` (capture → issue-board). `app_issue`
(software bugs about the app) and `field_request` (the contractor's real-world
job problems) are permanently separate domains.

## What this is NOT

- **Not a generic construction SaaS.** The bar is one contractor's loop, not a
  market.
- **Not a capture / issue-board / diagnostics product.** Those are emit-seam
  testbeds and internal operator tooling, not customer scope. When a
  diagnostics/onsite-ops thread starts to out-commit pilot depth, that is the
  signal to converge, not to keep building breadth.

## How we build it (the operating model, for context)

- **Architecture decisions of record:** [`docs/adr/`](./docs/adr/) — framework-free
  Node HTTP + raw SQL + RLS (0007), deterministic temporal-style reducer
  workflow engine (0006), the projectkit emit-seam (0008), no-GitHub-Actions /
  local-fleet deploy (0009). `CLAUDE.md` is the detailed operator handbook.
- **Two deploy lines:** `dev` = agent churn (auto-deploys), `main` = the
  promoted line behind a gated `dev → main` promotion (`docs/RELEASE_GATES.md`).
- **The code is written by a multi-agent fleet.** Keep the vision legible so the
  fleet converges on the pilot rather than sprawling into breadth.
