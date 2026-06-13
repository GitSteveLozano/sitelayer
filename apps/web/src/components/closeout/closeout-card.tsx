import { MBanner, MButton, MPill } from '../m/index.js'
import { shortDate } from '../../screens/mobile/format.js'
import type { ProjectCloseoutViewModel } from '../../machines/project-closeout.js'

/**
 * Shared presentational project-closeout card.
 *
 * Renders the Budget-tab brutalist closeout card design (header pill +
 * body + primary button) purely from a `ProjectCloseoutViewModel` — the
 * same view-model the Overview-tab CloseoutBanner consumes via
 * `useProjectCloseoutMachine`. It owns NO business state and NO 409
 * derivation: loading/submitting/outOfSync/error all come straight off
 * the machine, and actions are dispatched by `next_events[].type`. This
 * is the single renderer that replaces the Budget tab's hand-rolled
 * TanStack-Query + ApiError/409 path.
 *
 * `onOpenPostMortem` is an optional affordance shown in the terminal
 * states so the closed card can deep-link to the post-mortem surface.
 */
export function CloseoutCard({
  closeout,
  onOpenPostMortem,
}: {
  closeout: ProjectCloseoutViewModel
  onOpenPostMortem?: () => void
}) {
  const snapshot = closeout.snapshot

  // Loading (no snapshot yet) — match the Budget tab's soft loading tile.
  if (closeout.isLoading && !snapshot) {
    return (
      <div style={{ padding: '0 16px 16px' }}>
        <div
          style={{
            padding: 14,
            fontSize: 12,
            color: 'var(--m-ink-3)',
            border: '2px solid var(--m-ink)',
            background: 'var(--m-card-soft)',
          }}
        >
          Loading closeout…
        </div>
      </div>
    )
  }

  // Failed load (no snapshot + error).
  if (!snapshot) {
    return (
      <div style={{ padding: '0 16px 16px' }}>
        <MBanner tone="error" title="Could not load closeout" body="Reload the project to try again." />
      </div>
    )
  }

  const closeoutEvent = snapshot.next_events.find((ev) => ev.type === 'CLOSEOUT')
  const isTerminal = snapshot.state === 'completed' || snapshot.state === 'post_mortem'
  const errorMsg = closeout.error && !closeout.outOfSync ? closeout.error : null

  return (
    <div style={{ padding: '0 16px 16px' }}>
      <div
        style={{
          border: '2px solid var(--m-ink)',
          overflow: 'hidden',
          background: 'var(--m-card)',
        }}
      >
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--m-line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
            }}
          >
            Closeout
          </span>
          {isTerminal ? <MPill tone="green">Closed out</MPill> : <MPill tone="blue">Active</MPill>}
        </div>

        <div style={{ padding: '12px 14px' }}>
          {isTerminal ? (
            <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.5 }}>
              Closed out{snapshot.context.closed_at ? ` on ${shortDate(snapshot.context.closed_at)}` : ''}. The closeout
              summary above is locked.
              {onOpenPostMortem ? (
                <div style={{ marginTop: 12 }}>
                  <MButton variant="ghost" onClick={onOpenPostMortem}>
                    Open post-mortem
                  </MButton>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.5, marginBottom: 12 }}>
                Marks the project complete and locks the closeout summary. This can't be undone.
              </div>
              {closeout.outOfSync ? (
                <div style={{ marginBottom: 12 }}>
                  <MBanner
                    tone="warn"
                    title="Project state moved"
                    body="Reloaded the latest state — check it before closing out again."
                  />
                </div>
              ) : null}
              {errorMsg ? (
                <div style={{ marginBottom: 12 }}>
                  <MBanner tone="error" title="Closeout failed" body={errorMsg} />
                </div>
              ) : null}
              <MButton
                variant="primary"
                disabled={!closeoutEvent || closeout.isSubmitting || Boolean(closeoutEvent?.disabled_reason)}
                title={closeoutEvent?.disabled_reason ?? undefined}
                onClick={() => closeoutEvent && closeout.dispatch(closeoutEvent.type)}
              >
                {closeout.isSubmitting ? 'Closing out…' : (closeoutEvent?.label ?? 'Close out project')}
              </MButton>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
