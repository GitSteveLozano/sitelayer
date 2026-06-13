import { MPill, type MTone } from '@/components/m'
import { getActiveCompanySlug } from '@/lib/api/client'
import { useControlPlaneProbePublish } from '@/lib/control-plane-probe-pub'
import { useProjectLifecycle } from '@/machines/project-lifecycle'

const LIFECYCLE_STATE_LABEL: Record<string, { label: string; tone: MTone | undefined }> = {
  draft: { label: 'Drafting', tone: undefined },
  estimating: { label: 'Estimating', tone: undefined },
  sent: { label: 'Sent to client', tone: 'blue' },
  accepted: { label: 'Accepted', tone: 'green' },
  declined: { label: 'Declined', tone: 'red' },
  in_progress: { label: 'In progress', tone: 'green' },
  done: { label: 'Done', tone: 'green' },
  archived: { label: 'Archived', tone: undefined },
}

/**
 * Project-lifecycle workflow banner. Renders server-truth `state` +
 * server-supplied `next_events` from the `project-lifecycle`
 * workflow (see `docs/DETERMINISTIC_WORKFLOWS.md`). UI state
 * (loading/submitting/outOfSync/error) is wrapped by the headless
 * `useProjectLifecycle` XState machine — this component is a thin
 * renderer. 409s land in the outOfSync banner without losing the
 * click.
 */
export function LifecycleBanner({ projectId }: { projectId: string }) {
  const companySlug = getActiveCompanySlug()
  const lifecycle = useProjectLifecycle(projectId, companySlug)

  // Publish the lifecycle state into the control-plane probe so the
  // browser-bridge capture modal can fold it into `page_state.project_state`.
  // See `apps/web/src/lib/control-plane-probe-pub.ts`.
  useControlPlaneProbePublish('projectState', lifecycle.snapshot?.state ?? null)

  if (lifecycle.isLoading && !lifecycle.snapshot) {
    return null
  }
  const snap = lifecycle.snapshot
  if (!snap) {
    return null
  }
  const label = LIFECYCLE_STATE_LABEL[snap.state] ?? { label: snap.state, tone: undefined }
  const showOutOfSync = lifecycle.outOfSync
  const errorMessage = lifecycle.error

  return (
    <div className="m-card" data-testid="lifecycle-banner">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Lifecycle</span>
          <MPill tone={label.tone}>{label.label}</MPill>
        </div>
        <span className="text-[11px] text-ink-3 num">v{snap.state_version}</span>
      </div>
      {showOutOfSync ? (
        <div className="text-[12px] text-warn mb-2">
          Workflow state moved on the server. Reloaded — pick the next action again.
        </div>
      ) : null}
      {errorMessage && !showOutOfSync ? (
        <div className="text-[12px] text-bad mb-2 flex items-center gap-2">
          <span>{errorMessage}</span>
          <button type="button" onClick={lifecycle.dismissError} className="text-[11px] text-ink-3 underline">
            dismiss
          </button>
        </div>
      ) : null}
      {snap.next_events.length === 0 ? (
        <div className="text-[12px] text-ink-3">No further actions — workflow is in a terminal state.</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {snap.next_events.map((evt) => (
            <button
              key={evt.type}
              type="button"
              onClick={() => lifecycle.dispatch({ type: evt.type })}
              disabled={lifecycle.isSubmitting || Boolean(evt.disabled_reason)}
              title={evt.disabled_reason ?? undefined}
              className="px-3 py-1.5 border border-line text-[12px] font-semibold text-ink bg-card-soft disabled:opacity-50 hover:bg-card"
            >
              {evt.label}
            </button>
          ))}
        </div>
      )}
      {/* The Attribution endpoint-string footer was dropped here per the
          2026-06-12 design-fidelity audit (medium finding: "lifecycle/banner
          printing API endpoints into the Overview tab" — debug noise on a
          customer surface; the mobile overview removed the whole banner for
          the same reason). The advance-pipeline affordance above is the
          banner's actual job. */}
    </div>
  )
}
