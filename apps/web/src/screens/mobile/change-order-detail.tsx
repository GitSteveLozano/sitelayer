/**
 * Change order detail (v2) — mobile per-CO screen.
 *
 * The dedicated per-change-order surface Steve's v2 design calls for
 * (CHANGE ORDER · SENT / ACCEPTED detail, msg 58/59): an accent value
 * hero, the lifecycle state strip, terminal stamps, and the actions the
 * CO's current state allows.
 *
 * This is a thin renderer over the deterministic change-order workflow.
 * It NEVER invents business state — it loads the canonical headless
 * snapshot (`GET /api/change-orders/:id` → { state, state_version,
 * context, next_events }) through the `useChangeOrder` XState machine and
 * renders `state` / `context` / `next_events` straight from the server.
 * Actions are rendered from `next_events` (the reducer's allowed events,
 * with labels) and dispatched through the machine, which carries the
 * 409 → reload → outOfSync handling.
 *
 * Route: `/projects/:projectId/change-orders/:coId` (mounted in App.tsx
 * beside the list route).
 */
import { useNavigate, useParams } from 'react-router-dom'
import { CHANGE_ORDER_ALL_STATES } from '@sitelayer/workflows'
import { MBanner, MBody, MButton, MButtonRow, MPill, MSectionH, MTopBar } from '../../components/m/index.js'
import { useChangeOrder } from '../../machines/change-order.js'
import type { ChangeOrderSnapshot } from '../../lib/api/change-orders.js'
import { formatMoney, shortDate, statusTone } from './format.js'

/** Lifecycle state strip — derived from CHANGE_ORDER_ALL_STATES so it can
 * never drift from the reducer's state set (shared rule with the desktop
 * ChangeOrderDrawer strip). Highlights the persisted business state. */
function CoLifecycleStrip({ status }: { status: string }) {
  return (
    <div style={{ display: 'flex', border: '2px solid var(--m-ink)' }}>
      {CHANGE_ORDER_ALL_STATES.map((state, i, arr) => {
        const current = state === status
        return (
          <div
            key={state}
            style={{
              flex: 1,
              padding: '8px 0',
              textAlign: 'center',
              fontFamily: 'var(--m-num)',
              background: current ? 'var(--m-accent)' : 'transparent',
              color: current ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
              borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
              fontSize: 8,
              fontWeight: 800,
              letterSpacing: '0.04em',
            }}
          >
            {state.toUpperCase()}
          </div>
        )
      })}
    </div>
  )
}

/** The accent value hero — big-number delta, schedule impact, per-state
 * stamp/copy derived from the snapshot. */
function CoHero({ snapshot }: { snapshot: ChangeOrderSnapshot }) {
  const co = snapshot.context
  const delta = Number(co.value_delta)
  const positive = delta >= 0
  const days = co.schedule_impact_days != null ? Number(co.schedule_impact_days) : null

  let stateLine: string
  switch (snapshot.state) {
    case 'sent':
      stateLine = co.sent_at ? `AWAITING CLIENT · SENT ${shortDate(co.sent_at)}` : 'AWAITING CLIENT'
      break
    case 'accepted':
      stateLine = co.accepted_at ? `ACCEPTED ${shortDate(co.accepted_at)}` : 'ACCEPTED'
      break
    case 'rejected':
      stateLine = co.rejected_at ? `REJECTED ${shortDate(co.rejected_at)}` : 'REJECTED'
      break
    case 'voided':
      stateLine = co.voided_at ? `VOIDED ${shortDate(co.voided_at)}` : 'VOIDED'
      break
    default:
      stateLine = 'DRAFT'
  }

  return (
    <div style={{ padding: '0 16px 4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ fontFamily: 'var(--m-num)', letterSpacing: '0.04em', fontWeight: 700 }}>
          CO-{String(co.number).padStart(4, '0')}
        </span>
        <MPill tone={statusTone(snapshot.state)}>{snapshot.state.toUpperCase()}</MPill>
      </div>
      <div
        style={{
          fontFamily: 'var(--m-font-display)',
          fontWeight: 800,
          fontSize: 44,
          lineHeight: 1.05,
          color: positive ? 'var(--m-green)' : 'var(--m-red)',
        }}
      >
        {positive ? '+' : '−'}
        {formatMoney(Math.abs(delta))}
      </div>
      <div
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 10,
          color: 'var(--m-ink-3)',
          marginTop: 4,
          fontWeight: 600,
          letterSpacing: '0.04em',
        }}
      >
        {stateLine}
        {days != null && days !== 0 ? ` · ${days > 0 ? '+' : ''}${days}D SCHEDULE` : ''}
      </div>
    </div>
  )
}

