// WebMCP browser-API adapter.
//
// The Chrome "Web Model Context" early preview exposes an in-tab
// tool-provider surface at `navigator.modelContext`. The exact shape is
// still moving (the W3C Web Machine Learning CG draft + Chrome's origin
// trial have iterated on method names — `registerTool` vs `provideContext`,
// imperative vs declarative tool lists), so EVERYTHING that touches the raw
// browser object is quarantined here. The rest of the WebMCP shim
// (`register-sitelayer-tools.ts`) talks only to this normalized surface, so
// when the standard lands we change one file, not the registration logic.
//
// Design contract:
//   - Feature-detect first. If `navigator.modelContext` (or the method we
//     need) is absent, `detectWebMcp()` returns null and the caller no-ops.
//   - `registerTools()` returns a disposer so the app shell can unregister on
//     unmount / sign-out without leaking provider state across sessions.
//   - No app/domain imports here — this file is a thin translation layer over
//     the browser global and is unit-testable by injecting a fake host.

/**
 * One agent-callable tool descriptor in the shape WebMCP expects: a name, a
 * human/LLM-readable description, a JSON-Schema input contract, and an async
 * handler that returns a JSON-serializable result. This mirrors the MCP
 * `tools/call` shape so the same descriptors could back a server-side MCP
 * endpoint later without reshaping.
 */
export interface WebMcpToolDescriptor {
  name: string
  description: string
  /** JSON Schema (draft-07-ish) for the tool's arguments. */
  inputSchema: Record<string, unknown>
  /** Executes the tool. `args` is the validated-by-the-host argument object. */
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

/**
 * The minimal slice of the WebMCP browser surface this shim depends on.
 * Chrome's early preview exposes `navigator.modelContext.registerTool(tool)`
 * returning a handle with `unregister()`. We model exactly that and nothing
 * more so the adapter stays swappable.
 */
export interface WebMcpHost {
  registerTool: (tool: WebMcpRegistrationInput) => WebMcpRegistrationHandle
}

/** The argument shape Chrome's `registerTool` accepts in the early preview. */
export interface WebMcpRegistrationInput {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /**
   * Chrome's preview resolves the handler with `{ arguments }` and expects a
   * `{ content: [...] }` MCP-style result. We adapt our plain async handler to
   * that shape inside `toRegistrationInput` so callers keep returning POJOs.
   */
  execute: (params: { arguments?: Record<string, unknown> }) => Promise<WebMcpToolResult>
}

/** MCP-style tool result envelope. */
export interface WebMcpToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface WebMcpRegistrationHandle {
  unregister: () => void
}

/** Disposer returned by {@link registerTools}; idempotent. */
export type WebMcpDisposer = () => void

/**
 * Feature-detect the WebMCP host on the current `navigator`. Returns the
 * normalized {@link WebMcpHost} when the surface (and the `registerTool`
 * method we need) is present, otherwise `null`. Never throws — a missing
 * global, an SSR context, or a partial/experimental surface all resolve to
 * `null` so the caller can no-op cleanly.
 *
 * `navigatorOverride` is for tests; production passes nothing and we read the
 * real `navigator`.
 */
export function detectWebMcp(navigatorOverride?: unknown): WebMcpHost | null {
  const nav = navigatorOverride ?? (typeof navigator !== 'undefined' ? navigator : undefined)
  if (!nav || typeof nav !== 'object') return null
  const modelContext = (nav as { modelContext?: unknown }).modelContext
  if (!modelContext || typeof modelContext !== 'object') return null
  const registerTool = (modelContext as { registerTool?: unknown }).registerTool
  if (typeof registerTool !== 'function') return null
  return modelContext as unknown as WebMcpHost
}

/** Stringify a tool result into the MCP `{ content: [{ type:'text' }] }` shape. */
function toResultEnvelope(value: unknown, isError = false): WebMcpToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

/** Adapt a plain {@link WebMcpToolDescriptor} into the host's registration input. */
function toRegistrationInput(tool: WebMcpToolDescriptor): WebMcpRegistrationInput {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async ({ arguments: args } = {}) => {
      try {
        const result = await tool.execute(args ?? {})
        return toResultEnvelope(result)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return toResultEnvelope({ error: message }, true)
      }
    },
  }
}

/**
 * Register every descriptor with the host and return a single disposer that
 * unregisters all of them. Registration failures for individual tools are
 * swallowed (best-effort, experimental surface) but logged so a broken host
 * doesn't take down the app shell.
 */
export function registerTools(host: WebMcpHost, tools: WebMcpToolDescriptor[]): WebMcpDisposer {
  const handles: WebMcpRegistrationHandle[] = []
  for (const tool of tools) {
    try {
      handles.push(host.registerTool(toRegistrationInput(tool)))
    } catch (err) {
      // Experimental browser surface — never let a registration error escape.
      if (typeof console !== 'undefined') {
        console.warn(`[webmcp] failed to register tool "${tool.name}"`, err)
      }
    }
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const handle of handles) {
      try {
        handle.unregister()
      } catch {
        /* best-effort teardown */
      }
    }
  }
}
