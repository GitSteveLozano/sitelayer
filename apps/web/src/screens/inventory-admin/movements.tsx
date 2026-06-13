import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  MBody,
  MButton,
  MChip,
  MChipRow,
  MI,
  MInput,
  MListPlain,
  MListRow,
  MPill,
  MSelect,
  MTopBar,
  type MTone,
} from '@/components/m'
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
  'damaged',
  'lost',
  'repair',
]

const TONE_BY_TYPE: Record<InventoryMovement['movement_type'], MTone | undefined> = {
  deliver: 'green',
  return: undefined,
  transfer: undefined,
  adjustment: undefined,
  damaged: 'amber',
  lost: 'amber',
  repair: 'amber',
}

export function InventoryMovementsAdminScreen() {
  const [filterType, setFilterType] = useState<InventoryMovement['movement_type'] | 'all'>('all')
  const movements = useInventoryMovements(filterType === 'all' ? {} : { type: filterType })
  const [recording, setRecording] = useState(false)
  const rows = movements.data?.inventoryMovements ?? []
  const navigate = useNavigate()

  return (
    <>
      <MTopBar
        back
        eyebrow="Inventory admin"
        title="Movements"
        sub={`${rows.length} in this slice`}
        actionLabel="Record movement"
        actionIcon={<span style={{ fontSize: 22, fontWeight: 800 }}>+</span>}
        onBack={() => navigate('/more/inventory')}
        onAction={() => setRecording(true)}
      />
      <MBody>
        <MChipRow>
          {(['all', ...TYPES] as const).map((t) => (
            <MChip key={t} active={filterType === t} outline onClick={() => setFilterType(t)}>
              {t}
            </MChip>
          ))}
        </MChipRow>

        {movements.isPending ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            No movements in this slice.
          </div>
        ) : (
          <MListPlain>
            {rows.map((m) => (
              <MListRow
                key={m.id}
                headline={`${m.item_code ?? m.inventory_item_id} · ${Number(m.quantity).toFixed(0)}`}
                supporting={
                  <>
                    {m.from_location_name ?? '—'} → {m.to_location_name ?? '—'}
                    {m.project_name ? ` · ${m.project_name}` : ''} · {m.occurred_on}
                    {m.scanned_at ? (
                      <>
                        <br />
                        scan{' '}
                        {new Date(m.scanned_at).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </>
                    ) : null}
                  </>
                }
                trailing={<MPill tone={TONE_BY_TYPE[m.movement_type]}>{m.movement_type}</MPill>}
              />
            ))}
          </MListPlain>
        )}
      </MBody>

      {recording ? <RecordSheet onClose={() => setRecording(false)} /> : null}
    </>
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
    <MSheet title="Record movement" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 16 }}>
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
        {error ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
        <MButton variant="primary" onClick={submit} disabled={!canSubmit}>
          {dispatch.isPending ? 'Recording…' : 'Record movement'}
        </MButton>
      </div>
    </MSheet>
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
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="m-topbar-eyebrow">{label}</span>
      <MInput value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
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
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="m-topbar-eyebrow">{label}</span>
      <MSelect value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value || '_'} value={o.value}>
            {o.label}
          </option>
        ))}
      </MSelect>
    </label>
  )
}
