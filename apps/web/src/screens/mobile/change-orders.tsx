/**
 * Change orders (v2) — mobile screen.
 *
 * Surfaces every change order on a project: a hero showing the running
 * ACCEPTED Δ (the Σ of accepted COs' value_delta — add to the bid for
 * effective contract value), an inline "new change order" composer, and a
 * newest-first list of COs with a square status pill and the next-action
 * buttons the CO's status allows.
 *
 * The screen is a thin renderer over the deterministic change-order
 * workflow: it never invents business states. Status drives both the pill
 * and the available transitions; every transition POSTs through
 * useChangeOrderEvent with the CO's own state_version so a stale row 409s
 * rather than clobbering a concurrent edit. After a successful mutation the
 * hooks invalidate the project query and the fresh snapshot re-renders.
 *
 * Route: mounted under the project shell as `change-orders` (the parent
 * wires it; projectId is read from useParams).
 */
import { useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  MBanner,
  MBody,
  MButton,
  MButtonRow,
  MChip,
  MKpi,
  MInput,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTopBar,
} from '../../components/m/index.js'
import {
  useChangeOrderEvent,
  useCreateChangeOrder,
  useProjectChangeOrders,
  type ChangeOrder,
  type ChangeOrderStatus,
} from '../../lib/api/change-orders.js'
import { formatMoney } from './format.js'

type Tone = 'green' | 'blue' | 'amber' | 'red' | undefined

/**
 * SCHEDULE IMPACT segmented control options (design msg 57). Each maps to
 * the schedule_impact_days the composer posts. NONE = 0, +1-2 DAYS = 2,
 * +1 WEEK = 7. The selected segment is the source of truth for
 * schedule_impact_days — there is no free-text day input.
 */
const SCHEDULE_SEGMENTS: ReadonlyArray<{ label: string; days: number }> = [
  { label: 'None', days: 0 },
  { label: '+1–2 days', days: 2 },
  { label: '+1 week', days: 7 },
]

/** Stepper increment for the value-delta +/- buttons (design msg 57). */
const VALUE_STEP = 250

/** Square status pill tone in the brutalist DRAFT/SENT/ACCEPTED idiom. */
function statusTone(status: ChangeOrderStatus): Tone {
  switch (status) {
    case 'accepted':
      return 'green'
    case 'sent':
      return 'blue'
    case 'draft':
      return 'amber'
    case 'rejected':
    case 'voided':
      return 'red'
  }
}

