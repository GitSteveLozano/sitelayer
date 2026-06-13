import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBody, MButton, MButtonRow, MI, MInput, MListPlain, MListRow, MPill, MSelect, MTopBar } from '@/components/m'
import {
  useCreateInventoryLocation,
  useDeleteInventoryLocation,
  useInventoryLocations,
  usePatchInventoryLocation,
  useProjects,
  type InventoryLocation,
} from '@/lib/api'

const TYPES = ['yard', 'job', 'vendor', 'other']

export function InventoryLocationsAdminScreen() {
  const locations = useInventoryLocations()
  const create = useCreateInventoryLocation()
  const [editing, setEditing] = useState<InventoryLocation | 'new' | null>(null)
  const rows = locations.data?.inventoryLocations ?? []
  const navigate = useNavigate()

  return (
    <>
      <MTopBar
        back
        eyebrow="Inventory admin"
        title="Locations"
        sub={`${rows.length} active`}
        actionLabel="New location"
        actionIcon={<span style={{ fontSize: 22, fontWeight: 800 }}>+</span>}
        onBack={() => navigate('/more/inventory')}
        onAction={() => setEditing('new')}
      />
      <MBody>
        {locations.isPending ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            No locations yet.
          </div>
        ) : (
          <MListPlain>
            {rows.map((l) => (
              <MListRow
                key={l.id}
                headline={l.name}
                supporting={`${l.location_type}${l.project_id ? ' · project-tied' : ''}`}
                trailing={l.is_default ? <MPill tone="green">default</MPill> : <MPill>{l.location_type}</MPill>}
                onTap={() => setEditing(l)}
              />
            ))}
          </MListPlain>
        )}
      </MBody>

      {editing !== null ? (
        <LocationForm
          key={editing === 'new' ? 'new' : editing.id}
          location={editing === 'new' ? null : editing}
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

function LocationForm({
  location,
  onClose,
  onCreate,
}: {
  location: InventoryLocation | null
  onClose: () => void
  onCreate: (input: {
    name: string
    location_type?: string
    project_id?: string | null
    is_default?: boolean
  }) => Promise<void>
}) {
  const projects = useProjects()
  const patch = usePatchInventoryLocation(location?.id ?? '')
  const del = useDeleteInventoryLocation()
  const [confirmNode, askConfirm] = useMConfirm()
  const [name, setName] = useState(location?.name ?? '')
  const [type, setType] = useState(location?.location_type ?? 'yard')
  const [projectId, setProjectId] = useState<string>(location?.project_id ?? '')
  const [isDefault, setIsDefault] = useState(location?.is_default ?? false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    try {
      const input = {
        name: name.trim(),
        location_type: type,
        project_id: projectId === '' ? null : projectId,
        is_default: isDefault,
      }
      if (!location) {
        await onCreate(input)
      } else {
        await patch.mutateAsync({ ...input, expected_version: location.version })
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const remove = async () => {
    if (!location) return
    const ok = await askConfirm({
      title: 'Delete location?',
      body: `Permanently remove "${location.name}".`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await del.mutateAsync({ id: location.id, expected_version: location.version })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <MSheet title={location ? 'Edit location' : 'New location'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 16 }}>
        <Field label="Name">
          <MInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Main yard" />
        </Field>
        <Field label="Type">
          <MSelect value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </MSelect>
        </Field>
        <Field label="Project (optional)">
          <MSelect value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">None — yard / vendor</option>
            {(projects.data?.projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </MSelect>
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          <span>Default yard (one per company)</span>
        </label>
        {error ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
        {location ? (
          <MButtonRow>
            <MButton variant="primary" onClick={submit} disabled={!name.trim() || patch.isPending}>
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
          <MButton variant="primary" onClick={submit} disabled={!name.trim() || patch.isPending}>
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
