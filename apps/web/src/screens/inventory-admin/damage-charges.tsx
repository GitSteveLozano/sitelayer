import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet } from '@/components/mobile'
import { useProjects } from '@/lib/api'
import {
  useCreateDamageCharge,
  useDamageCharges,
  useInvoiceDamageCharge,
  useWaiveDamageCharge,
  type DamageCharge,
} from '@/lib/api/damage-charges'

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
  const invoice = useInvoiceDamageCharge()
  const waive = useWaiveDamageCharge()
  const [creating, setCreating] = useState(false)
  const [waivingId, setWaivingId] = useState<string | null>(null)

  const rows = damage.data?.charges ?? []
  const openTotal = rows
    .filter((c) => c.status === 'open')
    .reduce((sum, c) => sum + Number(c.total_amount), 0)

  function onCreateSubmit(form: FormData) {
    const kind = String(form.get('kind') ?? 'damage') as DamageCharge['kind']
    const description = String(form.get('description') ?? '').trim()
    const quantity = Number(form.get('quantity') ?? 1)
    const unit_amount = Number(form.get('unit_amount') ?? 0)
    if (!description || quantity <= 0 || unit_amount <= 0) return
    create.mutate({ kind, description, quantity, unit_amount }, { onSuccess: () => setCreating(false) })
  }

  function onWaiveSubmit(form: FormData, id: string) {
    const reason = String(form.get('reason') ?? '').trim()
    const payload: Parameters<typeof waive.mutate>[0] = { id }
    if (reason) payload.waive_reason = reason
    waive.mutate(payload, { onSuccess: () => setWaivingId(null) })
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
                    <Pill
                      tone={
                        c.status === 'invoiced' ? 'good' : c.status === 'waived' ? 'default' : 'warn'
                      }
                    >
                      {c.status}
                    </Pill>
                  </div>
                  {c.status === 'open' ? (
                    <div className="mt-2 flex gap-2">
                      <MobileButton
                        variant="primary"
                        onClick={() => invoice.mutate({ id: c.id })}
                        disabled={invoice.isPending}
                      >
                        Invoice
                      </MobileButton>
                      <MobileButton variant="ghost" onClick={() => setWaivingId(c.id)}>
                        Waive
                      </MobileButton>
                    </div>
                  ) : null}
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

      {waivingId ? (
        <Sheet open onClose={() => setWaivingId(null)} title="Waive charge">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              onWaiveSubmit(new FormData(e.currentTarget), waivingId)
            }}
            className="space-y-3"
          >
            <label className="block">
              <span className="text-[12px] text-ink-3">Reason</span>
              <textarea
                name="reason"
                rows={3}
                className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[13px]"
                placeholder="Why this charge is being waived"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <MobileButton type="button" variant="ghost" onClick={() => setWaivingId(null)}>
                Cancel
              </MobileButton>
              <MobileButton type="submit" variant="primary" disabled={waive.isPending}>
                Waive
              </MobileButton>
            </div>
          </form>
        </Sheet>
      ) : null}
    </div>
  )
}
