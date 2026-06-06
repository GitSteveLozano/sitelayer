# Triage Labels

This repo does not require a separate label database for imported skills. Use the tracker mapping below when a skill says "label", "triage", "ready", or "needs info".

| Imported role     | Representation           | Meaning                                                |
| ----------------- | ------------------------ | ------------------------------------------------------ |
| `bug`             | `kind:bug`               | Something is broken                                    |
| `enhancement`     | `kind:enhancement`       | New behavior or improvement                            |
| `needs-triage`    | `triage:needs-triage`    | Maintainer needs to evaluate                           |
| `needs-info`      | `triage:needs-info`      | Waiting on more information                            |
| `ready-for-agent` | `triage:ready-for-agent` | Brief is complete and can be picked up by an agent     |
| `ready-for-human` | `triage:ready-for-human` | Needs human judgment, credentials, or manual operation |
| `wontfix`         | `triage:wontfix`         | Will not be actioned                                   |

## Rules

- A triaged item should have exactly one category marker and one triage marker.
- `ready-for-agent` items need a durable agent brief, acceptance criteria, scope boundaries, and verification commands.
- `ready-for-human` items should name the exact human decision or credential needed.
- `needs-info` items should include the exact missing information in the task body, issue, or local note.
- Durable `wontfix` decisions should be recorded in an ADR or `.out-of-scope/` note when the reason is likely to be relitigated.
