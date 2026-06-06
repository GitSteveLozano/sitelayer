# Domain Docs

Engineering skills should use this repo's domain documents before exploring or changing code.

## Before Exploring

Read these in order when relevant:

1. `CONTEXT.md`
2. `README.md`
3. `DEPLOYMENT.md`
4. `DEVELOPMENT.md`
5. `CRITICAL_PATH.md`
6. `docs/adr/`
7. `docs/agents/issue-tracker.md`

If a document does not exist, proceed silently. Create domain docs lazily when a term, tradeoff, or decision becomes durable.

## Vocabulary

Use terms from `CONTEXT.md` in task titles, tests, refactor proposals, hypotheses, and summaries. If a concept needs a name and the glossary lacks it, either reuse existing project language or update `CONTEXT.md`.

## Test scenarios

When a reproducer or perf smoke needs a tenant in a specific state
(rental stuck mid-flight, project at closeout with unbilled rentals,
500-takeoff perf bulk, ...), reach for the YAML-driven fixture builder
at `scripts/seed-scenario.ts`. Per-scenario YAMLs live in `scenarios/`;
the full grammar + starter list is in `docs/TEST_SCENARIOS.md`. The
seeder walks deterministic-workflow event sequences through the
registered reducers in `@sitelayer/workflows`, so the resulting
`workflow_event_log` rows match what production would have written —
`scripts/replay-workflow.ts` will pass against any seeded entity.

## ADRs

Add an ADR only when all are true:

- The decision is hard to reverse.
- The decision would be surprising without context.
- The decision came from a real tradeoff between plausible alternatives.

If a recommendation contradicts an ADR, say so explicitly and explain why reopening it is worth considering.
