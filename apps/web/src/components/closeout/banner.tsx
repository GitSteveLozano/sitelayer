import { MPill, type MTone } from '@/components/m'
import { Attribution } from '@/components/ai'
import { getActiveCompanySlug } from '@/lib/api/client'
import { useProjectCloseoutMachine } from '@/machines/project-closeout'

const CLOSEOUT_STATE_LABEL: Record<string, { label: string; tone: MTone | undefined }> = {
  active: { label: 'Active', tone: undefined },
  completed: { label: 'Closed', tone: 'green' },
}

/**
 * Project-closeout workflow banner. Renders server-truth `state` +
 * server-supplied `next_events` from the `project-closeout` workflow
 * (see `packages/workflows/src/project-closeout.ts`). UI state
 * (loading/submitting/outOfSync/error) is wrapped by the headless
 * `useProjectCloseoutMachine` XState machine — this component is a
 * thin renderer, identical in shape to `LifecycleBanner`. 409s land
 * in the outOfSync banner without losing the click.
 *
 * Hides on `active` state with no pending next_events so early-stage
 * projects don't carry an extra empty card on the Overview tab; the
 * affordance only surfaces once the workflow has actions to offer
 * (closeout pending) or has reached a terminal state (closed).
 */
export function CloseoutBanner({ projectId }: { projectId: string }) {
  const companySlug = getActiveCompanySlug()
  const closeout = useProjectCloseoutMachine(projectId, companySlug)

  if (closeout.isLoading && !closeout.snapshot) {
    return null
  }
  const snap = closeout.snapshot
  if (!snap) {
    return null
  }
  // Hide on active state with no pending events — adds noise to projects
  // that haven't hit closeout yet.
  if (snap.state === 'active' && snap.next_events.length === 0) {
    return null
  }
  const label = CLOSEOUT_STATE_LABEL[snap.state] ?? { label: snap.state, tone: undefined }
  const showOutOfSync = closeout.outOfSync
  const errorMessage = closeout.error

  return (
    <div className="m-card">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Closeout</span>
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
          <button type="button" onClick={closeout.dismissError} className="text-[11px] text-ink-3 underline">
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
              onClick={() => closeout.dispatch(evt.type)}
              disabled={closeout.isSubmitting || Boolean(evt.disabled_reason)}
              title={evt.disabled_reason ?? undefined}
              className="px-3 py-1.5 border border-line text-[12px] font-semibold text-ink bg-card-soft disabled:opacity-50 hover:bg-card"
            >
              {evt.label}
            </button>
          ))}
        </div>
      )}
      <Attribution source="GET /api/projects/:id/closeout · POST /:id/closeout (project-closeout workflow + XState machine)" />
    </div>
  )
}
