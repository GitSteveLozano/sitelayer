import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createRental,
  deleteRental,
  listRentals,
  markRentalReturned,
  triggerRentalInvoice,
  type BootstrapResponse,
  type CreateRentalInput,
  type RentalRow,
  type RentalStatusFilter,
  type SessionResponse,
} from '../api.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Select } from '../components/ui/select.js'
import { Textarea } from '../components/ui/textarea.js'
import { toastError, toastInfo, toastSuccess } from '../components/ui/toast.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog.js'

type RentalsViewProps = {
  companySlug: string
  bootstrap: BootstrapResponse | null
  session: SessionResponse | null
  customers: BootstrapResponse['customers']
  projects: BootstrapResponse['projects']
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function diffDays(laterISO: string, earlierISO: string): number {
  const later = new Date(`${laterISO}T00:00:00Z`).getTime()
  const earlier = new Date(`${earlierISO}T00:00:00Z`).getTime()
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return 0
  return Math.max(0, Math.round((later - earlier) / 86_400_000))
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

function nextInvoiceCountdown(rental: RentalRow): string {
  if (rental.status === 'closed') return 'billed out'
  if (!rental.next_invoice_at) return '—'
  const next = new Date(rental.next_invoice_at).getTime()
  const now = Date.now()
  const diff = Math.round((next - now) / 86_400_000)
  if (diff <= 0) return 'due now'
  return `${diff} day${diff === 1 ? '' : 's'}`
}

function canManageRentals(session: SessionResponse | null): boolean {
  const role = session?.user.role
  return role === 'admin' || role === 'office' || role === 'owner'
}

export function RentalsView({ companySlug, session, customers, projects }: RentalsViewProps) {
  const [rentals, setRentals] = useState<RentalRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<RentalStatusFilter>('active')
  const [busyRentalId, setBusyRentalId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<CreateRentalInput>({
    item_description: '',
    daily_rate: 0,
    delivered_on: todayISO(),
    invoice_cadence_days: 7,
    project_id: projects[0]?.id ?? null,
    customer_id: null,
    notes: null,
  })

  const manageable = canManageRentals(session)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listRentals(companySlug, statusFilter)
      setRentals(data.rentals)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'failed to load rentals')
      setRentals([])
    } finally {
      setLoading(false)
    }
  }, [companySlug, statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  const totalAccruedByRental = useMemo(() => {
    const map = new Map<string, number>()
    const reference = todayISO()
    for (const rental of rentals) {
      const rate = Number(rental.daily_rate)
      if (!Number.isFinite(rate) || rate <= 0) {
        map.set(rental.id, 0)
        continue
      }
      const endISO = rental.returned_on ?? reference
      const days = diffDays(endISO, rental.delivered_on) + 1
      map.set(rental.id, Math.max(0, days * rate))
    }
    return map
  }, [rentals])

  async function handleMarkReturned(rental: RentalRow) {
    setBusyRentalId(rental.id)
    try {
      await markRentalReturned(rental.id, todayISO(), rental.version, companySlug)
      toastSuccess('Rental marked returned')
      await load()
    } catch (caught) {
      toastError('Mark returned failed', caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyRentalId(null)
    }
  }

  async function handleTriggerInvoice(rental: RentalRow) {
    setBusyRentalId(rental.id)
    try {
      const result = await triggerRentalInvoice(rental.id, companySlug)
      if (result.bill) {
        toastSuccess(`Invoice generated: ${formatCurrency(result.amount)} over ${result.days} days`)
      } else {
        toastInfo('Nothing to invoice yet', 'Billing clock advanced')
      }
      await load()
    } catch (caught) {
      toastError('Invoice trigger failed', caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyRentalId(null)
    }
  }

  async function handleDelete(rental: RentalRow) {
    if (!window.confirm(`Delete rental "${rental.item_description}"? This cannot be undone.`)) return
    setBusyRentalId(rental.id)
    try {
      await deleteRental(rental.id, companySlug, rental.version)
      toastSuccess('Rental deleted')
      await load()
    } catch (caught) {
      toastError('Delete failed', caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyRentalId(null)
    }
  }

  async function handleCreate() {
    if (!form.item_description.trim()) {
      toastError('Validation', 'Item description is required')
      return
    }
    setCreating(true)
    try {
      await createRental(
        {
          ...form,
          project_id: form.project_id || null,
          customer_id: form.customer_id || null,
        },
        companySlug,
      )
      toastSuccess('Rental created')
      setCreateOpen(false)
      setForm({
        item_description: '',
        daily_rate: 0,
        delivered_on: todayISO(),
        invoice_cadence_days: 7,
        project_id: projects[0]?.id ?? null,
        customer_id: null,
        notes: null,
      })
      await load()
    } catch (caught) {
      toastError('Create failed', caught instanceof Error ? caught.message : String(caught))
    } finally {
      setCreating(false)
    }
  }

  if (!manageable) {
    return (
      <section className="panel">
        <h2>Rentals</h2>
        <p className="muted">
          403 — rentals are admin/office only. Your current role is {session?.user.role ?? 'unknown'}.
        </p>
      </section>
    )
  }

  return (
    <>
      <section className="hero">
        <p className="eyebrow">Equipment billing</p>
        <h1>Rentals</h1>
        <p className="lede compact">
          Track equipment out on rent, roll up accrued cost per project, and trigger weekly invoices. Active rentals
          auto-bill on cadence.
        </p>
      </section>

      <section className="panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <label>
              <span className="muted compact">Filter</span>
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as RentalStatusFilter)}
                aria-label="Rental status filter"
                data-testid="rentals-status-filter"
              >
                <option value="active">Active</option>
                <option value="returned">Returned / pending invoice</option>
                <option value="closed">Closed</option>
                <option value="all">All</option>
              </Select>
            </label>
          </div>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button type="button" data-testid="rentals-new-button">
                + New rental
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New rental</DialogTitle>
                <DialogDescription>
                  Logs an item as out on rent. Billing starts from the delivery date and fires every cadence interval.
                </DialogDescription>
              </DialogHeader>
              <div className="formGrid">
                <label>
                  <span className="muted compact">Item description</span>
                  <Input
                    value={form.item_description}
                    onChange={(e) => setForm((prev) => ({ ...prev, item_description: e.target.value }))}
                    placeholder="Scaffolding tower 6m"
                    aria-label="Item description"
                  />
                </label>
                <label>
                  <span className="muted compact">Daily rate (USD)</span>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={form.daily_rate}
                    onChange={(e) => setForm((prev) => ({ ...prev, daily_rate: Number(e.target.value) }))}
                    aria-label="Daily rate"
                  />
                </label>
                <label>
                  <span className="muted compact">Delivered on</span>
                  <Input
                    type="date"
                    value={form.delivered_on}
                    onChange={(e) => setForm((prev) => ({ ...prev, delivered_on: e.target.value }))}
                    aria-label="Delivered on"
                  />
                </label>
                <label>
                  <span className="muted compact">Invoice cadence (days)</span>
                  <Input
                    type="number"
                    min={1}
                    value={form.invoice_cadence_days ?? 7}
                    onChange={(e) => setForm((prev) => ({ ...prev, invoice_cadence_days: Number(e.target.value) }))}
                    aria-label="Invoice cadence days"
                  />
                </label>
                <label>
                  <span className="muted compact">Project</span>
                  <Select
                    value={form.project_id ?? ''}
                    onChange={(e) => setForm((prev) => ({ ...prev, project_id: e.target.value || null }))}
                    aria-label="Project"
                  >
                    <option value="">(none)</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  <span className="muted compact">Customer</span>
                  <Select
                    value={form.customer_id ?? ''}
                    onChange={(e) => setForm((prev) => ({ ...prev, customer_id: e.target.value || null }))}
                    aria-label="Customer"
                  >
                    <option value="">(none)</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  <span className="muted compact">Notes</span>
                  <Textarea
                    value={form.notes ?? ''}
                    onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value || null }))}
                    aria-label="Notes"
                  />
                </label>
              </div>
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
                  Cancel
                </Button>
                <Button type="button" onClick={() => void handleCreate()} disabled={creating}>
                  {creating ? 'Creating…' : 'Create rental'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </section>

      <section className="panel">
        <h2>
          Rentals <span className="muted compact">({rentals.length})</span>
        </h2>
        {error ? <p className="muted">Error: {error}</p> : null}
        {loading ? <p className="muted">Loading…</p> : null}
        {!loading && !error && rentals.length === 0 ? <p className="muted">No rentals in this bucket.</p> : null}
        {rentals.length > 0 ? (
          <div className="auditTableWrap">
            <table className="auditTable" data-testid="rentals-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Customer</th>
                  <th>Project</th>
                  <th>Daily rate</th>
                  <th>Days out</th>
                  <th>Accrued</th>
                  <th>Status</th>
                  <th>Next invoice</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rentals.map((rental) => {
                  const project = projects.find((p) => p.id === rental.project_id)
                  const customer = customers.find((c) => c.id === rental.customer_id)
                  const endISO = rental.returned_on ?? todayISO()
                  const daysOut = diffDays(endISO, rental.delivered_on) + 1
                  const accrued = totalAccruedByRental.get(rental.id) ?? 0
                  const busy = busyRentalId === rental.id
                  return (
                    <tr key={rental.id}>
                      <td>
                        <div>{rental.item_description}</div>
                        <div className="muted compact">delivered {rental.delivered_on}</div>
                      </td>
                      <td>{customer?.name ?? <span className="muted">—</span>}</td>
                      <td>{project?.name ?? <span className="muted">—</span>}</td>
                      <td>{formatCurrency(Number(rental.daily_rate))}</td>
                      <td>{daysOut}</td>
                      <td>{formatCurrency(accrued)}</td>
                      <td>
                        <span className="badge">{rental.status}</span>
                      </td>
                      <td>
                        {rental.status === 'active' || rental.status === 'returned' ? (
                          <span>Next invoice in {nextInvoiceCountdown(rental)}</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {rental.status === 'active' ? (
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void handleMarkReturned(rental)}
                              data-testid={`rentals-mark-returned-${rental.id}`}
                            >
                              Mark returned
                            </Button>
                          ) : null}
                          {rental.project_id ? (
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void handleTriggerInvoice(rental)}
                              data-testid={`rentals-invoice-${rental.id}`}
                            >
                              Invoice now
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void handleDelete(rental)}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  )
}
