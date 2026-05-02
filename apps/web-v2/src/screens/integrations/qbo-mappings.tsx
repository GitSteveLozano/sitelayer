import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet, useConfirmSheet } from '@/components/mobile'
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
  const [filter, setFilter] = useState<string>('')
  const mappings = useQboMappings(filter ? { entityType: filter as QboEntityType } : {})
  const upsert = useUpsertQboMapping()
  const [editing, setEditing] = useState<QboMapping | 'new' | null>(null)
  const rows = mappings.data?.mappings ?? []

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more/integrations/qbo" className="text-[12px] text-ink-3">
        ← QBO
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">QBO mappings</h1>
          <p className="text-[12px] text-ink-3 mt-1">{rows.length} active</p>
        </div>
        <MobileButton variant="primary" onClick={() => setEditing('new')}>
          + New
        </MobileButton>
      </div>

      <div className="mt-4 flex gap-1.5 overflow-x-auto scrollbar-hide pb-2">
        {ENTITY_TYPES.map((t) => (
          <button
            key={t.value || 'all'}
            type="button"
            onClick={() => setFilter(t.value)}
            className={`px-3 py-1.5 rounded-full text-[12px] font-medium border shrink-0 ${
              filter === t.value ? 'bg-accent text-white border-transparent' : 'bg-card-soft text-ink-2 border-line'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-2 space-y-2">
        {mappings.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : rows.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No mappings in this slice.</div>
          </Card>
        ) : (
          rows.map((m) => (
            <button key={m.id} type="button" onClick={() => setEditing(m)} className="block w-full text-left">
              <Card tight>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold truncate">
                      {m.entity_type} · {m.local_ref}
                    </div>
                    <div className="text-[11px] text-ink-3 mt-0.5 truncate">
                      QBO #{m.external_id}
                      {m.label ? ` · ${m.label}` : ''}
                    </div>
                  </div>
                  <Pill tone={m.status === 'active' ? 'good' : 'default'}>{m.status}</Pill>
                </div>
              </Card>
            </button>
          ))
        )}
      </div>

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
    </div>
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
  const [confirmNode, askConfirm] = useConfirmSheet()
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
      destructive: true,
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
    <Sheet open onClose={onClose} title={mapping ? 'Edit mapping' : 'New mapping'}>
      <div className="space-y-3">
        <Select
          label="Entity type"
          value={entityType}
          onChange={setEntityType}
          options={['customer', 'service_item', 'division', 'project']}
        />
        <Field label="Local ref (uuid or code)" value={localRef} onChange={setLocalRef} placeholder="customer uuid" />
        <Field label="QBO external id" value={externalId} onChange={setExternalId} placeholder="123" />
        <Field label="Label (optional)" value={label} onChange={setLabel} placeholder="ACME Inc" />
        <Select label="Status" value={status} onChange={setStatus} options={['active', 'inactive']} />
        {error ? <div className="text-[12px] text-status-warn">{error}</div> : null}
        <div className={mapping ? 'grid grid-cols-2 gap-2' : ''}>
          <MobileButton
            variant="primary"
            onClick={submit}
            disabled={!localRef.trim() || !externalId.trim() || patch.isPending}
          >
            {mapping ? 'Save' : 'Create'}
          </MobileButton>
          {mapping ? (
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
