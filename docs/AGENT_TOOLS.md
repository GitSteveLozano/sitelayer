# Agent tools — drive sitelayer through its own statecharts

`GET /api/agent-tools` (alias `/api/agent-tools/manifest`) returns a self-describing
catalog of sitelayer's deterministic workflows as **agent-callable tools**.

## Why this exists (the strategic bet)

The 2026 browser-agent research is blunt: pointing a generic browser/computer-use
agent at a web app's **DOM** is ~2–3× _less_ reliable than calling the app's own
tools/API (WebArena: pure browsing **15%** → API-based **29%** → hybrid **39%**).
Chrome's **WebMCP** standard productizes the same idea — an app _declares its own
tools_ so an agent calls `apply_event(...)` instead of guessing which button does what.

Sitelayer already runs everything important as **deterministic statechart workflows**
(pure reducers + `workflow_event_log`). This endpoint exposes that state machine so an
LLM agent — or a thin WebMCP shim — drives the app through its **own reducers**, not
the DOM. Use it as the **primary** path for anything sitelayer owns; fall back to
browser automation only for third-party surfaces (the hybrid posture).

## The contract

Every workflow exposes, per entity:

```
GET  /api/<workflow-route>/:id          -> WorkflowSnapshot { state, state_version, context, next_events }
POST /api/<workflow-route>/:id/events   -> body { event, state_version }
```

- **Legality:** only dispatch events listed in `legal_events_by_state[currentState]`
  (identical to `WorkflowSnapshot.next_events`). Worker-only events (e.g.
  `POST_SUCCEEDED`) are never agent-dispatchable and are omitted.
- **Concurrency:** optimistic. Send the `state_version` from the latest snapshot. A
  stale version or an illegal transition returns **409** — refetch the snapshot
  (its `next_events` tells you what's now legal) and retry.

## Manifest shape

```jsonc
{
  "contract_version": 1,
  "invocation": { "snapshot": "...", "apply_event": "...", "concurrency": "...", "legality": "..." },
  "hybrid_posture": "...",
  "workflow_count": <n>,
  "workflows": [
    {
      "name": "rental_billing_run",          // = workflow_event_log.workflow_name
      "schema_version": 1,
      "initial_state": "generated",
      "terminal_states": ["voided"],
      "all_states": ["generated", "approved", "posting", "posted", "failed", "voided"],
      "all_event_types": ["APPROVE", "POST_REQUESTED", "POST_SUCCEEDED", ...],
      "side_effect_types": ["post_qbo_invoice"],
      "legal_events_by_state": {
        "generated": [{ "type": "APPROVE", "label": "Approve" }],
        "approved":  [{ "type": "POST_REQUESTED", "label": "Post to QBO" }],
        "voided":    []
      }
    }
    // ... one per registered workflow
  ]
}
```

Source: `apps/api/src/routes/agent-tools.ts` (`buildAgentToolsManifest`), enumerating the
registry in `packages/workflows/src/registry.ts` (`listWorkflows`). The endpoint is
read-only and sits behind the standard authenticated dispatch path; it exposes the
workflow _contract_, never tenant data.
