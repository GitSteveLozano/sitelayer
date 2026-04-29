# Issue Tracker: Mesh Task Queue

Agent work for this repo lives in the Mesh orchestrated task queue.

## Conventions

- **Create an issue/task**: use mesh MCP `create_task`, or `POST /api/orchestrate/tasks`.
- **Read an issue/task**: use `get_task_details`, `get_task_timeline`, `task_trace`, or `GET /api/orchestrate/tasks/<id>`.
- **List/search work**: use `list_orchestrated_tasks`, `search_orchestrated_tasks`, or `GET /api/orchestrate/tasks`.
- **Update work**: use `update_task` or `PATCH /api/orchestrate/tasks/<id>`.
- **Complete/fail/cancel work**: use task/run transition tools rather than editing local files as the source of truth.

When an imported skill says "issue", "ticket", or "publish to the issue tracker", create or update a Mesh task unless the user explicitly asks for another tracker.

## Task Body Shape

For autonomous work, write task descriptions as durable agent briefs:

```markdown
## Agent Brief

**Category:** bug / enhancement / maintenance / architecture
**Summary:** one-line behavior-level summary

**Current behavior:**
What happens now.

**Desired behavior:**
What should happen after the task is complete.

**Key interfaces:**

- Interface, type, command, route, or config shape that matters

**Acceptance criteria:**

- [ ] Concrete observable criterion
- [ ] Concrete observable criterion

**Verification:**

- Command or deterministic feedback loop to run

**Out of scope:**

- Adjacent work the agent should not touch
```

Prefer behavioral contracts over file-path instructions. File paths are acceptable as discovery hints, but acceptance criteria must not depend on a line number staying stable.

## Vertical Slices

When breaking a plan into tasks:

- Create thin vertical slices that are independently verifiable.
- Each task should cross the relevant layers only as far as needed for one complete behavior.
- Use `blocked_by` for real ordering constraints.
- Set `project_name` to `sitelayer`.
- Keep `auto_dispatch=false` until the brief is ready for an autonomous worker.
- If a task should force a project-local skill, include `skill_slugs` in task execution context or properties.
