import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  listInventory,
  listInventoryAvailability,
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  importInventoryItems,
  type InventoryItemRow,
  type InventoryAvailRow,
  type CreateInventoryInput,
  type SessionResponse,
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

type InventoryViewProps = {
  companySlug: string
  session: SessionResponse | null
}

const CATEGORIES = ['Scaffolding', 'Frames', 'Braces', 'Planks', 'Accessories', 'Safety', 'Other']

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

export function InventoryView({ companySlug }: InventoryViewProps) {
  const [items, setItems] = useState<InventoryItemRow[]>([])
  const [availability, setAvailability] = useState<InventoryAvailRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [itemsRes, availRes] = await Promise.all([
        listInventory(companySlug),
        listInventoryAvailability(companySlug),
      ])
      setItems(itemsRes.items ?? [])
      setAvailability(availRes.items ?? [])
    } catch (e: unknown) {
      toastError(`Failed to load inventory: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
    setLoading(false)
  }, [companySlug])

  useEffect(() => { load() }, [load])

  const availMap = useMemo(
    () => Object.fromEntries(availability.map(a => [a.item_id, a])),
    [availability],
  )

  const filtered = useMemo(() => {
    return items.filter(i => {
      if (catFilter && i.category !== catFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return i.part_number.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)
      }
      return true
    })
  }, [items, search, catFilter])

  const categories = useMemo(() => {
    const cats = new Set(items.map(i => i.category).filter(Boolean))
    return [...cats].sort()
  }, [items])

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Inventory</h1>
          <p className="text-sm text-muted-foreground mt-1">{items.length} items in catalog</p>
        </div>
        <div className="flex gap-2">
          <ImportDialog companySlug={companySlug} onImported={load} />
          <AddItemDialog companySlug={companySlug} onCreated={load} />
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <Input
          placeholder="Search parts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-48"
        />
        <Button variant={catFilter === '' ? 'default' : 'outline'} size="sm" onClick={() => setCatFilter('')}>
          All
        </Button>
        {(categories.length > 0 ? categories : CATEGORIES).map(c => (
          <Button
            key={c}
            variant={catFilter === c ? 'default' : 'outline'}
            size="sm"
            onClick={() => setCatFilter(catFilter === c ? '' : c!)}
          >
            {c}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-16 text-muted-foreground">Loading inventory...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 border rounded-lg">
          <div className="text-4xl mb-4">📦</div>
          <p className="font-medium mb-2">No inventory items yet</p>
          <p className="text-sm text-muted-foreground mb-4">Add items manually or import from CSV</p>
          <AddItemDialog companySlug={companySlug} onCreated={load} />
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3 font-medium text-muted-foreground text-xs uppercase">Part #</th>
                <th className="text-left p-3 font-medium text-muted-foreground text-xs uppercase">Name</th>
                <th className="text-left p-3 font-medium text-muted-foreground text-xs uppercase">Category</th>
                <th className="text-right p-3 font-medium text-muted-foreground text-xs uppercase">25-Day</th>
                <th className="text-right p-3 font-medium text-muted-foreground text-xs uppercase">Daily</th>
                <th className="text-right p-3 font-medium text-muted-foreground text-xs uppercase">Stock</th>
                <th className="text-right p-3 font-medium text-muted-foreground text-xs uppercase">Available</th>
                <th className="text-right p-3 font-medium text-muted-foreground text-xs uppercase"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => (
                <ItemRow
                  key={item.id}
                  item={item}
                  avail={availMap[item.id]}
                  editing={editingId === item.id}
                  onEdit={() => setEditingId(editingId === item.id ? null : item.id)}
                  companySlug={companySlug}
                  onRefresh={() => { setEditingId(null); load() }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ItemRow({ item, avail, editing, onEdit, companySlug, onRefresh }: {
  item: InventoryItemRow
  avail?: InventoryAvailRow
  editing: boolean
  onEdit: () => void
  companySlug: string
  onRefresh: () => void
}) {
  const [vals, setVals] = useState({ ...item })
  const [saving, setSaving] = useState(false)

  const qtyOnRent = avail?.qty_on_rent ?? 0
  const qtyAvail = avail?.qty_available ?? item.total_stock

  async function handleSave() {
    setSaving(true)
    try {
      await updateInventoryItem(item.id, {
        name: vals.name,
        category: vals.category,
        rate_25day: Number(vals.rate_25day) || 0,
        rate_daily: Number(vals.rate_daily) || 0,
        rate_weekly: Number(vals.rate_weekly) || 0,
        replacement_cost: Number(vals.replacement_cost) || 0,
        total_stock: Number(vals.total_stock) || 0,
        expected_version: item.version,
      }, companySlug)
      toastSuccess('Item updated')
      onRefresh()
    } catch (e: unknown) {
      toastError(`Update failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
    setSaving(false)
  }

  async function handleDelete() {
    if (!confirm(`Delete ${item.part_number}?`)) return
    try {
      await deleteInventoryItem(item.id, companySlug)
      toastSuccess('Item deleted')
      onRefresh()
    } catch (e: unknown) {
      toastError(`Delete failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
  }

  if (editing) {
    return (
      <tr className="border-b bg-muted/30">
        <td className="p-3 font-mono font-medium">{item.part_number}</td>
        <td className="p-3">
          <Input value={vals.name} onChange={e => setVals(v => ({ ...v, name: e.target.value }))} className="h-8" />
        </td>
        <td className="p-3">
          <Select value={vals.category || ''} onChange={e => setVals(v => ({ ...v, category: e.target.value || null }))}>
            <option value="">—</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </Select>
        </td>
        <td className="p-3"><Input type="number" value={vals.rate_25day} onChange={e => setVals(v => ({ ...v, rate_25day: Number(e.target.value) }))} className="h-8 w-20 text-right" /></td>
        <td className="p-3"><Input type="number" value={vals.rate_daily} onChange={e => setVals(v => ({ ...v, rate_daily: Number(e.target.value) }))} className="h-8 w-20 text-right" /></td>
        <td className="p-3"><Input type="number" value={vals.total_stock} onChange={e => setVals(v => ({ ...v, total_stock: Number(e.target.value) }))} className="h-8 w-20 text-right" /></td>
        <td className="p-3 text-right tabular-nums">{qtyAvail}</td>
        <td className="p-3 text-right">
          <div className="flex gap-1 justify-end">
            <Button size="sm" variant="ghost" onClick={handleSave} disabled={saving}>Save</Button>
            <Button size="sm" variant="ghost" onClick={onEdit}>Cancel</Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={handleDelete}>Delete</Button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr className="border-b hover:bg-muted/20">
      <td className="p-3 font-mono font-medium">{item.part_number}</td>
      <td className="p-3">{item.name}</td>
      <td className="p-3 text-muted-foreground text-xs">{item.category || '—'}</td>
      <td className="p-3 text-right tabular-nums">{formatCurrency(item.rate_25day)}</td>
      <td className="p-3 text-right tabular-nums text-muted-foreground text-xs">{formatCurrency(item.rate_daily)}</td>
      <td className="p-3 text-right tabular-nums">{item.total_stock}</td>
      <td className="p-3 text-right tabular-nums">
        <span className={qtyAvail > 0 ? 'text-green-500' : qtyOnRent > 0 ? 'text-amber-500' : 'text-muted-foreground'}>
          {qtyAvail}
        </span>
        {qtyOnRent > 0 && <span className="text-xs text-muted-foreground ml-1">({qtyOnRent} out)</span>}
      </td>
      <td className="p-3 text-right">
        <Button size="sm" variant="ghost" onClick={onEdit}>Edit</Button>
      </td>
    </tr>
  )
}

function AddItemDialog({ companySlug, onCreated }: { companySlug: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<CreateInventoryInput>({
    part_number: '', name: '', category: '', unit: 'ea',
    rate_25day: 0, rate_daily: 0, rate_weekly: 0, replacement_cost: 0, total_stock: 0,
  })

  const set = (k: keyof CreateInventoryInput, v: unknown) => setForm(f => ({ ...f, [k]: v }))

  async function handleSubmit() {
    if (!form.part_number || !form.name) { toastError('Part # and Name required'); return }
    setSaving(true)
    try {
      await createInventoryItem(form, companySlug)
      toastSuccess('Item added')
      setOpen(false)
      setForm({ part_number: '', name: '', category: '', unit: 'ea', rate_25day: 0, rate_daily: 0, rate_weekly: 0, replacement_cost: 0, total_stock: 0 })
      onCreated()
    } catch (e: unknown) {
      toastError(`Failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
    setSaving(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>+ Add Item</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Inventory Item</DialogTitle>
          <DialogDescription>Add a new item to your rental catalog.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder="Part # (e.g. SC-001)" value={form.part_number} onChange={e => set('part_number', e.target.value)} />
            <Input placeholder="Name (e.g. 6ft Frame)" value={form.name} onChange={e => set('name', e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select value={form.category || ''} onChange={e => set('category', e.target.value)}>
              <option value="">Category</option>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </Select>
            <Input type="number" placeholder="Stock qty" value={form.total_stock || ''} onChange={e => set('total_stock', Number(e.target.value))} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Input type="number" placeholder="25-Day Rate" value={form.rate_25day || ''} onChange={e => set('rate_25day', Number(e.target.value))} />
            <Input type="number" placeholder="Daily Rate" value={form.rate_daily || ''} onChange={e => set('rate_daily', Number(e.target.value))} />
            <Input type="number" placeholder="Weekly Rate" value={form.rate_weekly || ''} onChange={e => set('rate_weekly', Number(e.target.value))} />
          </div>
          <Input type="number" placeholder="Replacement Cost" value={form.replacement_cost || ''} onChange={e => set('replacement_cost', Number(e.target.value))} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={saving}>{saving ? 'Saving...' : 'Add Item'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ImportDialog({ companySlug, onImported }: { companySlug: string; onImported: () => void }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<CreateInventoryInput[] | null>(null)
  const [importing, setImporting] = useState(false)

  function handleFile(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string
        const lines = text.split('\n').filter(l => l.trim())
        if (lines.length < 2) { toastError('CSV needs a header + at least one data row'); return }
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
        const parsed = lines.slice(1).map(line => {
          const cols = line.split(',').map(c => c.trim())
          const row: Record<string, string> = {}
          headers.forEach((h, i) => { row[h] = cols[i] || '' })
          return {
            part_number: row['part number'] || row['part#'] || row['sku'] || row['part_number'] || '',
            name: row['name'] || row['item'] || row['description'] || '',
            category: row['category'] || row['type'] || undefined,
            rate_25day: parseFloat(row['25-day rate'] || row['rate'] || row['rate_25day'] || '0') || 0,
            rate_daily: parseFloat(row['daily rate'] || row['rate_daily'] || '0') || 0,
            replacement_cost: parseFloat(row['replacement cost'] || row['cost'] || '0') || 0,
            total_stock: parseInt(row['qty'] || row['stock'] || row['on hand'] || '0') || 0,
          } satisfies CreateInventoryInput
        }).filter(r => r.part_number && r.name)
        setRows(parsed)
      } catch {
        toastError('Could not parse CSV file')
      }
    }
    reader.readAsText(file)
  }

  async function handleImport() {
    if (!rows?.length) return
    setImporting(true)
    try {
      const result = await importInventoryItems(rows, companySlug)
      toastSuccess(`Imported ${result.imported} items`)
      setOpen(false)
      setRows(null)
      onImported()
    } catch (e: unknown) {
      toastError(`Import failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
    setImporting(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setRows(null) }}>
      <DialogTrigger asChild>
        <Button variant="outline">Import CSV</Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import Inventory from CSV</DialogTitle>
          <DialogDescription>
            CSV columns: Part Number, Name, Category, 25-Day Rate, Daily Rate, Replacement Cost, Qty
          </DialogDescription>
        </DialogHeader>

        {!rows ? (
          <label className="block cursor-pointer border-2 border-dashed rounded-lg p-8 text-center hover:border-primary/50 transition-colors">
            <p className="font-medium text-primary mb-1">Choose CSV file</p>
            <p className="text-xs text-muted-foreground">or drag and drop</p>
            <input type="file" accept=".csv" className="hidden" onChange={e => handleFile(e.target.files?.[0])} />
          </label>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{rows.length} items found:</p>
            <div className="max-h-64 overflow-auto border rounded text-xs">
              <table className="w-full">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    {['Part #', 'Name', 'Category', '25-Day', 'Stock'].map(h => (
                      <th key={h} className="text-left p-2 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 50).map((r, i) => (
                    <tr key={i} className="border-b">
                      <td className="p-2 font-mono">{r.part_number}</td>
                      <td className="p-2">{r.name}</td>
                      <td className="p-2 text-muted-foreground">{r.category || '—'}</td>
                      <td className="p-2 tabular-nums">${r.rate_25day.toFixed(2)}</td>
                      <td className="p-2 tabular-nums">{r.total_stock}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => { setOpen(false); setRows(null) }}>Cancel</Button>
          {rows && (
            <Button onClick={handleImport} disabled={importing}>
              {importing ? 'Importing...' : `Import ${rows.length} Items`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
