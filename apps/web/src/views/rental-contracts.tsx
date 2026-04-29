import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  createRentalContract,
  createRentalLine,
  deleteRentalLine,
  generateBillingRun,
  listInventoryItems,
  listProjectRentalContracts,
  listRentalContractLines,
  previewBillingRun,
  updateRentalLine,
  type InventoryItemRow,
  type JobRentalContractRow,
  type JobRentalLineRow,
  type ProjectRow,
  type RentalBillingRunPreview,
  type RentalLineInput,
} from '../api.js'
import { Button } from '../components/ui/button.js'
import { Checkbox } from '../components/ui/checkbox.js'
import { Input } from '../components/ui/input.js'
import { Select } from '../components/ui/select.js'
import { Textarea } from '../components/ui/textarea.js'
import { toastError, toastSuccess } from '../components/ui/toast.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog.js'

/**
 * Per-project rental contract management — closes the "rental gear tracked
 * to specific job, items at agreed price" half of Steve's spec on the UX
 * side. The deterministic billing-run workflow already lives at
 * /billing-runs and /billing-review/:runId; this screen is the upstream
 * "set up the contract + add line items" surface.
 *
 * Routes:
 *   /rental-contracts/:projectId  → this view
 *
 * Usage flow:
 *   1. Office picks a project
 *   2. Creates the active rental contract (one per project)
 *   3. Adds inventory items at agreed prices + rate units
 *   4. Records on/off-rent dates as gear ships and returns
 *   5. Previews next 25-day billing run
 *   6. Clicks "Generate billing run" → gets routed to /billing-review/:runId
 */

type RentalContractsViewProps = {
  companySlug: string
  projects: ProjectRow[]
}

const RATE_UNITS = [
  { value: 'cycle', label: 'Cycle (25-day)' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'each', label: 'Each' },
] as const

function formatCurrency(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return String(value)
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num)
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

