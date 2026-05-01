import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet } from '@/components/mobile'
import {
  useCreateInventoryItem,
  useDeleteInventoryItem,
  useInventoryItems,
  usePatchInventoryItem,
  type InventoryItem,
} from '@/lib/api'

const CATEGORIES = ['scaffold', 'shoring', 'forming', 'tooling', 'safety', 'other']
const UNITS = ['ea', 'set', 'lf', 'sqft', 'cu yd', 'day']
const TRACKING = ['quantity', 'serial']

export function InventoryItemsAdminScreen() {
  const items = useInventoryItems()
  const create = useCreateInventoryItem()
  const [editing, setEditing] = useState<InventoryItem | 'new' | null>(null)
  const rows = items.data?.inventoryItems ?? []

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more/inventory" className="text-[12px] text-ink-3">
        ← Inventory admin
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">Items</h1>
          <p className="text-[12px] text-ink-3 mt-1">{rows.length} active</p>
        </div>
        <MobileButton variant="primary" onClick={() => setEditing('new')}>
          + New
        </MobileButton>
      </div>

      <div className="mt-6 space-y-2">
        {items.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : rows.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No items yet.</div>
          </Card>
        ) : (
          rows.map((it) => (
            <button key={it.id} type="button" onClick={() => setEditing(it)} className="block w-full text-left">
              <Card tight>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold truncate">
                      {it.code} · {it.description}
                    </div>
                    <div className="text-[11px] text-ink-3 mt-0.5">
                      {it.category} · ${Number(it.default_rental_rate).toFixed(2)}/{it.unit} · {it.tracking_mode}
                    </div>
                  </div>
                  <Pill tone={it.active ? 'good' : 'default'}>{it.active ? 'active' : 'inactive'}</Pill>
                </div>
              </Card>
            </button>
          ))
        )}
      </div>

      {editing !== null ? (
        <ItemForm
          key={editing === 'new' ? 'new' : editing.id}
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreate={async (input) => {
            await create.mutateAsync(input)
            setEditing(null)
          }}
        />
      ) : null}
    </div>
  )
}

function ItemForm({
  item,
  onClose,
  onCreate,
}: {
  item: InventoryItem | null
  onClose: () => void
  onCreate: (input: {
    code: string
    description: string
    category?: string
    unit?: string
    default_rental_rate?: number
    replacement_value?: number | null
    tracking_mode?: string
    active?: boolean
  }) => Promise<void>
}) {
  const patch = usePatchInventoryItem(item?.id ?? '')
  const del = useDeleteInventoryItem()
  const [code, setCode] = useState(item?.code ?? '')
  const [description, setDescription] = useState(item?.description ?? '')
  const [category, setCategory] = useState(item?.category ?? 'scaffold')
  const [unit, setUnit] = useState(item?.unit ?? 'ea')
  const [rate, setRate] = useState(item?.default_rental_rate ?? '0')
  const [replacement, setReplacement] = useState(item?.replacement_value ?? '')
  const [tracking, setTracking] = useState(item?.tracking_mode ?? 'quantity')
  const [active, setActive] = useState(item?.active ?? true)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    try {
      const rateNum = Number(rate)
      const replNum = replacement === '' || replacement === null ? null : Number(replacement)
      if (!item) {
        await onCreate({
          code: code.trim(),
          description: description.trim(),
          category,
          unit,
          default_rental_rate: rateNum,
          replacement_value: replNum,
          tracking_mode: tracking,
          active,
        })
      } else {
        await patch.mutateAsync({
          code: code.trim(),
          description: description.trim(),
          category,
          unit,
          default_rental_rate: rateNum,
          replacement_value: replNum,
          tracking_mode: tracking,
          active,
          expected_version: item.version,
        })
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const remove = async () => {
    if (!item) return
    if (typeof window !== 'undefined' && !window.confirm(`Delete "${item.code}"?`)) return
    try {
      await del.mutateAsync({ id: item.id, expected_version: item.version })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <Sheet open onClose={onClose} title={item ? 'Edit item' : 'New item'}>
      <div className="space-y-3">
        <Field label="Code" value={code} onChange={setCode} placeholder="CUP-LOCK-FRAME" />
        <Field label="Description" value={description} onChange={setDescription} placeholder="Cup-lock frame 5'x7'" />
        <Select label="Category" value={category} onChange={setCategory} options={CATEGORIES} />
        <Select label="Unit" value={unit} onChange={setUnit} options={UNITS} />
        <Field label="Default rental rate ($/unit/day)" value={String(rate)} onChange={setRate} placeholder="2.50" />
        <Field
          label="Replacement value ($)"
          value={String(replacement ?? '')}
          onChange={setReplacement}
          placeholder="120.00"
        />
        <Select label="Tracking mode" value={tracking} onChange={setTracking} options={TRACKING} />
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="rounded" />
          <span className="text-[13px]">Active (eligible for rental)</span>
        </label>
        {error ? <div className="text-[12px] text-status-warn">{error}</div> : null}
        <div className={item ? 'grid grid-cols-2 gap-2' : ''}>
          <MobileButton
            variant="primary"
            onClick={submit}
            disabled={!code.trim() || !description.trim() || patch.isPending}
          >
            {item ? 'Save' : 'Create'}
          </MobileButton>
          {item ? (
            <MobileButton variant="ghost" onClick={remove} disabled={del.isPending}>
              Delete
            </MobileButton>
          ) : null}
        </div>
      </div>
    </Sheet>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <label className="block">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full text-[15px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
      />
    </label>
  )
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: readonly string[]
}) {
  return (
    <label className="block">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}