export function MobileChangeOrders() {
  const navigate = useNavigate()
  const { projectId = '' } = useParams()

  const query = useProjectChangeOrders(projectId)
  const createMutation = useCreateChangeOrder(projectId)
  const eventMutation = useChangeOrderEvent(projectId)

  const [composing, setComposing] = useState(false)
  const [description, setDescription] = useState('')
  const [valueDelta, setValueDelta] = useState('')
  // SCHEDULE IMPACT is a segmented control (design msg 57): the selected
  // segment index drives schedule_impact_days. Default = NONE (0 days).
  const [scheduleSegment, setScheduleSegment] = useState(0)

  const changeOrders = query.data?.change_orders ?? []
  const acceptedDelta = query.data?.accepted_value_delta ?? 0
  // Newest first. created_at is an ISO string; lexical compare is fine, but
  // fall back to the monotonically-increasing CO number for ties.
  const ordered = [...changeOrders].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.number - a.number)

  // Live preview of the value-delta big-number (design msg 57). Empty /
  // non-numeric input previews as $0 so the hero never reads "$NaN".
  const previewDelta = Number.isFinite(Number(valueDelta)) && valueDelta.trim() !== '' ? Number(valueDelta) : 0

  const errorMessage =
    createMutation.error instanceof Error
      ? createMutation.error.message
      : eventMutation.error instanceof Error
        ? eventMutation.error.message
        : null

  function resetComposer() {
    setComposing(false)
    setDescription('')
    setValueDelta('')
    setScheduleSegment(0)
  }

  // +/- stepper: nudge the numeric value-delta by VALUE_STEP, clamping the
  // empty string to 0 first so a fresh composer steps cleanly.
  function stepValue(direction: 1 | -1) {
    const current = Number(valueDelta)
    const base = Number.isFinite(current) ? current : 0
    setValueDelta(String(base + direction * VALUE_STEP))
  }

  function submitCreate() {
    const desc = description.trim()
    if (!desc) return
    const delta = Number(valueDelta)
    if (!Number.isFinite(delta)) return
    const days = SCHEDULE_SEGMENTS[scheduleSegment]?.days ?? 0
    createMutation.mutate(
      {
        description: desc,
        value_delta: delta,
        ...(days > 0 ? { schedule_impact_days: days } : {}),
      },
      { onSuccess: resetComposer },
    )
  }

  function dispatch(co: ChangeOrder, event: 'SEND' | 'ACCEPT' | 'REJECT' | 'VOID') {
    let reason: string | undefined
    if (event === 'REJECT') {
      // Optional rejection note — window.prompt is acceptable for this surface.
      const entered = window.prompt('Rejection reason (optional):') ?? ''
      reason = entered.trim() === '' ? undefined : entered.trim()
    }
    eventMutation.mutate({
      id: co.id,
      event,
      stateVersion: co.state_version,
      ...(reason ? { reason } : {}),
    })
  }

  return (
    <>
      <MTopBar back title="Change orders" onBack={() => navigate(-1)} />
      <MBody>
        {/* Hero — running accepted delta as a big-number KPI. */}
        <div className="m-section-bar">
          <span>Effective contract impact</span>
        </div>
        <div style={{ padding: '0 16px 4px' }}>
          <div style={{ fontFamily: 'var(--m-font-display)' }}>
            <MKpi
              label="ACCEPTED Δ"
              value={formatMoney(acceptedDelta)}
              metaTone={acceptedDelta < 0 ? 'red' : 'green'}
              meta={`${ordered.length} ${ordered.length === 1 ? 'change order' : 'change orders'}`}
            />
          </div>
        </div>

        {errorMessage ? (
          <div style={{ padding: '0 16px 4px' }}>
            <MBanner
              tone="error"
              title="Couldn't save that change"
              body={errorMessage}
              requestId={
                (createMutation.error as { requestId?: string } | null)?.requestId ??
                (eventMutation.error as { requestId?: string } | null)?.requestId ??
                null
              }
            />
          </div>
        ) : null}

        {/* New change order composer. */}
        <MSectionH>New change order</MSectionH>
        <div style={{ padding: '0 16px 8px' }}>
          {composing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Field label="Description *">
                <MInput
                  value={description}
                  onChange={(e) => setDescription(e.currentTarget.value)}
                  placeholder="Add second-floor framing"
                  aria-required="true"
                />
              </Field>
              {/* VALUE DELTA — large green live-preview big-number with a
                  −/+ stepper pair (design msg 57). The raw input stays
                  editable beneath so a precise figure can be typed; the
                  stepper nudges it by VALUE_STEP. */}
              <Field label="Value delta">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontFamily: 'var(--m-font-display)',
                      fontWeight: 800,
                      fontSize: 40,
                      lineHeight: 1,
                      letterSpacing: '-0.02em',
                      color: previewDelta < 0 ? 'var(--m-red)' : 'var(--m-green)',
                    }}
                  >
                    {previewDelta < 0 ? '−' : '+'}
                    {formatMoney(Math.abs(previewDelta))}
                  </div>
                  <MButton size="sm" variant="ghost" aria-label="Decrease value" onClick={() => stepValue(-1)}>
                    −
                  </MButton>
                  <MButton size="sm" variant="primary" aria-label="Increase value" onClick={() => stepValue(1)}>
                    +
                  </MButton>
                </div>
                <div style={{ marginTop: 8 }}>
                  <MInput
                    inputMode="numeric"
                    value={valueDelta}
                    onChange={(e) => setValueDelta(e.currentTarget.value)}
                    placeholder="2500 (negative = credit)"
                  />
                </div>
              </Field>
              {/* SCHEDULE IMPACT — segmented control (design msg 57):
                  NONE / +1–2 DAYS / +1 WEEK, mapped to schedule_impact_days. */}
              <Field label="Schedule impact">
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {SCHEDULE_SEGMENTS.map((seg, i) => (
                    <MChip key={seg.label} active={scheduleSegment === i} onClick={() => setScheduleSegment(i)}>
                      {seg.label}
                    </MChip>
                  ))}
                </div>
              </Field>
              <MButtonRow>
                <MButton
                  variant="primary"
                  onClick={submitCreate}
                  disabled={
                    createMutation.isPending || description.trim() === '' || !Number.isFinite(Number(valueDelta))
                  }
                >
                  {createMutation.isPending ? 'Saving…' : 'Save draft'}
                </MButton>
                <MButton variant="ghost" onClick={resetComposer} disabled={createMutation.isPending}>
                  Cancel
                </MButton>
              </MButtonRow>
            </div>
          ) : (
            <MButton variant="primary" onClick={() => setComposing(true)}>
              + New change order
            </MButton>
          )}
        </div>

        {/* List of change orders, newest first. */}
        <MSectionH>Log</MSectionH>
        {ordered.length === 0 ? (
          <div
            style={{
              padding: '40px 24px',
              textAlign: 'center',
              color: 'var(--m-ink-3)',
              fontFamily: 'var(--m-num)',
              fontSize: 12,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            No change orders yet.
          </div>
        ) : (
          <MListInset>
            {ordered.map((co) => (
              <CoRow
                key={co.id}
                co={co}
                busy={eventMutation.isPending}
                onEvent={(ev) => dispatch(co, ev)}
                onOpen={() => navigate(`/projects/${projectId}/change-orders/${co.id}`)}
              />
            ))}
          </MListInset>
        )}
      </MBody>
    </>
  )
}