export function RentalContractsView({ companySlug, projects }: RentalContractsViewProps) {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId])

  const [contracts, setContracts] = useState<JobRentalContractRow[]>([])
  const [lines, setLines] = useState<JobRentalLineRow[]>([])
  const [inventory, setInventory] = useState<InventoryItemRow[]>([])
  const [preview, setPreview] = useState<RentalBillingRunPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const activeContract = contracts.find((c) => c.status !== 'closed' && !c.deleted_at) ?? null

  async function refresh() {
    if (!projectId) return
    setLoading(true)
    try {
      const [contractsResult, inventoryResult] = await Promise.all([
        listProjectRentalContracts(projectId, companySlug),
        listInventoryItems(companySlug),
      ])
      setContracts(contractsResult.rentalContracts)
      setInventory(inventoryResult.inventoryItems.filter((item) => item.active))
      const active = contractsResult.rentalContracts.find((c) => c.status !== 'closed' && !c.deleted_at)
      if (active) {
        const linesResult = await listRentalContractLines(active.id, companySlug)
        setLines(linesResult.rentalLines)
      } else {
        setLines([])
      }
      setError(null)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'failed to load contract data'
      setError(message)
      toastError('Could not load rental contract', message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh stable enough
  }, [projectId, companySlug])

  async function handleCreateContract() {
    if (!projectId) return
    setBusy(true)
    try {
      await createRentalContract(
        projectId,
        {
          billing_cycle_days: 25,
          billing_mode: 'arrears',
          billing_start_date: todayISO(),
          customer_id: project?.customer_id ?? null,
        },
        companySlug,
      )
      toastSuccess('Rental contract created')
      await refresh()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'create failed'
      toastError('Failed to create contract', message)
    } finally {
      setBusy(false)
    }
  }

  async function handlePreview() {
    if (!activeContract) return
    setBusy(true)
    try {
      const result = await previewBillingRun(activeContract.id, companySlug)
      setPreview(result.preview)
      if (!result.preview.is_due) {
        toastSuccess(`Preview computed — next billing run is due ${result.preview.due_date}`)
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'preview failed'
      toastError('Preview failed', message)
    } finally {
      setBusy(false)
    }
  }

  async function handleGenerate(force = false) {
    if (!activeContract) return
    setBusy(true)
    try {
      const result = await generateBillingRun(activeContract.id, companySlug, { force })
      toastSuccess('Billing run generated — opening review')
      navigate(`/billing-review/${result.billingRun.id}`)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'generate failed'
      // The API returns 400 + "billing run is not due yet" before the cycle
      // closes; in that case offer the force option.
      if (/not due yet/i.test(message)) {
        if (typeof window !== 'undefined' && window.confirm(`${message}\n\nGenerate anyway?`)) {
          await handleGenerate(true)
          return
        }
      }
      toastError('Generate failed', message)
    } finally {
      setBusy(false)
    }
  }

  async function handleEndRental(line: JobRentalLineRow) {
    setBusy(true)
    try {
      await updateRentalLine(
        line.id,
        { off_rent_date: todayISO(), status: 'returned', expected_version: line.version },
        companySlug,
      )
      toastSuccess(`Marked ${line.item_code ?? line.id.slice(0, 8)} returned`)
      await refresh()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'update failed'
      toastError('End rental failed', message)
    } finally {
      setBusy(false)
    }
  }

  async function handleDeleteLine(line: JobRentalLineRow) {
    if (typeof window !== 'undefined' && !window.confirm(`Remove ${line.item_code ?? 'this line'} from the contract?`))
      return
    setBusy(true)
    try {
      await deleteRentalLine(line.id, companySlug, line.version)
      toastSuccess('Line removed')
      await refresh()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'delete failed'
      toastError('Failed to remove line', message)
    } finally {
      setBusy(false)
    }
  }

  if (!projectId) return null
  if (!project) {
    return (
      <section className="space-y-3">
        <h2 className="text-2xl font-semibold">Rental contract</h2>
        <p className="text-sm text-slate-500">Project not found.</p>
      </section>
    )
  }

  return (
    <section className="space-y-5">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Rental contract</h2>
          <p className="text-sm text-slate-500">
            {project.name} · {project.customer_name}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </header>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</div>
      )}

      {!activeContract ? (
        <div className="space-y-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
          <p className="text-sm text-slate-600">No active rental contract for this project yet.</p>
          <p className="text-xs text-slate-500">
            Creating one starts a 25-day billing cycle in arrears. Items + agreed prices get added on the next step.
          </p>
          <Button variant="default" onClick={handleCreateContract} disabled={busy}>
            Create rental contract
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Status" value={activeContract.status} />
            <Stat label="Cycle" value={`${activeContract.billing_cycle_days} days · ${activeContract.billing_mode}`} />
            <Stat
              label="Next billing"
              value={activeContract.next_billing_date}
              hint={
                activeContract.last_billed_through
                  ? `Last billed through ${activeContract.last_billed_through}`
                  : 'New cycle'
              }
            />
            <Stat label="Lines on rent" value={String(lines.filter((l) => !l.off_rent_date).length)} />
          </div>

          <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-baseline justify-between">
              <h3 className="font-semibold">Items on this contract</h3>
              <AddLineDialog
                contractId={activeContract.id}
                inventory={inventory}
                companySlug={companySlug}
                onSaved={refresh}
              />
            </div>
            {lines.length === 0 ? (
              <p className="text-sm text-slate-500">
                No items yet. Add inventory items at their agreed price for this job.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-slate-500">
                      <th className="px-2 py-2">Item</th>
                      <th className="px-2 py-2 text-right">Qty</th>
                      <th className="px-2 py-2 text-right">Agreed rate</th>
                      <th className="px-2 py-2">Unit</th>
                      <th className="px-2 py-2">On-rent</th>
                      <th className="px-2 py-2">Off-rent</th>
                      <th className="px-2 py-2">Status</th>
                      <th className="px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.id} className="border-b border-slate-100">
                        <td className="px-2 py-2">
                          <div className="font-mono text-xs">{line.item_code ?? '—'}</div>
                          <div className="text-xs text-slate-500">{line.item_description ?? ''}</div>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{line.quantity}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(line.agreed_rate)}</td>
                        <td className="px-2 py-2 text-xs">{line.rate_unit}</td>
                        <td className="px-2 py-2 text-xs">{line.on_rent_date}</td>
                        <td className="px-2 py-2 text-xs">{line.off_rent_date ?? '—'}</td>
                        <td className="px-2 py-2 text-xs">
                          <span
                            className={`rounded px-2 py-0.5 text-xs ${
                              line.off_rent_date ? 'bg-slate-200 text-slate-700' : 'bg-emerald-100 text-emerald-800'
                            }`}
                          >
                            {line.off_rent_date ? 'Returned' : 'On rent'}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex justify-end gap-1">
                            {!line.off_rent_date && (
                              <Button variant="outline" size="sm" onClick={() => handleEndRental(line)} disabled={busy}>
                                End rental
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" onClick={() => handleDeleteLine(line)} disabled={busy}>
                              Remove
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-baseline justify-between">
              <h3 className="font-semibold">Next billing run</h3>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handlePreview} disabled={busy}>
                  Preview
                </Button>
                <Button variant="default" size="sm" onClick={() => handleGenerate(false)} disabled={busy}>
                  Generate
                </Button>
              </div>
            </div>
            {preview ? (
              <div className="space-y-2 text-sm">
                <p className="text-slate-700">
                  Period: <strong>{preview.period_start}</strong> → <strong>{preview.period_end}</strong> · Subtotal:{' '}
                  <strong className="tabular-nums">{formatCurrency(preview.subtotal)}</strong>
                </p>
                {!preview.is_due && (
                  <p className="text-amber-700">
                    Not due yet (next due {preview.due_date}). Use Generate → confirm to force-bill.
                  </p>
                )}
                {preview.lines.length === 0 ? (
                  <p className="text-slate-500">No billable lines this period.</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-slate-500">
                        <th className="px-2 py-1">Item</th>
                        <th className="px-2 py-1 text-right">Qty</th>
                        <th className="px-2 py-1 text-right">Rate</th>
                        <th className="px-2 py-1">Unit</th>
                        <th className="px-2 py-1 text-right">Days</th>
                        <th className="px-2 py-1 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.lines.map((line) => (
                        <tr key={line.line_id} className="border-b border-slate-100">
                          <td className="px-2 py-1">{line.description ?? line.inventory_item_id?.slice(0, 8)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{line.quantity}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{formatCurrency(line.agreed_rate)}</td>
                          <td className="px-2 py-1">{line.rate_unit}</td>
                          <td className="px-2 py-1 text-right">{line.billable_days}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{formatCurrency(line.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                Click Preview to see what the next 25-day cycle will bill, or Generate to create a billing run and
                proceed to review.
              </p>
            )}
          </section>
        </>
      )}
    </section>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {hint && <div className="text-xs text-slate-500">{hint}</div>}
    </div>
  )
}

type AddLineDialogProps = {
  contractId: string
  inventory: InventoryItemRow[]
  companySlug: string
  onSaved: () => Promise<void> | void
}

function AddLineDialog({ contractId, inventory, companySlug, onSaved }: AddLineDialogProps) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState<RentalLineInput>({
    inventory_item_id: '',
    quantity: 1,
    agreed_rate: 0,
    rate_unit: 'cycle',
    on_rent_date: todayISO(),
    billable: true,
    taxable: true,
  })

  // When the user picks an inventory item, default the agreed rate to the
  // catalog's default_rental_rate so the office only has to override when
  // negotiating per-job pricing.
  function handleItemChange(itemId: string) {
    const item = inventory.find((i) => i.id === itemId)
    setForm((prev) => ({
      ...prev,
      inventory_item_id: itemId,
      agreed_rate: item ? Number(item.default_rental_rate) : prev.agreed_rate,
    }))
  }

  async function handleSubmit() {
    if (!form.inventory_item_id) return
    setSubmitting(true)
    try {
      await createRentalLine(contractId, form, companySlug)
      toastSuccess('Line added')
      await onSaved()
      setOpen(false)
      setForm({
        inventory_item_id: '',
        quantity: 1,
        agreed_rate: 0,
        rate_unit: 'cycle',
        on_rent_date: todayISO(),
        billable: true,
        taxable: true,
      })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'create failed'
      toastError('Failed to add line', message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default" size="sm">
          Add item
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add rental line</DialogTitle>
          <DialogDescription>Pick an inventory item and set the agreed price for this job.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span className="text-slate-700">Inventory item</span>
            <Select value={form.inventory_item_id} onChange={(e) => handleItemChange(e.target.value)}>
              <option value="">Select an item…</option>
              {inventory.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.code} — {item.description}
                </option>
              ))}
            </Select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Quantity</span>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={String(form.quantity)}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Agreed rate ($)</span>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={String(form.agreed_rate)}
                onChange={(e) => setForm({ ...form, agreed_rate: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Rate unit</span>
              <Select
                value={form.rate_unit}
                onChange={(e) =>
                  setForm({ ...form, rate_unit: e.target.value as NonNullable<RentalLineInput['rate_unit']> })
                }
              >
                {RATE_UNITS.map((unit) => (
                  <option key={unit.value} value={unit.value}>
                    {unit.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">On-rent date</span>
              <Input
                type="date"
                value={form.on_rent_date ?? ''}
                onChange={(e) => setForm({ ...form, on_rent_date: e.target.value })}
              />
            </label>
          </div>
          <div className="flex gap-4 text-sm text-slate-700">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={form.billable !== false}
                onChange={(e) => setForm({ ...form, billable: e.target.checked })}
              />
              Billable
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={form.taxable !== false}
                onChange={(e) => setForm({ ...form, taxable: e.target.checked })}
              />
              Taxable
            </label>
          </div>
          <label className="block space-y-1 text-sm">
            <span className="text-slate-700">Notes</span>
            <Textarea rows={2} value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="default"
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !form.inventory_item_id}
          >
            {submitting ? 'Adding…' : 'Add line'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