export function MobileChangeOrderDetail() {
  const navigate = useNavigate()
  const { coId = '' } = useParams()
  const { snapshot, dispatch, dismissError, isLoading, isSubmitting, outOfSync, error } = useChangeOrder(coId)

  function onAction(event: 'SEND' | 'ACCEPT' | 'REJECT' | 'VOID') {
    let reason: string | undefined
    if (event === 'REJECT') {
      const entered = window.prompt('Rejection reason (optional):') ?? ''
      reason = entered.trim() === '' ? undefined : entered.trim()
    }
    dispatch({ event, ...(reason ? { reason } : {}) })
  }

  const co = snapshot?.context

  return (
    <>
      <MTopBar back title="Change order" onBack={() => navigate(-1)} />
      <MBody>
        {error ? (
          <div style={{ padding: '8px 16px 0' }}>
            <MBanner
              tone={outOfSync ? 'warn' : 'error'}
              title={outOfSync ? 'This change order changed on the server' : "Couldn't save that change"}
              body={outOfSync ? 'It was reloaded to the latest state — review before acting again.' : error}
              action={
                <MButton size="sm" variant="ghost" onClick={dismissError}>
                  Dismiss
                </MButton>
              }
            />
          </div>
        ) : null}

        {isLoading && !snapshot ? (
          <div
            style={{
              padding: '40px 24px',
              textAlign: 'center',
              color: 'var(--m-ink-3)',
              fontFamily: 'var(--m-num)',
              fontSize: 12,
              letterSpacing: '0.06em',
            }}
          >
            Loading change order…
          </div>
        ) : !snapshot || !co ? (
          <div
            style={{
              padding: '40px 24px',
              textAlign: 'center',
              color: 'var(--m-ink-3)',
              fontFamily: 'var(--m-num)',
              fontSize: 12,
              letterSpacing: '0.06em',
            }}
          >
            Change order not found.
          </div>
        ) : (
          <>
            <CoHero snapshot={snapshot} />

            <MSectionH>What changed</MSectionH>
            <div style={{ padding: '0 16px 8px' }}>
              <div
                style={{
                  padding: 14,
                  border: '2px solid var(--m-ink)',
                  background: 'var(--m-card-soft)',
                  minHeight: 64,
                  fontSize: 14,
                  lineHeight: 1.5,
                }}
              >
                {co.description}
              </div>
            </div>

            {co.reject_reason && snapshot.state === 'rejected' ? (
              <>
                <MSectionH>Rejection reason</MSectionH>
                <div style={{ padding: '0 16px 8px', fontSize: 14, lineHeight: 1.5 }}>{co.reject_reason}</div>
              </>
            ) : null}

            <MSectionH>Lifecycle</MSectionH>
            <div style={{ padding: '0 16px 8px' }}>
              <CoLifecycleStrip status={snapshot.state} />
            </div>

            <div style={{ padding: '4px 16px 16px' }}>
              {snapshot.next_events.length > 0 ? (
                <MButtonRow>
                  {snapshot.next_events.map((ev, i) => (
                    <MButton
                      key={ev.type}
                      size="sm"
                      variant={i === 0 ? 'primary' : 'ghost'}
                      disabled={isSubmitting || isLoading}
                      onClick={() => onAction(ev.type)}
                    >
                      {ev.label}
                    </MButton>
                  ))}
                </MButtonRow>
              ) : (
                <div
                  style={{
                    fontFamily: 'var(--m-num)',
                    fontSize: 11,
                    color: 'var(--m-ink-3)',
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                  }}
                >
                  No further actions · {snapshot.state.toUpperCase()}
                  {snapshot.state === 'accepted' && co.approved_by ? ` · BY ${co.approved_by}` : ''}
                </div>
              )}
            </div>
          </>
        )}
      </MBody>
    </>
  )
}