function CoRow({
  co,
  busy,
  onEvent,
  onOpen,
}: {
  co: ChangeOrder
  busy: boolean
  onEvent: (event: 'SEND' | 'ACCEPT' | 'REJECT' | 'VOID') => void
  onOpen: () => void
}) {
  const positive = co.value_delta >= 0
  const coLabel = `CO-${String(co.number).padStart(4, '0')}`

  const headline = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontFamily: 'var(--m-num)', letterSpacing: '0.04em' }}>{coLabel}</span>
      <MPill tone={statusTone(co.status)}>{co.status.toUpperCase()}</MPill>
    </div>
  )

  const supporting = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ textTransform: 'none', letterSpacing: 0 }}>{co.description}</span>
      <span
        style={{
          fontFamily: 'var(--m-num)',
          fontWeight: 700,
          color: positive ? 'var(--m-green, #1a7f37)' : 'var(--m-red, #cf222e)',
        }}
      >
        {positive ? '+' : '−'}
        {formatMoney(Math.abs(co.value_delta))}
        {co.schedule_impact_days ? ` · ${co.schedule_impact_days > 0 ? '+' : ''}${co.schedule_impact_days}d` : ''}
      </span>
      <MButtonRow>
        <MButton size="sm" variant="ghost" onClick={onOpen}>
          Open
        </MButton>
      </MButtonRow>
      <CoActions status={co.status} busy={busy} onEvent={onEvent} />
    </div>
  )

  return <MListRow headline={headline} supporting={supporting} />
}

function CoActions({
  status,
  busy,
  onEvent,
}: {
  status: ChangeOrderStatus
  busy: boolean
  onEvent: (event: 'SEND' | 'ACCEPT' | 'REJECT' | 'VOID') => void
}) {
  if (status === 'draft') {
    return (
      <MButtonRow>
        <MButton size="sm" variant="primary" disabled={busy} onClick={() => onEvent('SEND')}>
          Send
        </MButton>
        <MButton size="sm" variant="ghost" disabled={busy} onClick={() => onEvent('VOID')}>
          Void
        </MButton>
      </MButtonRow>
    )
  }
  if (status === 'sent') {
    return (
      <MButtonRow>
        <MButton size="sm" variant="primary" disabled={busy} onClick={() => onEvent('ACCEPT')}>
          Mark accepted
        </MButton>
        <MButton size="sm" variant="ghost" disabled={busy} onClick={() => onEvent('REJECT')}>
          Mark rejected
        </MButton>
        <MButton size="sm" variant="ghost" disabled={busy} onClick={() => onEvent('VOID')}>
          Void
        </MButton>
      </MButtonRow>
    )
  }
  // accepted / rejected / voided are terminal — no further actions.
  return null
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span className="m-field-l">{label}</span>
      {children}
    </label>
  )
}
