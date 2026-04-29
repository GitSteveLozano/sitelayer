import { useEffect, useMemo, useState } from 'react'
import {
  createInventoryMovement,
  listInventoryItems,
  listInventoryLocations,
  listInventoryMovements,
  type CreateMovementInput,
  type InventoryItemRow,
  type InventoryLocationRow,
  type InventoryMovementRow,
  type ProjectRow,
} from '../api.js'
import { Button } from '../components/ui/button.js'
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
 * Inventory movement ledger UI.
 *
 * Lists deliveries, returns, transfers, and damaged/lost adjustments
 * across the company with filters by item, project, and movement type.
 * Provides a "Record movement" dialog for the office to log gear ships
 * and returns directly without going through a rental contract line.
 */

type MovementsViewProps = {
  companySlug: string
  projects: ProjectRow[]
}

const MOVEMENT_TYPES: Array<{ value: InventoryMovementRow['movement_type']; label: string; color: string }> = [
  { value: 'deliver', label: 'Deliver', color: 'bg-emerald-100 text-emerald-800' },
  { value: 'return', label: 'Return', color: 'bg-blue-100 text-blue-800' },
  { value: 'transfer', label: 'Transfer', color: 'bg-amber-100 text-amber-900' },
  { value: 'adjustment', label: 'Adjustment', color: 'bg-slate-100 text-slate-800' },
  { value: 'damaged', label: 'Damaged', color: 'bg-orange-100 text-orange-900' },
  { value: 'lost', label: 'Lost', color: 'bg-red-100 text-red-900' },
  { value: 'repair', label: 'Repair', color: 'bg-purple-100 text-purple-900' },
]

const TYPE_BADGE = Object.fromEntries(MOVEMENT_TYPES.map((t) => [t.value, t.color])) as Record<
  InventoryMovementRow['movement_type'],
  string
>

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

