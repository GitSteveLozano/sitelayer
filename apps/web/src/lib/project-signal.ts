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
    sink: url ? new HttpSink({ url, timeoutMs: 4000 }) : new NullSink(),
    defaults: {
      environment: env?.MODE ?? 'unknown',
      ...(env?.VITE_BUILD_SHA ? { build_sha: env.VITE_BUILD_SHA } : {}),
      source_surface: 'web',
    },
    onError: () => {},
  })
  return signal
}
