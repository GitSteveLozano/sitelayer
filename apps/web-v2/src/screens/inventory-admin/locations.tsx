import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet, useConfirmSheet } from '@/components/mobile'
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

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more/inventory" className="text-[12px] text-ink-3">
        ← Inventory admin
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">Locations</h1>
          <p className="text-[12px] text-ink-3 mt-1">{rows.length} active</p>
        </div>
        <MobileButton variant="primary" onClick={() => setEditing('new')}>
          + New
        </MobileButton>
      </div>

      <div className="mt-6 space-y-2">
        {locations.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : rows.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No locations yet.</div>
          </Card>
        ) : (
          rows.map((l) => (
            <button key={l.id} type="button" onClick={() => setEditing(l)} className="block w-full text-left">
              <Card tight>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold truncate">{l.name}</div>
                    <div className="text-[11px] text-ink-3 mt-0.5">
                      {l.location_type}
                      {l.project_id ? ' · project-tied' : ''}
                    </div>
                  </div>
                  {l.is_default ? <Pill tone="good">default</Pill> : <Pill tone="default">{l.location_type}</Pill>}
                </div>
              </Card>
            </button>
          ))
        )}
      </div>

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
    </div>
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
  const [confirmNode, askConfirm] = useConfirmSheet()
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
    <Sheet open onClose={onClose} title={location ? 'Edit location' : 'New location'}>
      <div className="space-y-3">
        <label className="block">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Name</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Main yard"
            className="mt-1 w-full text-[15px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Type</div>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Project (optional)</div>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
          >
            <option value="">None — yard / vendor</option>
            {(projects.data?.projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="rounded"
          />
          <span className="text-[13px]">Default yard (one per company)</span>
        </label>
        {error ? <div className="text-[12px] text-warn">{error}</div> : null}
        <div className={location ? 'grid grid-cols-2 gap-2' : ''}>
          <MobileButton variant="primary" onClick={submit} disabled={!name.trim() || patch.isPending}>
            {location ? 'Save' : 'Create'}
          </MobileButton>
          {location ? (
            <MobileButton variant="ghost" onClick={remove} disabled={del.isPending}>
              Delete
            </MobileButton>
          ) : null}
        </div>
      </div>
      {confirmNode}
    </Sheet>
  )
}
