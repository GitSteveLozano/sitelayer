import { useEffect, useMemo, useState } from 'react'
import { Boxes, CircleDollarSign, PackageCheck, Plus, RefreshCw, Upload } from 'lucide-react'
import {
  createInventoryItem,
  deleteInventoryItem,
  importInventoryItems,
  listInventoryAvailability,
  listInventoryItems,
  updateInventoryItem,
  type InventoryAvailabilityRow,
  type InventoryImportResult,
  type InventoryItemInput,
  type InventoryItemRow,
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
 * Inventory catalog screen — closes the gap from Steve's PR #101 that the
 * rental-inventory replacement system left open. Backend already exposes
 * GET/POST/PATCH/DELETE /api/inventory/items and POST
 * /api/inventory/items/import; this view drives them.
 */

type InventoryViewProps = {
  companySlug: string
}

const TRACKING_MODES = [
  { value: 'quantity', label: 'Quantity' },
  { value: 'serialized', label: 'Serialized' },
] as const

function emptyInput(): InventoryItemInput {
  return {
    code: '',
    description: '',
    category: 'scaffold',
    unit: 'ea',
    default_rental_rate: '',
    replacement_value: '',
    tracking_mode: 'quantity',
    active: true,
    notes: '',
  }
}

function formatCurrency(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return String(value)
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num)
}

// Auto-detect column mapping from the first row of a CSV. Returns the canonical
// field for a given header, or null if no match.
const HEADER_MAP: Array<[RegExp, keyof InventoryItemInput]> = [
  [/^code|sku|part.?#?|item.?(code|number|id)$/i, 'code'],
  [/^description|name|item.?name$/i, 'description'],
  [/^category|cat$/i, 'category'],
  [/^unit|uom|measure$/i, 'unit'],
  [/^(default.?rental.?rate|rate|price|daily.?rate|rental.?rate)$/i, 'default_rental_rate'],
  [/^(replacement.?value|replacement|repl.?value|cost)$/i, 'replacement_value'],
  [/^(tracking.?mode|tracking|mode)$/i, 'tracking_mode'],
  [/^(active|enabled)$/i, 'active'],
  [/^notes?$/i, 'notes'],
]

function detectColumn(header: string): keyof InventoryItemInput | null {
  const trimmed = header.trim()
  for (const [pattern, field] of HEADER_MAP) {
    if (pattern.test(trimmed)) return field
  }
  return null
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  // Naive CSV parser — splits on newlines and commas, handles quoted fields
  // with embedded commas. Good enough for inventory imports; users with weird
  // data should sanitize externally.
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
  if (!lines.length) return { headers: [], rows: [] }
  const parseLine = (line: string): string[] => {
    const out: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (ch === '"' && line[i - 1] !== '\\') {
        inQuotes = !inQuotes
        continue
      }
      if (ch === ',' && !inQuotes) {
        out.push(current)
        current = ''
        continue
      }
      current += ch
    }
    out.push(current)
    return out.map((cell) => cell.trim().replace(/^"|"$/g, ''))
  }
  const headers = parseLine(lines[0]!)
  const rows = lines.slice(1).map(parseLine)
  return { headers, rows }
}

