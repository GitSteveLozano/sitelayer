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

## ADRs

Add an ADR only when all are true:

- The decision is hard to reverse.
- The decision would be surprising without context.
- The decision came from a real tradeoff between plausible alternatives.

If a recommendation contradicts an ADR, say so explicitly and explain why reopening it is worth considering.
