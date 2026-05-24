import { useEffect, useMemo } from 'react'
import type { ControlPlaneCapture } from '@operator/types'
import { Sentry } from '@/instrument'
import { readActiveControlPlaneTrace, readControlPlaneTraceCapabilitiesWhenActive } from '@/lib/control-plane-trace'
import { readProbePublishRegistry } from '@/lib/control-plane-probe-pub'

/**
 * Operator-owned probe contract — type now lives in `@operator/types`
 * (shared across chess, nhl, winwar, sitelayer, learn, qedviz, sandolab,
 * console-ui). Re-exported here so existing imports of
 * `ControlPlaneCapture` from this module keep working without a sweep.
 *
 * See:
 *   ~/projects/digital-ontology/tab-to-task-current-state-2026-05-22.md §1.6
 *   ~/projects/digital-ontology/tab-to-task-implementation-plan-2026-05-22.md §2.3
 */
export type { ControlPlaneCapture }

declare global {
  interface Window {
    __controlPlaneProbe?: {
      capture: () => ControlPlaneCapture
      version: string
    }
  }
}

const PROBE_VERSION = 'sitelayer-1.0.0'

function readSentryTrace(): { trace_id?: string; span_id?: string; sentry_trace?: string } | null {
  try {
    const data = Sentry.getTraceData?.()
    const sentryTrace = (data as Record<string, string | undefined> | undefined)?.['sentry-trace']
    if (!sentryTrace) return null
    const parts = sentryTrace.split('-')
    const trace: { trace_id?: string; span_id?: string; sentry_trace: string } = { sentry_trace: sentryTrace }
    if (parts[0]) trace.trace_id = parts[0]
    if (parts[1]) trace.span_id = parts[1]
    return trace
  } catch {
    return null
  }
}

type SitelayerProbeInput = {
  companySlug: string | null
  projectId: string | null
  currentTab: string | null
  userRole: string | null
  activeProjectName: string | null
  /**
   * Optional snapshot from the project-lifecycle xstate machine. Pass `null`
   * unless the caller already has the snapshot in scope — the probe should
   * never instantiate a per-project hook itself.
   *
   * As of slice 1.1 these three fields are also published by their owning
   * route screens via `useControlPlaneProbePublish()` (see
   * `apps/web/src/lib/control-plane-probe-pub.ts`). The prop path is kept
   * as a fallback so callers that already pass a value continue to work;
   * if both a prop and a registry entry are present, the registry wins
   * (it's published from the screen that actually owns the machine).
   */
  projectState?: string | null
  timeReviewState?: string | null
  billingReviewState?: string | null
}

/**
 * Headless probe component. Mount once near the top of the authenticated
 * workspace tree and pass props gathered from the same scope that already
 * has them (company, route, lifecycle snapshot). The component installs
 * `window.__controlPlaneProbe = { capture, version }` and removes it on
 * unmount, but only if the version still matches, so a newer probe
 * version that overwrote ours during HMR or A/B rollout is not clobbered.
 */
export function ControlPlaneProbe(input: SitelayerProbeInput) {
  const seed = useMemo<ControlPlaneCapture>(() => {
    const entityKind = input.projectId ? 'project' : 'company'
    const entityId = input.projectId ?? input.companySlug ?? null
    return {
      path: {
        entity_kind: entityKind,
        entity_id: entityId,
        company_slug: input.companySlug,
        project_id: input.projectId,
        current_tab: input.currentTab,
      },
      page_state: {
        user_role: input.userRole,
        active_project_name: input.activeProjectName,
        project_state: input.projectState ?? null,
        time_review_state: input.timeReviewState ?? null,
        billing_review_state: input.billingReviewState ?? null,
      },
    }
  }, [
    input.companySlug,
    input.projectId,
    input.currentTab,
    input.userRole,
    input.activeProjectName,
    input.projectState,
    input.timeReviewState,
    input.billingReviewState,
  ])

  useEffect(() => {
    const buildSha = import.meta.env.VITE_BUILD_SHA as string | undefined
    const env = (import.meta.env.MODE as string | undefined) ?? 'unknown'
    window.__controlPlaneProbe = {
      capture: () => {
        // Read the publish registry fresh on every capture so that route
        // screens publishing via `useControlPlaneProbePublish()` get their
        // latest snapshot folded into `page_state`. Registry wins over the
        // matching prop fallbacks — the prop is only consulted if no
        // route screen is publishing the key.
        const published = readProbePublishRegistry()
        const activeTrace = readActiveControlPlaneTrace()
        const sentryTrace = readSentryTrace()
        return {
          ...seed,
          trace: activeTrace ?? sentryTrace,
          page_state: {
            ...(seed.page_state ?? {}),
            ...(Object.prototype.hasOwnProperty.call(published, 'projectState')
              ? { project_state: published.projectState }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(published, 'timeReviewState')
              ? { time_review_state: published.timeReviewState }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(published, 'billingReviewState')
              ? { billing_review_state: published.billingReviewState }
              : {}),
            operator_trace: {
              active: Boolean(activeTrace),
              capabilities: readControlPlaneTraceCapabilitiesWhenActive(),
            },
            sentry_trace: sentryTrace,
          },
          deploy: buildSha ? { build_sha: buildSha, env } : null,
        }
      },
      version: PROBE_VERSION,
    }
    return () => {
      if (window.__controlPlaneProbe?.version === PROBE_VERSION) {
        delete window.__controlPlaneProbe
      }
    }
  }, [seed])

  return null
}