export function MovementsView({ companySlug, projects }: MovementsViewProps) {
  const [movements, setMovements] = useState<InventoryMovementRow[]>([])
  const [items, setItems] = useState<InventoryItemRow[]>([])
  const [locations, setLocations] = useState<InventoryLocationRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filterType, setFilterType] = useState<InventoryMovementRow['movement_type'] | ''>('')
  const [filterItem, setFilterItem] = useState('')
  const [filterProject, setFilterProject] = useState('')

  async function refresh() {
    setLoading(true)
    try {
      const [moveResult, itemsResult, locResult] = await Promise.all([
        listInventoryMovements(companySlug, {
          ...(filterType ? { type: filterType } : {}),
          ...(filterItem ? { itemId: filterItem } : {}),
          ...(filterProject ? { projectId: filterProject } : {}),
        }),
        listInventoryItems(companySlug),
        listInventoryLocations(companySlug),
      ])
      setMovements(moveResult.inventoryMovements)
      setItems(itemsResult.inventoryItems.filter((i) => i.active))
      setLocations(locResult.inventoryLocations)
      setError(null)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'failed to load movements'
      setError(message)
      toastError('Could not load movements', message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh re-uses filters in closure
  }, [companySlug, filterType, filterItem, filterProject])

  return (
    <section className="space-y-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Inventory movements</h2>
          <p className="text-sm text-slate-500">
            {movements.length} {movements.length === 1 ? 'movement' : 'movements'} · capped at 500
          </p>
        </div>
        <RecordMovementDialog
          companySlug={companySlug}
          items={items}
          locations={locations}
          projects={projects}
          onSaved={refresh}
        />
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as InventoryMovementRow['movement_type'] | '')}
          className="max-w-xs"
        >
          <option value="">All types</option>
          {MOVEMENT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
        <Select value={filterItem} onChange={(e) => setFilterItem(e.target.value)} className="max-w-xs">
          <option value="">All items</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.code} — {item.description}
            </option>
          ))}
        </Select>
        <Select value={filterProject} onChange={(e) => setFilterProject(e.target.value)} className="max-w-xs">
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setFilterType('')
            setFilterItem('')
            setFilterProject('')
          }}
        >
          Clear
        </Button>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</div>
      )}

      {loading && movements.length === 0 ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : movements.length === 0 ? (
        <p className="text-sm text-slate-500">No movements match this filter.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2">From</th>
                <th className="px-3 py-2">To</th>
                <th className="px-3 py-2">Project</th>
                <th className="px-3 py-2">Ticket</th>
                <th className="px-3 py-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m) => (
                <tr key={m.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-xs text-slate-600">{m.occurred_on}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${TYPE_BADGE[m.movement_type]}`}>
                      {m.movement_type}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-mono text-xs">{m.item_code ?? '—'}</div>
                    <div className="text-xs text-slate-500">{m.item_description ?? ''}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{m.quantity}</td>
                  <td className="px-3 py-2 text-xs">{m.from_location_name ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">{m.to_location_name ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">{m.project_name ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{m.ticket_number ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">{m.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

type RecordMovementDialogProps = {
  companySlug: string
  items: InventoryItemRow[]
  locations: InventoryLocationRow[]
  projects: ProjectRow[]
  onSaved: () => Promise<void> | void
}

function RecordMovementDialog({ companySlug, items, locations, projects, onSaved }: RecordMovementDialogProps) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState<CreateMovementInput>({
    inventory_item_id: '',
    movement_type: 'deliver',
    quantity: 1,
    occurred_on: todayISO(),
  })

  const yardLocations = useMemo(() => locations.filter((l) => l.location_type === 'yard'), [locations])
  const jobLocations = useMemo(() => locations.filter((l) => l.location_type === 'job'), [locations])

  // Defaults that flip with movement_type so the office gets sensible
  // from/to suggestions without thinking about location semantics.
  function setMovementType(type: InventoryMovementRow['movement_type']) {
    const yard = yardLocations.find((l) => l.is_default) ?? yardLocations[0]
    setForm((prev) => {
      const next = { ...prev, movement_type: type }
      if (type === 'deliver') {
        next.from_location_id = yard?.id ?? null
        next.to_location_id = prev.to_location_id ?? null
      } else if (type === 'return') {
        next.from_location_id = prev.from_location_id ?? null
        next.to_location_id = yard?.id ?? null
      }
      return next
    })
  }

  async function handleSubmit() {
    if (!form.inventory_item_id) return
    setSubmitting(true)
    try {
      await createInventoryMovement(form, companySlug)
      toastSuccess('Movement recorded')
      await onSaved()
      setOpen(false)
      setForm({
        inventory_item_id: '',
        movement_type: 'deliver',
        quantity: 1,
        occurred_on: todayISO(),
      })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'create failed'
      toastError('Failed to record movement', message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default">Record movement</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record inventory movement</DialogTitle>
          <DialogDescription>Log gear shipping out, coming back, or being transferred/lost.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span className="text-slate-700">Movement type</span>
            <Select
              value={form.movement_type}
              onChange={(e) => setMovementType(e.target.value as InventoryMovementRow['movement_type'])}
            >
              {MOVEMENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-slate-700">Item</span>
            <Select
              value={form.inventory_item_id}
              onChange={(e) => setForm({ ...form, inventory_item_id: e.target.value })}
            >
              <option value="">Select an item…</option>
              {items.map((item) => (
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
              <span className="text-slate-700">Date</span>
              <Input
                type="date"
                value={form.occurred_on ?? ''}
                onChange={(e) => setForm({ ...form, occurred_on: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">From</span>
              <Select
                value={form.from_location_id ?? ''}
                onChange={(e) => setForm({ ...form, from_location_id: e.target.value || null })}
              >
                <option value="">—</option>
                <optgroup label="Yard">
                  {yardLocations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Jobs">
                  {jobLocations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </optgroup>
              </Select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">To</span>
              <Select
                value={form.to_location_id ?? ''}
                onChange={(e) => setForm({ ...form, to_location_id: e.target.value || null })}
              >
                <option value="">—</option>
                <optgroup label="Yard">
                  {yardLocations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Jobs">
                  {jobLocations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </optgroup>
              </Select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Project</span>
              <Select
                value={form.project_id ?? ''}
                onChange={(e) => setForm({ ...form, project_id: e.target.value || null })}
              >
                <option value="">—</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Ticket #</span>
              <Input
                value={form.ticket_number ?? ''}
                onChange={(e) => setForm({ ...form, ticket_number: e.target.value })}
              />
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
            {submitting ? 'Recording…' : 'Record'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
