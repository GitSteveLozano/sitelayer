# WebMCP shim — sitelayer as an in-browser tool provider

This is the **in-browser complement** to [`AGENT_TOOLS.md`](./AGENT_TOOLS.md)
(`GET /api/agent-tools`). Where the manifest lets a **server-side / external**
agent _discover_ sitelayer's deterministic workflows, the WebMCP shim lets a
**WebMCP-capable in-tab agent** (Chrome's "Web Model Context" early preview, or
a browser-bridge shim) actually _call_ them — from inside the running SPA,
through the app's own authenticated fetch client.

This completes the "instrument your own app" move: it is no longer just a
read-only manifest an agent can read; the app now **registers itself as a tool
provider** the in-tab agent can drive.

## Why (the same bet as AGENT_TOOLS.md)

Pointing a generic browser/computer-use agent at a web app's **DOM** is ~2–3×
_less_ reliable than calling the app's own tools (WebArena: pure browsing 15% →
hybrid 39%). Chrome's **WebMCP** standard productizes that: an app declares its
own tools so an agent calls `apply_workflow_event(...)` instead of guessing
which button does what. Sitelayer already runs everything important as
deterministic statechart workflows (pure reducers + `workflow_event_log`), so
the tools just expose that state machine.

## The surface

The shim registers three tools with the in-tab WebMCP host, all backed by the
single web HTTP client (`apps/web/src/lib/api/client.ts:request<T>()`) so
company-slug + Clerk/act-as auth + Sentry trace propagation travel exactly as
they do for every other call — **no auth bypass, no new backend**:

| Tool                              | Backs onto                        | Returns                                                             |
| --------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| `sitelayer_list_workflows`        | `GET /api/agent-tools`            | the full manifest (states, legal events per state, the contract)    |
| `sitelayer_get_workflow_snapshot` | `GET /api/<workflow>/:id`         | `WorkflowSnapshot { state, state_version, context, next_events }`   |
| `sitelayer_apply_workflow_event`  | `POST /api/<workflow>/:id/events` | the fresh snapshot, or a structured 409 `{ status, body }` to retry |

`<workflow>` is the **API route segment** documented in the manifest's
`invocation` block (e.g. `rental-billing-runs`, `shipments`, `boms`) — NOT the
underscore `workflow_name` (`rental_billing_run`). The manifest deliberately
does not hardcode a name→route table, and neither does the shim: the agent
reads the manifest to learn the contract, then supplies the route segment. The
shim only validates the segment against `^[a-z0-9]+(?:-[a-z0-9]+)*$` so a tool
argument can never inject a slash / `..` / query string and escape `/api/`.

### Driving a workflow

1. `sitelayer_list_workflows()` → learn each workflow's states, route segment,
   and `legal_events_by_state`.
2. `sitelayer_get_workflow_snapshot({ workflow, id })` → read the current
   `state`, `state_version`, and `next_events`.
3. `sitelayer_apply_workflow_event({ workflow, id, event, state_version })` →
   dispatch one of the `next_events`. Send the `state_version` from step 2
   (optimistic concurrency). A stale version or an illegal transition returns a
   **409** carrying the authoritative `{ error, snapshot }` — read the fresh
   `next_events` and retry. Only dispatch events listed in
   `legal_events_by_state[currentState]`; worker-only events
   (e.g. `POST_SUCCEEDED`) are omitted from the manifest and rejected by the API.

## Where it lives

| File                                                  | Role                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/lib/webmcp/webmcp-adapter.ts`           | **Swappable adapter.** All contact with the raw browser API (`navigator.modelContext`). Feature-detects + normalizes `registerTool`. |
| `apps/web/src/lib/webmcp/register-sitelayer-tools.ts` | Builds the three tool descriptors over `request<T>()` and registers them via the adapter. No-ops cleanly if no host.                 |
| `apps/web/src/lib/webmcp/use-webmcp-tools.ts`         | React mount — registers on mount, unregisters on unmount.                                                                            |
| `apps/web/src/App.tsx` (`AuthenticatedAppRoutes`)     | Mounts the shim once inside the signed-in shell, beside the capture dock.                                                            |

## Capability posture / lifecycle

- **Feature-detected.** `detectWebMcp()` returns `null` unless
  `navigator.modelContext.registerTool` exists. Every non-preview browser today
  hits the clean no-op path — nothing renders, nothing registers.
- **Signed-in only.** Mounted inside `ClerkAuthGate` (`<SignedIn>` / dev
  fixture-auth), the same posture as the rest of the authenticated app. The
  tools call the app's auth'd client; an unauthenticated API simply 401s like
  any other call.
- **Session-scoped.** Registration is torn down on unmount / sign-out (the mount
  hook returns the disposer), so provider state never leaks across sessions.

## The swappable adapter

The Chrome early-preview WebMCP API is still moving (method names, declarative
vs imperative tool lists). The shim isolates **all** raw-browser contact in
`webmcp-adapter.ts` behind a small normalized surface
(`detectWebMcp` / `registerTools` / `WebMcpToolDescriptor`). When the standard
lands, only that one file changes — `register-sitelayer-tools.ts` (the actual
tool logic) stays as-is. The adapter also adapts our plain async POJO handlers
to the host's MCP-style `{ content: [{ type: 'text', text }] }` result envelope.

## Tests

`apps/web/src/lib/webmcp/register-sitelayer-tools.test.ts` covers the
feature-detect no-op path, the tool-descriptor shape, route-segment validation
(escape attempts rejected before any network call), the `request<T>()` paths /
bodies, the 409-as-structured-result path, and dispose teardown.
