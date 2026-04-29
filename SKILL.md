---
name: sitelayer
description: Default engineering workflow for the Sitelayer repo. Applies to planning, debugging, implementation, review, and autonomous task work.
---

# Sitelayer Engineering Skill

Use this skill for ordinary engineering work in this repo.

## Before Work

- Read the root agent doc (`CLAUDE.md` or `AGENTS.md`) when present.
- Read `CONTEXT.md` for domain language when present.
- Read relevant ADRs under `docs/adr/`.
- Read `docs/agents/issue-tracker.md` before creating or updating work items.

## Debugging

- Build a deterministic feedback loop before hypothesizing: targeted test, CLI fixture, API script, trace replay, or a small harness.
- Reproduce the exact user-visible failure, then write falsifiable hypotheses.
- Instrument one hypothesis at a time and remove temporary logs before finishing.
- Turn the minimized repro into a regression test at the real seam when a good seam exists.

## Implementation

- Prefer vertical slices: one observable behavior, one test, one implementation step, one verification loop.
- Test through public interfaces and runtime contracts, not private helper shape.
- Keep scope boundaries explicit when touching shared infrastructure or user-facing workflows.

## Architecture

- Prefer deep modules: small interface, meaningful implementation behind it.
- Use the deletion test. If removing a module only removes indirection, it was shallow.
- The interface is the test surface. If the only useful test must reach through the interface, the module shape is suspect.

## Task Work

- Treat the tracker documented in `docs/agents/issue-tracker.md` as the issue tracker for imported skills.
- Split plans into end-to-end tasks, not layer-only tasks.
- A task ready for an autonomous worker needs current behavior, desired behavior, acceptance criteria, scope boundaries, and verification commands.
