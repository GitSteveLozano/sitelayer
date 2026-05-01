import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet } from '@/components/mobile'
import {
  useDispatchMovement,
  useInventoryItems,
  useInventoryLocations,
  useInventoryMovements,
  useProjects,
  type InventoryMovement,
} from '@/lib/api'

const TYPES: ReadonlyArray<InventoryMovement['movement_type']> = [
  'deliver',
  'return',
  'transfer',
  'adjustment',
  'damage',
  'loss',
]

const TONE_BY_TYPE: Record<InventoryMovement['movement_type'], 'good' | 'warn' | 'default'> = {
  deliver: 'good',
  return: 'default',
  transfer: 'default',
  adjustment: 'default',
  damage: 'warn',
  loss: 'warn',
}

export function InventoryMovementsAdminScreen() {
  const [filterType, setFilterType] = useState<InventoryMovement['movement_type'] | 'all'>('all')
  const movements = useInventoryMovements(filterType === 'all' ? {} : { type: filterType })
  const [recording, setRecording] = useState(false)
  const rows = movements.data?.inventoryMovements ?? []

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more/inventory" className="text-[12px] text-ink-3">
        ← Inventory admin
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">Movements</h1>
          <p className="text-[12px] text-ink-3 mt-1">{rows.length} in this slice</p>
        </div>
        <MobileButton variant="primary" onClick={() => setRecording(true)}>
          + Record
        </MobileButton>
      </div>

      <div className="mt-4 flex gap-1.5 overflow-x-auto scrollbar-hide pb-2">
        {(['all', ...TYPES] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setFilterType(t)}
            className={`px-3 py-1.5 rounded-full text-[12px] font-medium border shrink-0 ${
              filterType === t ? 'bg-accent text-white border-transparent' : 'bg-card-soft text-ink-2 border-line'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-2 space-y-2">
        {movements.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : rows.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No movements in this slice.</div>
          </Card>
        ) : (
          rows.map((m) => (
            <Card key={m.id} tight>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold truncate">
                    {m.item_code ?? m.inventory_item_id} · {Number(m.quantity).toFixed(0)}
                  </div>
                  <div className="text-[11px] text-ink-3 mt-0.5 truncate">
                    {m.from_location_name ?? '—'} → {m.to_location_name ?? '—'}
                    {m.project_name ? ` · ${m.project_name}` : ''} · {m.occurred_on}
                  </div>
                  {m.scanned_at ? (
                    <div className="text-[11px] text-ink-3 mt-0.5">
                      scan{' '}
                      {new Date(m.scanned_at).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </div>
                  ) : null}
                </div>
                <Pill tone={TONE_BY_TYPE[m.movement_type] ?? 'default'}>{m.movement_type}</Pill>
              </div>
            </Card>
          ))
        )}
      </div>

      {recording ? <RecordSheet onClose={() => setRecording(false)} /> : null}
    </div>
  )
}

function RecordSheet({ onClose }: { onClose: () => void }) {
  const items = useInventoryItems()
  const locations = useInventoryLocations()
  const projects = useProjects()
  const dispatch = useDispatchMovement()

  const [itemId, setItemId] = useState<string>('')
  const [quantity, setQuantity] = useState<string>('1')
  const [type, setType] = useState<InventoryMovement['movement_type']>('deliver')
  const [from, setFrom] = useState<string>('')
  const [to, setTo] = useState<string>('')
  const [projectId, setProjectId] = useState<string>('')
  const [notes, setNotes] = useState<string>('')
  const [ticket, setTicket] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    try {
      await dispatch.mutateAsync({
        inventory_item_id: itemId,
        quantity: Number(quantity),
        movement_type: type,
        from_location_id: from || null,
        to_location_id: to || null,
        project_id: projectId || null,
        ticket_number: ticket || null,
        notes: notes || null,
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const canSubmit = Boolean(itemId) && Number(quantity) > 0 && !dispatch.isPending

  return (
    <Sheet open onClose={onClose} title="Record movement">
      <div className="space-y-3">
        <Select
          label="Item"
          value={itemId}
          onChange={setItemId}
          options={[
            { value: '', label: 'Pick an item…' },
            ...((items.data?.inventoryItems ?? []).map((it) => ({
              value: it.id,
              label: `${it.code} — ${it.description}`,
            })) ?? []),
          ]}
        />
        <Field label="Quantity" value={quantity} onChange={setQuantity} placeholder="1" />
        <Select
          label="Type"
          value={type}
          onChange={(v) => setType(v as InventoryMovement['movement_type'])}
          options={TYPES.map((t) => ({ value: t, label: t }))}
        />
        <Select
          label="From location"
          value={from}
          onChange={setFrom}
          options={[
            { value: '', label: 'None — new receipt' },
            ...(locations.data?.inventoryLocations ?? []).map((l) => ({ value: l.id, label: l.name })),
          ]}
        />
        <Select
          label="To location"
          value={to}
          onChange={setTo}
          options={[
            { value: '', label: 'None — return to supplier / write-off' },
            ...(locations.data?.inventoryLocations ?? []).map((l) => ({ value: l.id, label: l.name })),
          ]}
        />
        <Select
          label="Project (optional)"
          value={projectId}
          onChange={setProjectId}
          options={[
            { value: '', label: 'No project' },
            ...(projects.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        <Field label="Ticket # (optional)" value={ticket} onChange={setTicket} placeholder="DELV-1234" />
        <Field label="Notes (optional)" value={notes} onChange={setNotes} placeholder="" />
        {error ? <div className="text-[12px] text-status-warn">{error}</div> : null}
        <MobileButton variant="primary" onClick={submit} disabled={!canSubmit}>
          {dispatch.isPending ? 'Recording…' : 'Record movement'}
        </MobileButton>
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
  options: ReadonlyArray<{ value: string; label: string }>
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
          <option key={o.value || '_'} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
