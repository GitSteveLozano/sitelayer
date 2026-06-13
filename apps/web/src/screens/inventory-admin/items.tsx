import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBody, MButton, MButtonRow, MI, MInput, MListPlain, MListRow, MPill, MSelect, MTopBar } from '@/components/m'
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
  const navigate = useNavigate()

  return (
    <>
      <MTopBar
        back
        eyebrow="Inventory admin"
        title="Items"
        sub={`${rows.length} active`}
        actionLabel="New item"
        actionIcon={<span style={{ fontSize: 22, fontWeight: 800 }}>+</span>}
        onBack={() => navigate('/more/inventory')}
        onAction={() => setEditing('new')}
      />
      <MBody>
        {items.isPending ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            No items yet.
          </div>
        ) : (
          <MListPlain>
            {rows.map((it) => (
              <MListRow
                key={it.id}
                headline={`${it.code} · ${it.description}`}
                supporting={`${it.category} · $${Number(it.default_rental_rate).toFixed(2)}/${it.unit} · ${it.tracking_mode}`}
                trailing={<MPill tone={it.active ? 'green' : undefined}>{it.active ? 'active' : 'inactive'}</MPill>}
                onTap={() => setEditing(it)}
              />
            ))}
          </MListPlain>
        )}
      </MBody>

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
    </>
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
  const [confirmNode, askConfirm] = useMConfirm()
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
    const ok = await askConfirm({
      title: 'Delete inventory item?',
      body: `Permanently remove "${item.code}".`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await del.mutateAsync({ id: item.id, expected_version: item.version })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <MSheet title={item ? 'Edit item' : 'New item'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 16 }}>
        <Field label="Code">
          <MInput value={code} onChange={(e) => setCode(e.target.value)} placeholder="CUP-LOCK-FRAME" />
        </Field>
        <Field label="Description">
          <MInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Cup-lock frame 5'x7'"
          />
        </Field>
        <Field label="Category">
          <MSelect value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </MSelect>
        </Field>
        <Field label="Unit">
          <MSelect value={unit} onChange={(e) => setUnit(e.target.value)}>
            {UNITS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </MSelect>
        </Field>
        <Field label="Default rental rate ($/unit/day)">
          <MInput value={String(rate)} onChange={(e) => setRate(e.target.value)} placeholder="2.50" />
        </Field>
        <Field label="Replacement value ($)">
          <MInput
            value={String(replacement ?? '')}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="120.00"
          />
        </Field>
        <Field label="Tracking mode">
          <MSelect value={tracking} onChange={(e) => setTracking(e.target.value)}>
            {TRACKING.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </MSelect>
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>Active (eligible for rental)</span>
        </label>
        {error ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
        {item ? (
          <MButtonRow>
            <MButton
              variant="primary"
              onClick={submit}
              disabled={!code.trim() || !description.trim() || patch.isPending}
            >
              Save
            </MButton>
            <MButton
              variant="ghost"
              onClick={remove}
              disabled={del.isPending}
              style={{ color: 'var(--m-red)', borderColor: 'var(--m-red)' }}
            >
              Delete
            </MButton>
          </MButtonRow>
        ) : (
          <MButton variant="primary" onClick={submit} disabled={!code.trim() || !description.trim() || patch.isPending}>
            Create
          </MButton>
        )}
      </div>
      {confirmNode}
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="m-topbar-eyebrow">{label}</span>
      {children}
    </label>
  )
}

/**
 * `.m-sheet` replacement for the legacy `useConfirmSheet` hook — same
 * `[node, ask]` API, resolves the promise with the user's choice.
 * `destructive` keeps the legacy red-confirm treatment.
 */
function useMConfirm() {
  const [state, setState] = useState<{
    title: string
    body: string
    confirmLabel: string
    destructive?: boolean
    resolve: (ok: boolean) => void
  } | null>(null)

  const settle = (ok: boolean) => {
    state?.resolve(ok)
    setState(null)
  }

  const node =
    state !== null ? (
      <MSheet title={state.title} onClose={() => settle(false)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 16 }}>
          <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.5 }}>{state.body}</div>
          <MButtonRow>
            <MButton variant="ghost" onClick={() => settle(false)}>
              Cancel
            </MButton>
            <MButton
              variant="primary"
              onClick={() => settle(true)}
              style={
                state.destructive ? { background: 'var(--m-red)', borderColor: 'var(--m-red)', color: '#fff' } : {}
              }
            >
              {state.confirmLabel}
            </MButton>
          </MButtonRow>
        </div>
      </MSheet>
    ) : null

  const ask = (props: { title: string; body: string; confirmLabel: string; destructive?: boolean }): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      setState({ ...props, resolve })
    })

  return [node, ask] as const
}
