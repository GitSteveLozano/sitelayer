import type { ArtifactUploader, CaptureConsentScope, SiteAdapter, Unsubscribe } from '@operator/capture-overlay'
import { getProjectSignal } from './project-signal'

// sitelayer's implementation of the @operator/capture-overlay SiteAdapter
// contract. This is the per-site adapter (the only genuinely site-shaped layer):
//   - signal      -> the projectkit /api/signal emitter (server-side HMAC sink)
//   - eventStream -> taps a provided XState actor (the dock supplies its machine,
//                    e.g. apps/web/src/machines/*.subscribe), so capture marks
//                    correlate to real app state
//   - uploadArtifact / consent -> sitelayer's own storage + consent authority
//
// The overlay itself imports none of this; routing (kanban / linear / agent) is
// a swap of the sink inside `signal`, never a change here.

export interface SitelayerSiteAdapterDeps {
  /** Upload a captured media blob via sitelayer's multipart artifact path. */
  uploadArtifact: ArtifactUploader
  /** Subscribe to a site event/transition stream (an XState actor's subscribe). */
  subscribe?: (onEvent: (event: unknown) => void) => Unsubscribe
  /** The capture consent scope for this session (sitelayer's consent authority). */
  consent: () => CaptureConsentScope
}

export function createSitelayerSiteAdapter(deps: SitelayerSiteAdapterDeps): SiteAdapter {
  return {
    projectKey: 'sitelayer',
    signal: getProjectSignal(),
    uploadArtifact: deps.uploadArtifact,
    consent: deps.consent,
    eventStream: (onEvent) => (deps.subscribe ? deps.subscribe(onEvent) : () => undefined),
  }
}
