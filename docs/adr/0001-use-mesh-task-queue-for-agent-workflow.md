# ADR 0001: Use Mesh Tasks As The Agent Issue Tracker

Date: 2026-04-29

## Status

Accepted

## Context

The imported `/tmp/skills` workflow expects a per-repo issue tracker, triage vocabulary, and domain documentation layout.

This project is managed through Mesh, where durable tasks, runs, dependencies, scheduler decisions, review state, and task/run lineage are already observable.

Using a separate agent issue tracker would split the source of truth and bypass the runtime surfaces that make autonomous work traceable.

## Decision

Use the Mesh orchestrated task queue as this repo's agent issue tracker.

Imported skill language maps as follows:

- "issue" or "ticket" means Mesh task.
- "issue tracker" means Mesh orchestrated task queue.
- "labels" mean task tags, using the mappings in `docs/agents/triage-labels.md`.
- "agent brief" means the durable behavior-level task body described in `docs/agents/issue-tracker.md`.

## Consequences

- Agent workflow state stays in the same system that dispatches and observes agent work.
- Task traces, run artifacts, scheduler decisions, and review state remain connected.
- Skills imported from `/tmp/skills` need light adaptation where they assume GitHub/GitLab commands.