export function InventoryView({ companySlug }: InventoryViewProps) {
  const [items, setItems] = useState<InventoryItemRow[]>([])
  const [availability, setAvailability] = useState<Map<string, InventoryAvailabilityRow>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState<InventoryItemRow | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    try {
      const [itemsResult, availabilityResult] = await Promise.all([
        listInventoryItems(companySlug),
        listInventoryAvailability(companySlug),
      ])
      setItems(itemsResult.inventoryItems)
      const map = new Map<string, InventoryAvailabilityRow>()
      for (const row of availabilityResult.availability) map.set(row.inventory_item_id, row)
      setAvailability(map)
      setError(null)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'failed to load inventory'
      setError(message)
      toastError('Could not load inventory', message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is stable enough
  }, [companySlug])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const item of items) if (item.category) set.add(item.category)
    return Array.from(set).sort()
  }, [items])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((item) => {
      if (!showInactive && !item.active) return false
      if (categoryFilter && item.category !== categoryFilter) return false
      if (!q) return true
      return (
        item.code.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        (item.notes ?? '').toLowerCase().includes(q)
      )
    })
  }, [items, search, categoryFilter, showInactive])
  const inventoryStats = useMemo(() => {
    const active = items.filter((item) => item.active).length
    const onRent = Array.from(availability.values()).reduce((sum, row) => sum + Number(row.on_rent_quantity || 0), 0)
    const dailyRate = items.reduce((sum, item) => sum + Number(item.default_rental_rate || 0), 0)
    return { active, onRent, dailyRate }
  }, [availability, items])

  async function handleDelete(item: InventoryItemRow) {
    if (typeof window !== 'undefined' && !window.confirm(`Delete inventory item ${item.code}?`)) return
    setBusyId(item.id)
    try {
      await deleteInventoryItem(item.id, companySlug, item.version)
      toastSuccess(`Deleted ${item.code}`)
      await refresh()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'delete failed'
      toastError(`Failed to delete ${item.code}`, message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="inventoryPage">
      <section className="hero">
        <p className="eyebrow">Equipment catalog</p>
        <div className="inventoryHero">
          <div>
            <h1>Inventory</h1>
            <p className="lede compact">
              Maintain the rental catalog, pricing, replacement value, and availability that power internal billing and
              future storefront listings.
            </p>
          </div>
          <div className="inventoryHeroActions">
            <ImportDialog companySlug={companySlug} onImported={refresh} />
            <ItemDialog
              companySlug={companySlug}
              onSaved={refresh}
              triggerLabel="Add item"
              initialValue={emptyInput()}
              existing={null}
            />
          </div>
        </div>
      </section>

      <section className="rentalMetrics" aria-label="Inventory summary">
        <article>
          <Boxes aria-hidden="true" />
          <div>
            <span>Catalog items</span>
            <strong>{items.length}</strong>
          </div>
        </article>
        <article>
          <PackageCheck aria-hidden="true" />
          <div>
            <span>Active</span>
            <strong>{inventoryStats.active}</strong>
          </div>
        </article>
        <article>
          <PackageCheck aria-hidden="true" />
          <div>
            <span>On rent</span>
            <strong>{inventoryStats.onRent}</strong>
          </div>
        </article>
        <article>
          <CircleDollarSign aria-hidden="true" />
          <div>
            <span>Daily rate book</span>
            <strong>{formatCurrency(inventoryStats.dailyRate)}</strong>
          </div>
        </article>
      </section>

      <section className="panel inventoryControls">
        <Input
          placeholder="Search code, description, notes..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="max-w-xs">
          <option value="">All categories</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <Checkbox checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw aria-hidden="true" />
          {loading ? 'Refreshing...' : 'Refresh'}
        </Button>
      </section>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</div>
      )}

      {loading && items.length === 0 ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-slate-500">
          {items.length === 0 ? 'No inventory items yet — add one or import from CSV.' : 'No items match this filter.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Unit</th>
                <th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2 text-right">Replacement</th>
                <th className="px-3 py-2 text-right">On rent</th>
                <th className="px-3 py-2">Tracking</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-xs">{item.code}</td>
                  <td className="px-3 py-2">{item.description}</td>
                  <td className="px-3 py-2 text-slate-600">{item.category}</td>
                  <td className="px-3 py-2 text-slate-600">{item.unit}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(item.default_rental_rate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(item.replacement_value)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {(() => {
                      const a = availability.get(item.id)
                      if (!a) return <span className="text-slate-400">0</span>
                      return (
                        <span
                          title={`${a.on_rent_lines} line${a.on_rent_lines === 1 ? '' : 's'} across ${a.on_rent_projects} project${a.on_rent_projects === 1 ? '' : 's'}`}
                        >
                          {a.on_rent_quantity}
                        </span>
                      )
                    })()}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">{item.tracking_mode}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        item.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {item.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(item)}
                        disabled={busyId === item.id}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(item)}
                        disabled={busyId === item.id}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ItemDialog
          companySlug={companySlug}
          onSaved={async () => {
            setEditing(null)
            await refresh()
          }}
          triggerLabel=""
          initialValue={{
            code: editing.code,
            description: editing.description,
            category: editing.category,
            unit: editing.unit,
            default_rental_rate: editing.default_rental_rate,
            replacement_value: editing.replacement_value ?? '',
            tracking_mode: editing.tracking_mode,
            active: editing.active,
            notes: editing.notes ?? '',
          }}
          existing={editing}
          openImmediately
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  )
}

type ItemDialogProps = {
  companySlug: string
  onSaved: () => Promise<void> | void
  triggerLabel: string
  initialValue: InventoryItemInput
  existing: InventoryItemRow | null
  openImmediately?: boolean
  onClose?: () => void
}

function ItemDialog({
  companySlug,
  onSaved,
  triggerLabel,
  initialValue,
  existing,
  openImmediately,
  onClose,
}: ItemDialogProps) {
  const [open, setOpen] = useState(Boolean(openImmediately))
  const [form, setForm] = useState<InventoryItemInput>(initialValue)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) setForm(initialValue)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-init on open transition
  }, [open])

  function close() {
    setOpen(false)
    onClose?.()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      if (existing) {
        await updateInventoryItem(existing.id, { ...form, expected_version: existing.version }, companySlug)
        toastSuccess(`Updated ${form.code}`)
      } else {
        await createInventoryItem(form, companySlug)
        toastSuccess(`Created ${form.code}`)
      }
      await onSaved()
      close()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'save failed'
      toastError(existing ? 'Update failed' : 'Create failed', message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {triggerLabel && (
        <DialogTrigger asChild>
          <Button variant="default">
            <Plus aria-hidden="true" />
            {triggerLabel}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{existing ? `Edit ${existing.code}` : 'Add inventory item'}</DialogTitle>
            <DialogDescription>
              {existing ? 'Update the catalog entry.' : 'Add a new SKU to the rental catalog.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Code</span>
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                required
                disabled={Boolean(existing)}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Description</span>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                required
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Category</span>
              <Input value={form.category ?? ''} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Unit</span>
              <Input value={form.unit ?? ''} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Default rental rate</span>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={String(form.default_rental_rate ?? '')}
                onChange={(e) => setForm({ ...form, default_rental_rate: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Replacement value</span>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={String(form.replacement_value ?? '')}
                onChange={(e) => setForm({ ...form, replacement_value: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Tracking mode</span>
              <Select
                value={form.tracking_mode ?? 'quantity'}
                onChange={(e) => setForm({ ...form, tracking_mode: e.target.value as 'quantity' | 'serialized' })}
              >
                {TRACKING_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {mode.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700 sm:mt-6">
              <Checkbox
                checked={Boolean(form.active)}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />
              Active
            </label>
          </div>
          <label className="space-y-1 text-sm">
            <span className="text-slate-700">Notes</span>
            <Textarea value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={3} />
          </label>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={close} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="default" type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : existing ? 'Save changes' : 'Create item'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

type ImportDialogProps = {
  companySlug: string
  onImported: () => Promise<void> | void
}

function ImportDialog({ companySlug, onImported }: ImportDialogProps) {
  const [open, setOpen] = useState(false)
  const [csvText, setCsvText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<InventoryImportResult | null>(null)

  const preview = useMemo(() => {
    if (!csvText.trim()) return { headers: [], rows: [], detected: [] as Array<keyof InventoryItemInput | null> }
    const { headers, rows } = parseCsv(csvText)
    const detected = headers.map((h) => detectColumn(h))
    return { headers, rows: rows.slice(0, 5), detected, totalRows: rows.length }
  }, [csvText])

  async function handleSubmit() {
    if (!csvText.trim()) return
    setSubmitting(true)
    setResult(null)
    try {
      const { headers, rows } = parseCsv(csvText)
      const detected = headers.map((h) => detectColumn(h))
      const items: InventoryItemInput[] = []
      for (const row of rows) {
        const item: InventoryItemInput = { code: '', description: '' }
        headers.forEach((_, i) => {
          const field = detected[i]
          const cell = row[i] ?? ''
          if (!field) return
          if (field === 'active') {
            const lower = cell.trim().toLowerCase()
            ;(item as Record<string, unknown>)[field] =
              lower !== '' && lower !== 'false' && lower !== '0' && lower !== 'no'
          } else {
            ;(item as Record<string, unknown>)[field] = cell
          }
        })
        if (item.code && item.description) items.push(item)
      }
      if (items.length === 0) {
        toastError('Nothing to import', 'No rows had both code and description filled in.')
        return
      }
      const r = await importInventoryItems(items, companySlug)
      setResult(r)
      toastSuccess(`Imported: ${r.inserted} new, ${r.updated} updated, ${r.errors.length} errors`)
      await onImported()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'import failed'
      toastError('Import failed', message)
    } finally {
      setSubmitting(false)
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      setCsvText(text)
      setResult(null)
    }
    reader.readAsText(file)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload aria-hidden="true" />
          Import CSV
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import inventory from CSV</DialogTitle>
          <DialogDescription>
            Headers are auto-detected (code, description, category, unit, rate, replacement, tracking, active, notes).
            Existing items match by code and update in place; new codes insert.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input type="file" accept=".csv,text/csv" onChange={handleFile} />
          <Textarea
            placeholder="…or paste CSV text directly"
            rows={8}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            className="font-mono text-xs"
          />
          {preview.headers.length > 0 && (
            <div className="space-y-2 text-xs">
              <div>
                <strong>{preview.totalRows ?? 0}</strong> data rows detected. Showing first {preview.rows.length}:
              </div>
              <div className="overflow-x-auto rounded border">
                <table className="w-full">
                  <thead className="bg-slate-100">
                    <tr>
                      {preview.headers.map((h, i) => (
                        <th key={i} className="px-2 py-1 text-left">
                          <div className="font-medium">{h}</div>
                          <div className={preview.detected[i] ? 'text-emerald-700' : 'text-amber-700'}>
                            → {preview.detected[i] ?? '(skipped)'}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, ri) => (
                      <tr key={ri} className="border-t">
                        {row.map((cell, ci) => (
                          <td key={ci} className="px-2 py-1">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {result && (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              <p>
                Inserted <strong>{result.inserted}</strong> · Updated <strong>{result.updated}</strong> · Skipped{' '}
                <strong>{result.errors.length}</strong> · Total <strong>{result.total}</strong>
              </p>
              {result.errors.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer">Show errors</summary>
                  <ul className="mt-1 list-disc pl-5 font-mono text-xs">
                    {result.errors.slice(0, 20).map((err) => (
                      <li key={err.index}>
                        Row {err.index + 1} ({err.code ?? '?'}): {err.error}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => setOpen(false)} disabled={submitting}>
            Close
          </Button>
          <Button variant="default" type="button" onClick={handleSubmit} disabled={submitting || !csvText.trim()}>
            {submitting ? 'Importing…' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
