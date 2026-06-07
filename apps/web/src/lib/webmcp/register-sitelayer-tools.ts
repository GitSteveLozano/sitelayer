// WebMCP shim — register sitelayer as an in-browser tool provider.
//
// This is the IN-BROWSER complement to the read-only `GET /api/agent-tools`
// manifest. Where the manifest lets a server-side / external agent DISCOVER
// sitelayer's deterministic workflows, this module lets a WebMCP-capable
// in-tab agent (Chrome's Web Model Context early preview, or a browser-bridge
// shim) actually CALL them — through the app's OWN authenticated fetch client,
// driving the deterministic statecharts instead of guessing at the DOM.
//
// Three tools, all backed by `apps/web/src/lib/api/client.ts:request<T>()`
// (so company-slug + Clerk/act-as auth + trace propagation travel exactly as
// they do for the rest of the app — no auth bypass, no new backend):
//
//   list_workflows()                                  → GET  /api/agent-tools
//   get_workflow_snapshot(workflow, id)               → GET  /api/<workflow>/:id
//   apply_workflow_event(workflow, id, event, sv?)    → POST /api/<workflow>/:id/events
//
// `workflow` is the API ROUTE SEGMENT documented in the manifest's
// `invocation` block (e.g. `rental-billing-runs`, `shipments`) — NOT the
// underscore workflow name. The manifest deliberately does not hardcode a
// name→route table, and neither do we: an agent reads the manifest, learns the
// contract, and supplies the route. We only sanitize the segment so a tool
// call can never escape `/api/` into an arbitrary path.
//
// All browser-API contact is quarantined in `./webmcp-adapter`. If the WebMCP
// surface is absent (every non-preview browser today), `registerSitelayerWebMcpTools`
// no-ops cleanly and returns a disposer that does nothing.

import { ApiError, request } from '@/lib/api/client'
import {
  detectWebMcp,
  registerTools,
  type WebMcpDisposer,
  type WebMcpHost,
  type WebMcpToolDescriptor,
} from './webmcp-adapter'

/** Shape of the workflow entries in the `GET /api/agent-tools` manifest. */
export interface AgentToolWorkflow {
  name: string
  schema_version: number
  initial_state: string
  terminal_states: string[]
  all_states: string[]
  all_event_types: string[]
  side_effect_types: string[]
  legal_events_by_state: Record<string, Array<{ type: string; label: string; disabled_reason?: string }>>
}

/** Shape of the `GET /api/agent-tools` response. */
export interface AgentToolsManifest {
  contract_version: number
  description: string
  invocation: Record<string, string>
  hybrid_posture: string
  workflow_count: number
  workflows: AgentToolWorkflow[]
}

/** Minimal WorkflowSnapshot shape every deterministic workflow returns. */
export interface WorkflowSnapshotShape {
  state: string
  state_version: number
  context: unknown
  next_events: Array<{ type: string; label: string; disabled_reason?: string }>
}

/**
 * Validate a workflow-route segment. The manifest's `invocation` contract is
 * `GET /api/<workflow-route>/:id` where `<workflow-route>` is a hyphenated
 * lowercase path segment (`rental-billing-runs`, `shipments`, `boms`). We
 * accept only `[a-z0-9-]` so a tool argument can never inject a slash, a
 * `..`, or a query string and reach an unintended endpoint.
 */
