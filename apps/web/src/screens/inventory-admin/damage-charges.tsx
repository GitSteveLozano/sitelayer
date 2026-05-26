import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet } from '@/components/mobile'
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

      <Card tight>
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
      </Card>

      {projectId ? (
        <>
          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="text-[12px] text-ink-3">
              {rows.length} charge{rows.length === 1 ? '' : 's'} ·{' '}
              <span className="font-semibold text-ink">${openTotal.toFixed(2)} open</span>
            </div>
            <MobileButton variant="primary" onClick={() => setCreating(true)}>
              + New charge
            </MobileButton>
          </div>

          <div className="mt-4 space-y-2">
            {damage.isPending ? (
              <Card tight>
                <div className="text-[12px] text-ink-3">Loading…</div>
              </Card>
            ) : rows.length === 0 ? (
              <Card tight>
                <div className="text-[12px] text-ink-3">No damage charges on this project.</div>
              </Card>
            ) : (
              rows.map((c) => (
                <Card key={c.id} tight>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold truncate">{c.description}</div>
                      <div className="text-[11px] text-ink-3 mt-0.5">
                        {c.kind} · {c.quantity} × ${Number(c.unit_amount).toFixed(2)} = $
                        {Number(c.total_amount).toFixed(2)}
                        {c.qbo_invoice_id ? <> · QBO #{c.qbo_invoice_id}</> : null}
                      </div>
                    </div>
                    <Pill tone={c.status === 'invoiced' ? 'good' : c.status === 'waived' ? 'default' : 'warn'}>
                      {c.status}
                    </Pill>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <MobileButton
                      variant={c.status === 'open' ? 'primary' : 'ghost'}
                      onClick={() => setSettlingId(c.id)}
                    >
                      {c.status === 'open' ? 'Settle' : 'View'}
                    </MobileButton>
                  </div>
                </Card>
              ))
            )}
          </div>
        </>
      ) : (
        <Card tight>
          <div className="text-[12px] text-ink-3 mt-4">Pick a project to see its damage charges.</div>
        </Card>
      )}

      {creating ? (
        <Sheet open onClose={() => setCreating(false)} title="New damage charge">
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
              <MobileButton type="button" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </MobileButton>
              <MobileButton type="submit" variant="primary" disabled={create.isPending}>
                Save
              </MobileButton>
            </div>
          </form>
        </Sheet>
      ) : null}

      {settlingId ? (
        <Sheet open onClose={() => setSettlingId(null)} title="Settle charge">
          <DamageChargeSettlementPanel id={settlingId} onClose={() => setSettlingId(null)} />
        </Sheet>
      ) : null}
    </div>
  )
}

const SETTLEMENT_TONE: Record<string, 'good' | 'warn' | 'default'> = {
  open: 'warn',
  invoiced: 'good',
  waived: 'default',
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
        <MobileButton variant="ghost" onClick={onClose}>
          Close
        </MobileButton>
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
        <Pill tone={SETTLEMENT_TONE[snapshot.state] ?? 'default'}>{snapshot.state}</Pill>
      </div>

      {isStale ? (
        <Card tight>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Stale state</div>
          <div className="text-[12px] text-ink-2 mt-1">
            This charge moved on the server. Reloaded — pick the next action again.
          </div>
        </Card>
      ) : dispatchError ? (
        <Card tight>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Error</div>
          <div className="text-[12px] text-ink-2 mt-1">{dispatchError}</div>
        </Card>
      ) : null}

      <Card tight>
        <Trail label="Invoiced" at={ctx.invoiced_at} />
        <Trail label="Waived" at={ctx.waived_at} />
        {ctx.waive_reason ? (
          <div className="flex items-start justify-between gap-3 text-[12px] py-1">
            <div className="text-ink-3">Reason</div>
            <div className="text-ink-2 text-right">{ctx.waive_reason}</div>
          </div>
        ) : null}
      </Card>

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
          <Card tight>
            <div className="text-[12px] text-ink-3">Terminal — this charge is settled.</div>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {snapshot.next_events.map((ev) => (
              <MobileButton
                key={ev.type}
                variant={ev.type === 'WAIVE' ? 'ghost' : 'primary'}
                disabled={dispatch.isPending}
                onClick={() => onEvent(ev.type)}
              >
                {ev.label}
              </MobileButton>
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
