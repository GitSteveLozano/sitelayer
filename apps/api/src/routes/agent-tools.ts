import type http from 'node:http'
import { listWorkflows } from '@sitelayer/workflows'

/**
 * Agent-tools discovery surface — the "instrument your own app" / WebMCP-spirit
 * move. Instead of pointing a generic browser agent at sitelayer's DOM (which
 * the 2026 research shows is 2-3x LESS reliable), expose sitelayer's OWN
 * deterministic statecharts as self-describing, agent-callable tools.
 *
 * Every deterministic workflow already exposes, per entity:
 *   GET  /api/<workflow-route>/:id          -> WorkflowSnapshot{state,state_version,context,next_events}
 *   POST /api/<workflow-route>/:id/events   -> { event, state_version }  (optimistic; 409 on stale/illegal)
 *
 * This manifest enumerates the registered workflows + their state machine
 * (states, the event vocabulary, and which events are LEGAL from which state)
 * so an LLM agent — or a thin WebMCP shim — can drive the app through its own
 * reducers rather than guessing the DOM. Read-only; sits behind the standard
 * authenticated dispatch path. No tenant data — just the workflow contract.
 */

export type AgentToolsRouteCtx = {
  sendJson: (status: number, body: unknown) => void
}

export function buildAgentToolsManifest() {
  const workflows = listWorkflows()
    .map((def) => ({
      name: def.name,
      schema_version: def.schemaVersion,
      initial_state: def.initialState,
      terminal_states: [...def.terminalStates],
      all_states: [...def.allStates],
      all_event_types: [...def.allEventTypes],
      side_effect_types: [...def.sideEffectTypes],
      // The agent-actionable part: from each non-terminal state, the human
      // events the reducer will accept. (Worker-only events are excluded by
      // nextEvents.) An agent reads this to know what it can legally dispatch.
      legal_events_by_state: Object.fromEntries(def.allStates.map((state) => [state, def.nextEvents(state)])),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    contract_version: 1,
    description:
      'Self-describing catalog of sitelayer deterministic-workflow tools. Drive the app through its own ' +
      'state machines (reliable, no DOM guessing) instead of generic browser automation.',
    invocation: {
      snapshot: 'GET /api/<workflow-route>/:id -> WorkflowSnapshot { state, state_version, context, next_events }',
      apply_event: 'POST /api/<workflow-route>/:id/events with body { event, state_version }',
      concurrency:
        'Optimistic. Send the state_version from the latest snapshot. A stale state_version or an ' +
        'illegal transition returns 409 — refetch the snapshot (next_events tells you what is now legal) and retry.',
      legality:
        'Only dispatch events listed in legal_events_by_state[currentState] (mirrors WorkflowSnapshot.next_events). ' +
        'Worker-only events (POST_SUCCEEDED, etc.) are never human/agent-dispatchable and are omitted here.',
    },
    hybrid_posture:
      'Prefer these app-event tools for anything sitelayer owns; fall back to browser/DOM automation only for ' +
      'third-party surfaces. App-event tools beat generic browsing ~2-3x on reliability (WebArena: browsing 15% vs hybrid 39%).',
    workflow_count: workflows.length,
    workflows,
  }
}

export async function handleAgentToolsRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: AgentToolsRouteCtx,
): Promise<boolean> {
  if (req.method !== 'GET') return false
  if (url.pathname !== '/api/agent-tools' && url.pathname !== '/api/agent-tools/manifest') return false
  ctx.sendJson(200, buildAgentToolsManifest())
  return true
}
