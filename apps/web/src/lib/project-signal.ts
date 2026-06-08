import { createProjectSignal, HttpSink, NullSink, type ProjectSignal } from '@operator/projectkit'

// Web-side @operator/projectkit emitter for sitelayer. Mirrors the nhl/winwar
// testbed pattern: the browser posts a ProjectEvent / WorkRequest envelope to
// the SAME-ORIGIN relay (apps/api/src/routes/signal.ts, POST /api/signal), which
// holds the mesh HMAC secret server-side, signs the same bytes, and forwards to
// the configured sink. The browser never sees the sink URL or the secret.
//
// Inert by default: when the server-side SIGNAL_SINK_URL is unset the relay
// 204s and capture is simply OFF — the app keeps working. mesh is just ONE
// possible subscriber; the relay's forward target (kanban / linear / mesh /
// agent dispatch) is a server-side config swap, never a dependency of this app.
// This is the composable, opt-in routing the contract is built for.

type ImportMetaEnvShape = {
  env?: {
    MODE?: string
    VITE_BUILD_SHA?: string
    /** Explicit '' disables capture (NullSink); unset → same-origin relay. */
    VITE_SIGNAL_SINK_URL?: string
  }
}

const PROJECT_KEY = 'sitelayer'
const DEFAULT_SIGNAL_SINK_URL = '/api/signal'

let signal: ProjectSignal | null = null

export function getProjectSignal(): ProjectSignal {
  if (signal) return signal
  const env = (import.meta as ImportMetaEnvShape).env
  const override = env?.VITE_SIGNAL_SINK_URL?.trim()
  const url = override === undefined ? DEFAULT_SIGNAL_SINK_URL : override
  signal = createProjectSignal({
    projectKey: PROJECT_KEY,
    // fetchImpl MUST be bound to the global scope. projectkit's HttpSink stores
    // the impl as an instance field and calls `this.fetchImpl(...)`, which sets
    // `this` to the HttpSink instance — and the browser's native `fetch` throws
    // "Failed to execute 'fetch' on 'Window': Illegal invocation" unless `this`
    // is the Window. (Node's fetch tolerates any `this`, which is why the
    // server-side relay worked while every browser capture silently failed.)
    // A *bound* fn ignores the call-site `this`, so this app-local fix works
    // even against an un-republished projectkit dist. See chess commit 708f751.
    sink: url ? new HttpSink({ url, timeoutMs: 4000, fetchImpl: globalThis.fetch.bind(globalThis) }) : new NullSink(),
    defaults: {
      environment: env?.MODE ?? 'unknown',
      ...(env?.VITE_BUILD_SHA ? { build_sha: env.VITE_BUILD_SHA } : {}),
      source_surface: 'web',
    },
    // Surface delivery failures instead of swallowing them — a silent onError
    // (plus the capture dock's fire-and-forget catch) is exactly what hid the
    // Illegal-invocation bug above.
    onError: (result) => {
      console.warn('[sitelayer] capture signal delivery failed', result)
    },
  })
  return signal
}
