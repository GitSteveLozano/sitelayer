import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  MBody,
  MButton,
  MButtonRow,
  MChip,
  MChipRow,
  MI,
  MInput,
  MListPlain,
  MListRow,
  MPill,
  MSelect,
  MTopBar,
} from '@/components/m'
import {
  useDeleteQboMapping,
  usePatchQboMapping,
  useQboMappings,
  useUpsertQboMapping,
  type QboEntityType,
  type QboMapping,
} from '@/lib/api'

const ENTITY_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'all' },
  { value: 'customer', label: 'customer' },
  { value: 'service_item', label: 'service item' },
  { value: 'division', label: 'division' },
  { value: 'project', label: 'project' },
]

export function QboMappingsScreen() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<string>('')
  const mappings = useQboMappings(filter ? { entityType: filter as QboEntityType } : {})
  const upsert = useUpsertQboMapping()
  const [editing, setEditing] = useState<QboMapping | 'new' | null>(null)
  const rows = mappings.data?.mappings ?? []

  return (
    <>
      <MTopBar
        back
        eyebrow="QuickBooks Online"
        title="QBO mappings"
        sub={`${rows.length} active`}
        actionLabel="New mapping"
        actionIcon={<span style={{ fontSize: 22, fontWeight: 800 }}>+</span>}
        onBack={() => navigate('/more/integrations/qbo')}
        onAction={() => setEditing('new')}
      />
      <MBody>
        <MChipRow>
          {ENTITY_TYPES.map((t) => (
            <MChip key={t.value || 'all'} active={filter === t.value} onClick={() => setFilter(t.value)}>
              {t.label}
            </MChip>
          ))}
        </MChipRow>

        {mappings.isPending ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            No mappings in this slice.
          </div>
        ) : (
          <MListPlain>
            {rows.map((m) => (
              <MListRow
                key={m.id}
                headline={`${m.entity_type} · ${m.local_ref}`}
                supporting={`QBO #${m.external_id}${m.label ? ` · ${m.label}` : ''}`}
                trailing={<MPill tone={m.status === 'active' ? 'green' : undefined}>{m.status}</MPill>}
                onTap={() => setEditing(m)}
              />
            ))}
          </MListPlain>
        )}
      </MBody>

      {editing !== null ? (
        <MappingForm
          key={editing === 'new' ? 'new' : editing.id}
          mapping={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreate={async (input) => {
            await upsert.mutateAsync(input)
            setEditing(null)
          }}
        />
      ) : null}
    </>
  )
}

function MappingForm({
  mapping,
  onClose,
  onCreate,
}: {
  mapping: QboMapping | null
  onClose: () => void
  onCreate: (input: {
    entity_type: string
    local_ref: string
    external_id: string
    label?: string | null
    status?: string
  }) => Promise<void>
}) {
  const patch = usePatchQboMapping(mapping?.id ?? '')
  const del = useDeleteQboMapping()
  const [confirmNode, askConfirm] = useMConfirm()
  const [entityType, setEntityType] = useState(mapping?.entity_type ?? 'customer')
  const [localRef, setLocalRef] = useState(mapping?.local_ref ?? '')
  const [externalId, setExternalId] = useState(mapping?.external_id ?? '')
  const [label, setLabel] = useState(mapping?.label ?? '')
  const [status, setStatus] = useState(mapping?.status ?? 'active')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    try {
      if (!mapping) {
        await onCreate({
          entity_type: entityType,
          local_ref: localRef.trim(),
          external_id: externalId.trim(),
          label: label.trim() || null,
          status,
        })
      } else {
        await patch.mutateAsync({
          entity_type: entityType,
          local_ref: localRef.trim(),
          external_id: externalId.trim(),
          label: label.trim() || null,
          status,
          expected_version: mapping.version,
        })
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const remove = async () => {
    if (!mapping) return
    const ok = await askConfirm({
      title: 'Delete QBO mapping?',
      body: `Unlink ${mapping.entity_type} from QBO #${mapping.external_id}.`,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await del.mutateAsync({ id: mapping.id, expected_version: mapping.version })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <MSheet title={mapping ? 'Edit mapping' : 'New mapping'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 16 }}>
        <Field label="Entity type">
          <MSelect value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            {['customer', 'service_item', 'division', 'project'].map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </MSelect>
        </Field>
        <Field label="Local ref (uuid or code)">
          <MInput value={localRef} onChange={(e) => setLocalRef(e.target.value)} placeholder="customer uuid" />
        </Field>
        <Field label="QBO external id">
          <MInput value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="123" />
        </Field>
        <Field label="Label (optional)">
          <MInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ACME Inc" />
        </Field>
        <Field label="Status">
          <MSelect value={status} onChange={(e) => setStatus(e.target.value)}>
            {['active', 'inactive'].map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </MSelect>
        </Field>
        {error ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
        {mapping ? (
          <MButtonRow>
            <MButton
              variant="primary"
              onClick={submit}
              disabled={!localRef.trim() || !externalId.trim() || patch.isPending}
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
          <MButton
            variant="primary"
            onClick={submit}
            disabled={!localRef.trim() || !externalId.trim() || patch.isPending}
          >
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
 */
function useMConfirm() {
  const [state, setState] = useState<{
    title: string
    body: string
    confirmLabel: string
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
              style={{ background: 'var(--m-red)', borderColor: 'var(--m-red)', color: '#fff' }}
            >
              {state.confirmLabel}
            </MButton>
          </MButtonRow>
        </div>
      </MSheet>
    ) : null

  const ask = (props: { title: string; body: string; confirmLabel: string }): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      setState({ ...props, resolve })
    })

  return [node, ask] as const
}
