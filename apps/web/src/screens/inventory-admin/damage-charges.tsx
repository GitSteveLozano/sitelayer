import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { MButton, MI, MPill, type MTone } from '@/components/m'
import { useProjects } from '@/lib/api'
import { useCreateDamageCharge, useDamageCharges, type DamageCharge } from '@/lib/api/damage-charges'
import {
  useDamageChargeSnapshot,
  useDispatchDamageChargeEvent,
  type DamageChargeSettlementEvent,
} from '@/lib/api/damage-charge-settlement'

const KINDS: ReadonlyArray<{ value: DamageCharge['kind']; label: string }> = [
  { value: 'damage', label: 'Damage' },
  { value: 'loss', label: 'Loss / non-return' },
  { value: 'late_return', label: 'Late return' },
  { value: 'cleanup', label: 'Cleanup' },
]

export function DamageChargesAdminScreen() {
  const [params, setParams] = useSearchParams()
  const projectId = params.get('project') ?? ''
  const projects = useProjects()
  const damage = useDamageCharges(projectId)
  const create = useCreateDamageCharge(projectId)
  const [creating, setCreating] = useState(false)
  // The selected charge opens a headless settlement detail sheet that
  // renders the WorkflowSnapshot state + next_events and dispatches
  // INVOICE / WAIVE through the deterministic reducer. Reachable from the
  // existing route — no shared-nav change.
  const [settlingId, setSettlingId] = useState<string | null>(null)

  const rows = damage.data?.charges ?? []
  const openTotal = rows.filter((c) => c.status === 'open').reduce((sum, c) => sum + Number(c.total_amount), 0)

  function onCreateSubmit(form: FormData) {
    const kind = String(form.get('kind') ?? 'damage') as DamageCharge['kind']
    const description = String(form.get('description') ?? '').trim()
    const quantity = Number(form.get('quantity') ?? 1)
    const unit_amount = Number(form.get('unit_amount') ?? 0)
    if (!description || quantity <= 0 || unit_amount <= 0) return
    create.mutate({ kind, description, quantity, unit_amount }, { onSuccess: () => setCreating(false) })
  }

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more/inventory" className="text-[12px] text-ink-3">
        ← Inventory admin
      </Link>
      <h1 className="mt-2 font-display text-[24px] font-bold tracking-tight leading-tight">
        Damage &amp; loss charges
      </h1>
      <p className="text-[12px] text-ink-3 mt-1">
        Per-project queue. Invoicing posts a single-line QBO invoice via mutation_outbox.
      </p>

      <div className="m-card m-card-tight">
        <label className="block">
          <span className="text-[12px] text-ink-3">Project</span>
          <select
            value={projectId}
            onChange={(e) => {
              const v = e.target.value
              setParams(v ? { project: v } : {})
            }}
            className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[14px]"
          >
            <option value="">— pick a project —</option>
            {(projects.data?.projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {projectId ? (
        <>
          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="text-[12px] text-ink-3">
              {rows.length} charge{rows.length === 1 ? '' : 's'} ·{' '}
              <span className="font-semibold text-ink">${openTotal.toFixed(2)} open</span>
            </div>
            <MButton variant="primary" size="sm" onClick={() => setCreating(true)}>
              + New charge
            </MButton>
          </div>

          <div className="mt-4 space-y-2">
            {damage.isPending ? (
              <div className="m-card m-card-tight">
                <div className="text-[12px] text-ink-3">Loading…</div>
              </div>
            ) : rows.length === 0 ? (
              <div className="m-card m-card-tight">
                <div className="text-[12px] text-ink-3">No damage charges on this project.</div>
              </div>
            ) : (
              rows.map((c) => (
                <div key={c.id} className="m-card m-card-tight">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold truncate">{c.description}</div>
                      <div className="text-[11px] text-ink-3 mt-0.5">
                        {c.kind} · {c.quantity} × ${Number(c.unit_amount).toFixed(2)} = $
                        {Number(c.total_amount).toFixed(2)}
                        {c.qbo_invoice_id ? <> · QBO #{c.qbo_invoice_id}</> : null}
                      </div>
                    </div>
                    <MPill tone={c.status === 'invoiced' ? 'green' : c.status === 'waived' ? undefined : 'amber'}>
                      {c.status}
                    </MPill>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <MButton
                      variant={c.status === 'open' ? 'primary' : 'ghost'}
                      size="sm"
                      onClick={() => setSettlingId(c.id)}
                    >
                      {c.status === 'open' ? 'Settle' : 'View'}
                    </MButton>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      ) : (
        <div className="m-card m-card-tight">
          <div className="text-[12px] text-ink-3 mt-4">Pick a project to see its damage charges.</div>
        </div>
      )}

      {creating ? (
        <MSheet title="New damage charge" onClose={() => setCreating(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              onCreateSubmit(new FormData(e.currentTarget))
            }}
            className="space-y-3"
          >
            <label className="block">
              <span className="text-[12px] text-ink-3">Kind</span>
              <select
                name="kind"
                defaultValue="damage"
                className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[14px]"
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[12px] text-ink-3">Description</span>
              <input
                name="description"
                className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[14px]"
                placeholder="e.g. 2x cuplock standard, bent"
                required
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[12px] text-ink-3">Quantity</span>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  name="quantity"
                  defaultValue="1"
                  className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[14px]"
                  required
                />
              </label>
              <label className="block">
                <span className="text-[12px] text-ink-3">Unit amount ($)</span>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  name="unit_amount"
                  className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[14px]"
                  required
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <MButton type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>
                Cancel
              </MButton>
              <MButton type="submit" variant="primary" size="sm" disabled={create.isPending}>
                Save
              </MButton>
            </div>
          </form>
        </MSheet>
      ) : null}

      {settlingId ? (
        <MSheet title="Settle charge" onClose={() => setSettlingId(null)}>
          <DamageChargeSettlementPanel id={settlingId} onClose={() => setSettlingId(null)} />
        </MSheet>
      ) : null}
    </div>
  )
}

const SETTLEMENT_TONE: Record<string, MTone | undefined> = {
  open: 'amber',
  invoiced: 'green',
  waived: undefined,
}

/**
 * Headless damage-charge settlement detail. Loads the WorkflowSnapshot
 * (`{ state, state_version, context, next_events }`) and dispatches
 * INVOICE / WAIVE straight from `next_events`, mirroring the
 * billing-run-detail pattern. The component is a thin renderer — it never
 * invents a settlement state; the reducer + 409 reload own the truth.
 */
function DamageChargeSettlementPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const snapshotQuery = useDamageChargeSnapshot(id)
  const dispatch = useDispatchDamageChargeEvent(id)
  // WAIVE collects an optional reason; INVOICE goes straight through.
  const [waiveReason, setWaiveReason] = useState('')
  const [showWaive, setShowWaive] = useState(false)

  const snapshot = snapshotQuery.data

  if (snapshotQuery.isPending && !snapshot) {
    return <div className="text-[12px] text-ink-3">Loading charge…</div>
  }
  if (!snapshot) {
    return (
      <div className="space-y-3">
        <div className="text-[12px] text-warn">Could not load this charge.</div>
        <MButton variant="ghost" size="sm" onClick={onClose}>
          Close
        </MButton>
      </div>
    )
  }

  const ctx = snapshot.context
  const dispatchError = dispatch.error?.message ?? null
  const isStale = dispatchError != null && /\b409\b|state_version|illegal|not allowed/i.test(dispatchError)

  const onEvent = (event: DamageChargeSettlementEvent) => {
    if (event === 'WAIVE' && !showWaive) {
      setShowWaive(true)
      return
    }
    dispatch.mutate(
      {
        event,
        state_version: snapshot.state_version,
        ...(event === 'WAIVE' && waiveReason.trim() ? { waive_reason: waiveReason.trim() } : {}),
      },
      {
        onSuccess: () => {
          setShowWaive(false)
          setWaiveReason('')
        },
      },
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold truncate">{ctx.description}</div>
          <div className="text-[11px] text-ink-3 mt-0.5">
            {ctx.kind} · {ctx.quantity} × ${Number(ctx.unit_amount).toFixed(2)} = ${Number(ctx.total_amount).toFixed(2)}{' '}
            · v{snapshot.state_version}
            {ctx.qbo_invoice_id ? <> · QBO #{ctx.qbo_invoice_id}</> : null}
          </div>
        </div>
        <MPill tone={SETTLEMENT_TONE[snapshot.state]}>{snapshot.state}</MPill>
      </div>

      {isStale ? (
        <div className="m-card m-card-tight">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Stale state</div>
          <div className="text-[12px] text-ink-2 mt-1">
            This charge moved on the server. Reloaded — pick the next action again.
          </div>
        </div>
      ) : dispatchError ? (
        <div className="m-card m-card-tight">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Error</div>
          <div className="text-[12px] text-ink-2 mt-1">{dispatchError}</div>
        </div>
      ) : null}

      <div className="m-card m-card-tight">
        <Trail label="Invoiced" at={ctx.invoiced_at} />
        <Trail label="Waived" at={ctx.waived_at} />
        {ctx.waive_reason ? (
          <div className="flex items-start justify-between gap-3 text-[12px] py-1">
            <div className="text-ink-3">Reason</div>
            <div className="text-ink-2 text-right">{ctx.waive_reason}</div>
          </div>
        ) : null}
      </div>

      {showWaive ? (
        <label className="block">
          <span className="text-[12px] text-ink-3">Waive reason (optional)</span>
          <textarea
            value={waiveReason}
            onChange={(e) => setWaiveReason(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[13px]"
            placeholder="Why this charge is being waived"
          />
        </label>
      ) : null}

      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 mb-2">Actions</div>
        {snapshot.next_events.length === 0 ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">Terminal — this charge is settled.</div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {snapshot.next_events.map((ev) => (
              <MButton
                key={ev.type}
                variant={ev.type === 'WAIVE' ? 'ghost' : 'primary'}
                disabled={dispatch.isPending}
                onClick={() => onEvent(ev.type)}
              >
                {ev.label}
              </MButton>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Trail({ label, at }: { label: string; at: string | null }) {
  return (
    <div className="flex items-center justify-between text-[12px] py-1">
      <div className="text-ink-3">{label}</div>
      <div className="text-ink-2">
        {at
          ? new Date(at).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })
          : '—'}
      </div>
    </div>
  )
}

/**
 * Bottom sheet in the `.m-sheet` idiom (styles/m.css — square corners, 2px
 * ink top rule, hard offset shadow, no grabber/blur). Same pattern as the
 * AssignmentSheet swap in screens/mobile/schedule.tsx (e9b7c7f3); replaces
 * the retired wave-2 kit Sheet. ESC and backdrop-tap dismiss.
 */
function MSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'rgba(15, 14, 12, 0.5)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="m-sheet" style={{ maxWidth: 720 }}>
        <div className="m-sheet-header">
          <div className="m-sheet-title">{title}</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 4,
              color: 'var(--m-ink)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <MI.X size={20} />
          </button>
        </div>
        <div className="m-sheet-body" style={{ padding: '16px 20px 0' }}>
          {children}
        </div>
      </div>
    </div>
  )
}