const WORKFLOW_ROUTE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isValidWorkflowRoute(workflow: unknown): workflow is string {
  return typeof workflow === 'string' && WORKFLOW_ROUTE_PATTERN.test(workflow)
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing required string argument: ${key}`)
  }
  return value
}

function requireWorkflowRoute(args: Record<string, unknown>): string {
  const workflow = args.workflow
  if (!isValidWorkflowRoute(workflow)) {
    throw new Error(
      'invalid "workflow" — expected the manifest route segment, e.g. "rental-billing-runs" ([a-z0-9-] only)',
    )
  }
  return workflow
}

/** Normalize an ApiError into a JSON-serializable result the agent can read. */
function describeApiError(err: ApiError): { error: string; status: number; body: unknown } {
  return { error: err.message_for_user(), status: err.status, body: err.body }
}

/**
 * Build the three tool descriptors. Exported (separately from registration) so
 * the descriptor shapes are unit-testable without a WebMCP host present.
 */
export function buildSitelayerWebMcpTools(): WebMcpToolDescriptor[] {
  return [
    {
      name: 'sitelayer_list_workflows',
      description:
        'List sitelayer deterministic workflows the agent can drive (states, legal events per state, the ' +
        'GET-snapshot / POST-events contract). Returns the GET /api/agent-tools manifest. Call this FIRST to ' +
        'learn each workflow’s route segment and event vocabulary before driving one.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => request<AgentToolsManifest>('/api/agent-tools'),
    },
    {
      name: 'sitelayer_get_workflow_snapshot',
      description:
        'Fetch the current WorkflowSnapshot { state, state_version, context, next_events } for one workflow ' +
        'entity. "workflow" is the manifest route segment (e.g. "rental-billing-runs"); "id" is the entity id. ' +
        'Read state_version + next_events here before applying an event.',
      inputSchema: {
        type: 'object',
        properties: {
          workflow: { type: 'string', description: 'Manifest route segment, e.g. "rental-billing-runs".' },
          id: { type: 'string', description: 'Entity id.' },
        },
        required: ['workflow', 'id'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const workflow = requireWorkflowRoute(args)
        const id = requireString(args, 'id')
        try {
          return await request<WorkflowSnapshotShape>(`/api/${workflow}/${encodeURIComponent(id)}`)
        } catch (err) {
          if (err instanceof ApiError) return describeApiError(err)
          throw err
        }
      },
    },
    {
      name: 'sitelayer_apply_workflow_event',
      description:
        'Apply a deterministic event to one workflow entity (optimistic-concurrency POST .../events). Send the ' +
        'state_version from the latest snapshot; a stale version or an illegal transition returns a 409 with the ' +
        'authoritative snapshot + next_events to retry from. Only dispatch events listed in ' +
        'legal_events_by_state[currentState].',
      inputSchema: {
        type: 'object',
        properties: {
          workflow: { type: 'string', description: 'Manifest route segment, e.g. "rental-billing-runs".' },
          id: { type: 'string', description: 'Entity id.' },
          event: { type: 'string', description: 'Event type, e.g. "APPROVE".' },
          state_version: {
            type: 'number',
            description: 'state_version from the latest snapshot (optimistic concurrency).',
          },
          payload: { type: 'object', description: 'Optional event payload.', additionalProperties: true },
        },
        required: ['workflow', 'id', 'event'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const workflow = requireWorkflowRoute(args)
        const id = requireString(args, 'id')
        const event = requireString(args, 'event')
        const body: Record<string, unknown> = { event }
        if (typeof args.state_version === 'number') body.state_version = args.state_version
        if (args.payload && typeof args.payload === 'object') body.payload = args.payload
        try {
          return await request<WorkflowSnapshotShape>(`/api/${workflow}/${encodeURIComponent(id)}/events`, {
            method: 'POST',
            json: body,
          })
        } catch (err) {
          // 409 carries the authoritative { error, snapshot } — surface it so
          // the agent can re-read next_events and retry, exactly like the UI.
          if (err instanceof ApiError) return describeApiError(err)
          throw err
        }
      },
    },
  ]
}

/**
 * Feature-detect WebMCP and, if present, register sitelayer's workflow tools.
 * No-ops cleanly when the browser has no WebMCP surface (returns a disposer
 * that does nothing). `hostOverride` is for tests; production reads the real
 * `navigator`.
 *
 * Returns a disposer the caller MUST invoke on unmount / sign-out so provider
 * registrations don't leak across sessions.
 */
export function registerSitelayerWebMcpTools(hostOverride?: WebMcpHost | null): WebMcpDisposer {
  const host = hostOverride ?? detectWebMcp()
  if (!host) return () => {}
  return registerTools(host, buildSitelayerWebMcpTools())
}
