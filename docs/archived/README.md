# Archived documentation

Date-stamped historical docs. These captured the project's intent / architecture / requirements at a specific point in time and were superseded by the live code, `CLAUDE.md`, or newer ADRs. Not deleted because they're useful for "how did we get here" archaeology.

**None of these are authoritative.** The live state of the system lives in:

- `apps/web-v2/`, `apps/api/`, `apps/worker/`, `packages/*` — the code
- `CLAUDE.md` — operating rules, deploy procedure, current snapshot
- `docs/adr/` — durable architectural decisions
- `DEPLOY_RUNBOOK.md` — deploy/migration contract

If you find something here that contradicts current code or the docs above: **trust current code**.

## What's in here

| File                                                        | Original purpose                                   | Why archived                                        |
| ----------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| `COMPREHENSIVE_REQUIREMENTS_AND_ARCHITECTURE_2026-04-25.md` | Pre-pilot synthesis of requirements + architecture | Superseded by `CLAUDE.md` + the ADRs                |
| `PRODUCT_DIRECTION_2026-04-25.md`                           | Product roadmap when the L&A pilot was active      | No customers; pilot reference is no longer relevant |
| `REQUIREMENTS_SPEC_2026-04-25.md`                           | Reference architecture written for L&A operations  | Same — pilot template, not binding                  |
| `GREENFIELD_ARCHITECTURE_PLAN_2026-04-24.md`                | Early architecture sketch                          | Superseded by what shipped                          |
| `FINAL_FINDINGS_AND_IMPLEMENTATION_PLAN_2026-04-23.md`      | Pre-pilot synthesis from QBO/domain research       | Captured for context; superseded by current code    |
