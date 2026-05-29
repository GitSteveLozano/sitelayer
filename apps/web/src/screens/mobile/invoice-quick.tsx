/**
 * Quick invoice — `mb-invoice-quick`. Mobile companion for the desktop
 * invoice flow. Picks a project and snapshots its current estimate into the
 * real `estimate_push` workflow (project → QuickBooks estimate/invoice;
 * `apps/api/src/routes/estimate-pushes.ts`). On send it creates the push and
 * hands off to the `invoice-sent` timeline (`/invoice-sent/:projectId`),
 * passing the freshly-created push id + subtotal through navigation state so
 * the timeline renders the live `WorkflowSnapshot`.
 *
 * Workflow mapping (see WIRING REPORT): the mobile "invoice" is the
 * estimate_push workflow, NOT rental_billing_runs. rental_billing_runs are
 * created off a rental contract (`/api/rental-contracts/:id/billing-runs`)
 * and have no "create from an arbitrary project" entry; estimate_pushes do
 * (`POST /api/projects/:id/estimate-pushes`), which is exactly what this
 * screen does.
 *
 * The CONTRACT VALUE block reads the project's real `bid_total`. The
 * MILESTONES ladder (deposit / progress / final) is now backed by the real
 * `project_billing_milestones` table (migration 104 +
 * apps/api/src/routes/project-billing-milestones.ts → useBillingMilestones /
 * useCreateBillingMilestones). It loads the project's persisted milestones
 * and, when a project has none yet, offers a one-tap "Seed ladder" that
 * derives a deposit/progress/final set from bid_total. Sending the invoice
 * seeds the ladder (if empty) before snapshotting the estimate into the
 * estimate_push workflow — milestones are an additive tracking layer ALONGSIDE
 * the QBO push, not a replacement for it.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, useCreateEstimatePush, type BootstrapResponse } from '@/lib/api'
import {
  useBillingMilestones,
  useCreateBillingMilestones,
  type BillingMilestone,
  type BillingMilestoneStatus,
} from '@/lib/api/billing-milestones'
import { MBanner, MBody, MButton, MButtonStack, MInput, MTextarea, MTopBar } from '../../components/m/index.js'
import { formatMoney } from './format.js'

function milestoneStatusLabel(status: BillingMilestoneStatus): string {
  if (status === 'paid') return '✓ PAID'
  if (status === 'invoiced') return '● INVOICED · NOT PAID'
  return '○ NOT YET INVOICED'
}

// The "active" milestone (the one currently being billed) is the first that
// isn't already paid — purely a display accent, mirroring V2InvoiceCreate.
function activeMilestoneId(milestones: BillingMilestone[]): string | null {
  return milestones.find((m) => m.status !== 'paid')?.id ?? null
}

export function MobileQuickInvoice({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const projects = bootstrap?.projects ?? []
  const [projectId, setProjectId] = useState<string>(() => projects[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const createPush = useCreateEstimatePush()
  const createMilestones = useCreateBillingMilestones(projectId)

  const project = projects.find((p) => p.id === projectId)
  const contractValue = Number(project?.bid_total ?? 0)

  // Real persisted milestones for the selected project (ladder order).
  const milestonesQuery = useBillingMilestones(projectId || null)
  const milestones = milestonesQuery.data?.billing_milestones ?? []
  const activeId = activeMilestoneId(milestones)
  const hasMilestones = milestones.length > 0

  // One-tap: seed a deposit/progress/final ladder derived from bid_total.
  const seedLadder = () => {
    if (!project || createMilestones.isPending) return
    setErrorMessage(null)
    createMilestones.mutate(
      { contract_value: contractValue },
      {
        onError: (err) => setErrorMessage(err instanceof Error ? err.message : 'Failed to seed milestones.'),
      },
    )
  }

  // Snapshot the selected project's estimate into the real estimate_push
  // workflow, then hop to the sent timeline. The push id rides through
  // navigation state so invoice-sent can load the snapshot in one hop; the
  // sent screen also falls back to looking the project's push up by list.
  // If the project has no milestones yet, seed the default ladder first so
  // the sent timeline has a real schedule to track against (best-effort:
  // a seed failure does not block the QBO push, which is the load-bearing
  // action).
  const send = () => {
    if (!project || createPush.isPending) return
    setErrorMessage(null)
    if (!hasMilestones && !createMilestones.isPending) {
      createMilestones.mutate({ contract_value: contractValue })
    }
    createPush.mutate(
      { projectId: project.id },
      {
        onSuccess: (result) => {
          if (result.kind === 'created') {
            navigate(`/invoice-sent/${project.id}`, {
              state: { pushId: result.pushId, amount, memo },
            })
            return
          }
          // 409 — an open (non-terminal) push already exists for this
          // project. Hop to it instead of dead-ending.
          navigate(`/invoice-sent/${project.id}`, {
            state: { pushId: result.openId, amount, memo },
          })
        },
        onError: (err) => {
          // The most common real failure is 400 "project has no
          // estimate_lines" — the project hasn't had its estimate computed
          // yet. Surface it as guidance rather than a raw error.
          if (err instanceof ApiError && err.status === 400) {
            setErrorMessage(
              'This project has no estimate lines yet. Build/recompute the estimate before invoicing.',
            )
            return
          }
          setErrorMessage(err instanceof Error ? err.message : 'Failed to create the invoice.')
        },
      },
    )
  }

  return (
    <>
      <MTopBar back title="Quick invoice" onBack={() => navigate('/today')} />
      <MBody>
        {/* MILESTONE / PROJECT SELECTOR — square option rows, accent fill on the
            selected one (drives the same setProjectId state the <select> did). */}
        <div className="m-section-h" style={{ borderBottom: '2px solid var(--m-ink)' }}>
          Project · pick one
        </div>
        <div style={{ padding: '14px 16px' }}>
          {projects.map((p) => {
            const active = p.id === projectId
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setProjectId(p.id)}
                aria-pressed={active}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 14px',
                  marginBottom: 8,
                  border: '2px solid var(--m-ink)',
                  cursor: 'pointer',
                  background: active ? 'var(--m-accent)' : 'transparent',
                  color: active ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                }}
              >
                <span style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 14 }}>{p.name}</span>
                <span className="num" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', opacity: 0.75 }}>
                  {active ? '● BILLING THIS' : '○ TAP TO BILL'}
                </span>
              </button>
            )
          })}
        </div>

        {/* CONTRACT VALUE — the full project bid the milestones draw down. */}
        {project ? (
          <div style={{ padding: '18px 16px', borderBottom: '2px solid var(--m-ink)' }}>
            <div className="m-section-h" style={{ padding: 0, border: 'none' }}>
              Contract value
            </div>
            <div
              className="num"
              style={{
                fontFamily: 'var(--m-font-display)',
                fontSize: 36,
                fontWeight: 800,
                letterSpacing: '-0.025em',
                marginTop: 6,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatMoney(contractValue)}
            </div>
          </div>
        ) : null}

        {/* MILESTONES — real persisted billing schedule (migration 104).
            Deposit / progress / final with per-step paid / invoiced / not-yet
            status. Active step (first not-paid) gets the accent fill, mirroring
            V2InvoiceCreate. When a project has none, offer a one-tap seed. */}
        {project ? (
          <>
            <div className="m-section-h" style={{ borderBottom: '2px solid var(--m-ink)' }}>
              Milestones · billing schedule
            </div>
            <div style={{ padding: '14px 16px' }}>
              {milestonesQuery.isPending ? (
                <div style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>Loading milestones…</div>
              ) : hasMilestones ? (
                milestones.map((m) => {
                  const isActive = m.id === activeId
                  return (
                    <div
                      key={m.id}
                      style={{
                        padding: '12px 14px',
                        border: '2px solid var(--m-ink)',
                        marginBottom: 8,
                        background: isActive ? 'var(--m-accent)' : 'transparent',
                        color: isActive ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 14 }}>
                          {m.label}
                        </span>
                        <span
                          className="num"
                          style={{ fontSize: 13, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}
                        >
                          {m.amount !== null ? formatMoney(m.amount) : m.pct !== null ? `${m.pct}%` : '—'}
                        </span>
                      </div>
                      <div
                        className="num"
                        style={{ fontSize: 10, marginTop: 6, fontWeight: 600, letterSpacing: '0.06em', opacity: 0.75 }}
                      >
                        {milestoneStatusLabel(m.status)}
                      </div>
                    </div>
                  )
                })
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>
                    No billing schedule yet. Seed a deposit / progress / final ladder from the contract value.
                  </div>
                  <MButton
                    variant="ghost"
                    size="sm"
                    disabled={createMilestones.isPending}
                    onClick={seedLadder}
                  >
                    {createMilestones.isPending ? 'Seeding…' : 'Seed deposit / progress / final'}
                  </MButton>
                </div>
              )}
            </div>
          </>
        ) : null}

        {/* AMOUNT entry feeds the THIS INVOICE big-number below. The invoice
            total billed to QBO is the project's estimate subtotal (snapshotted
            into the push); this field is a memo-only milestone hint until a
            per-milestone billing endpoint exists. */}
        <div className="m-section-h" style={{ borderBottom: '2px solid var(--m-ink)' }}>
          Amount
        </div>
        <div style={{ padding: '14px 16px' }}>
          <MInput
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
            style={{ width: '100%' }}
            placeholder="0.00"
          />
        </div>

        {/* THIS INVOICE — the big-number hero. */}
        <div className="m-section-h" style={{ borderBottom: '2px solid var(--m-ink)' }}>
          This invoice
        </div>
        <div
          style={{
            padding: '18px 16px',
            background: 'var(--m-card-soft)',
            borderBottom: '2px solid var(--m-ink)',
          }}
        >
          <div
            className="num"
            style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--m-ink-3)' }}
          >
            {project ? `BILLING NOW · ${project.name.toUpperCase()}` : 'PICK A PROJECT TO BILL'}
          </div>
          <div
            className="num"
            style={{
              fontFamily: 'var(--m-font-display)',
              fontSize: 52,
              fontWeight: 800,
              letterSpacing: '-0.035em',
              marginTop: 8,
              lineHeight: 0.9,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {amount ? formatMoney(amount) : '$0'}
          </div>
          <div
            className="num"
            style={{ marginTop: 8, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--m-ink-2)' }}
          >
            {amount ? 'NET 30 · STRIPE LINK INCLUDED' : 'ENTER THE MILESTONE AMOUNT'}
          </div>
        </div>

        {/* MEMO. */}
        <div className="m-section-h" style={{ borderBottom: '2px solid var(--m-ink)' }}>
          Memo
        </div>
        <div style={{ padding: '14px 16px' }}>
          <MTextarea
            value={memo}
            onChange={(e) => setMemo(e.currentTarget.value)}
            style={{ width: '100%', minHeight: 90 }}
            placeholder="Milestone description (e.g., 50% complete — east elevation)"
          />
        </div>

        {errorMessage ? (
          <div style={{ padding: '0 16px 4px' }}>
            <MBanner
              tone="error"
              title="Couldn't create invoice"
              body={errorMessage}
              action={
                <MButton variant="ghost" size="sm" onClick={() => setErrorMessage(null)}>
                  Dismiss
                </MButton>
              }
            />
          </div>
        ) : null}

        <div style={{ padding: 16 }}>
          <MButtonStack>
            <MButton variant="primary" disabled={!project || createPush.isPending} onClick={send}>
              {createPush.isPending ? 'Sending…' : 'Send invoice'}
            </MButton>
            <MButton variant="ghost" onClick={() => navigate('/today')}>
              Cancel
            </MButton>
          </MButtonStack>
        </div>
      </MBody>
    </>
  )
}
