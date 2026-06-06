# Postmortem — `<incident-slug>`

Blameless, Google-SRE-style. Single-engineer ops: fill this in 30 minutes, not
a day. Skip sections that genuinely do not apply (write "n/a"), but do not
skip the action items.

Save as `docs/postmortems/YYYY-MM-DD-<slug>.md` and link from the relevant
runbook's **Post-incident** section.

---

## Incident summary

- **One-line description:** _e.g. QBO sync stalled for 4 hours after Intuit
  rotated their OAuth token signing key._
- **Severity:** SEV-1 (customer-facing outage) / SEV-2 (degraded) /
  SEV-3 (internal-only)
- **Actual start at:** `YYYY-MM-DDTHH:MM:SSZ` (first user impact, not
  detection)
- **Detected at:** `YYYY-MM-DDTHH:MM:SSZ`
- **Resolved at:** `YYYY-MM-DDTHH:MM:SSZ`
- **Duration:** `HH:MM` (resolved − actual_start)

## Detection

How did we find out? Pick one and be honest:

- [ ] Sentry alert (which project / issue link)
- [ ] Prometheus / `/api/metrics` (which metric)
- [ ] Customer report (who, channel)
- [ ] Accidental observation while doing something else
- [ ] CI / deploy failure

**Detection latency** = `detected_at − actual_start_at` = `HH:MM`.

If detection latency is > 15 minutes for a SEV-1, that goes in **Follow-ups**
as "alert that would have caught this earlier."

## Impact

- **What failed for users?** _e.g. clock-in confirmations not delivered;
  estimate push to QBO blocked._
- **How many users / how much data?** _e.g. 14 active foremen, ~80 clock
  events queued in `notifications.status='pending'`, no data loss._
- **Did we breach a documented SLO?** _If we have none, write "no SLO
  documented yet — candidate for follow-up."_
- **Money / regulatory?** _Customer credits owed? PIPEDA notification
  threshold crossed?_

## Timeline

All timestamps UTC. Include "nothing happened" gaps if they're informative.

| Time (UTC) | Event                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| `HH:MM`    | Actual start — first symptom (often inferred from logs after-the-fact). |
| `HH:MM`    | Detection event (alert fired / customer message / dashboard glance).    |
| `HH:MM`    | First diagnostic action.                                                |
| `HH:MM`    | Mitigation applied.                                                     |
| `HH:MM`    | Recovery confirmed (curl green / metric returned to baseline).          |
| `HH:MM`    | Customer comms sent (if applicable).                                    |

## Root cause

Five-whys style. Stop when the next "why" is "human error" without a
mechanical guardrail — that's not a root cause, that's a follow-up.

1. **Why did `<symptom>` happen?** Because `<X>`.
2. **Why did `<X>` happen?** Because `<Y>`.
3. **Why did `<Y>` happen?** Because `<Z>`.
4. **Why did `<Z>` happen?** Because `<W>`.
5. **Why did `<W>` happen?** Because `<root>`.

If multiple contributing causes, list them — incidents are rarely
single-cause.

## Mitigation

What actually stopped the bleeding (not what should have, what did):

- Rollback to SHA `<sha>` via `scripts/rollback-droplet.sh`?
- Env flip by editing `/app/sitelayer/.env` on the prod droplet + container bounce (local-fleet; no GitHub Actions)?
- Manual container restart?
- Waited for upstream provider to recover?
- Manual SQL fix (paste the statement and link to a planning note)?

Time from detection to mitigation = `HH:MM`. If > 30 min, this is a runbook
gap — note in **Follow-ups**.

## Follow-ups

Concrete, owned, dated. "We should monitor this better" is not an action
item; "Add Prometheus alert on `sitelayer_circuit_breaker_state{integration="qbo"} == 1`
sustained > 10 min — owner: Taylor — due: YYYY-MM-DD" is.

| #   | Action                                                  | Owner  | Due          | Tracker link              |
| --- | ------------------------------------------------------- | ------ | ------------ | ------------------------- |
| 1   | _Test/gate/runbook update that would have caught this._ | Taylor | `YYYY-MM-DD` | mesh task / GH issue / PR |
| 2   | _Mechanical guardrail in dispatch code._                |        | `YYYY-MM-DD` |                           |

Prioritize: (a) detection gap, (b) mechanical guardrail in code, (c) runbook
update, (d) follow-on infra change.

## Lessons learned

- **What surprised us?** _The thing nobody expected._
- **What worked well?** _Genuinely — keep this lean, but acknowledge things
  that saved time so we don't accidentally remove them later._
- **What did the runbook miss?** _Direct input into the relevant_
  `docs/RUNBOOK_*.md` _update._

---

_Drafted by: `<name>`. Reviewed: n/a (single-engineer ops)._
