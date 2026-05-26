import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Sheet, useConfirmSheet } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import {
  QBO_CUSTOM_FIELD_ENTITIES,
  useDeleteQboCustomField,
  useQboCustomFields,
  useUpsertQboCustomField,
  type QboCustomField,
  type QboCustomFieldEntity,
} from '@/lib/api/qbo-custom-fields'

const ENTITY_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'all' },
  ...QBO_CUSTOM_FIELD_ENTITIES.map((e) => ({ value: e, label: e })),
]

export function QboCustomFieldsScreen() {
  const [filter, setFilter] = useState<string>('')
  const fields = useQboCustomFields()
  const upsert = useUpsertQboCustomField()
  const [editing, setEditing] = useState<QboCustomField | 'new' | null>(null)

  const all = fields.data?.mappings ?? []
  const rows = filter ? all.filter((f) => f.entity_type === filter) : all

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more/integrations/qbo" className="text-[12px] text-ink-3">
        ← QBO
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">QBO custom fields</h1>
          <p className="text-[12px] text-ink-3 mt-1">{rows.length} defined</p>
        </div>
        <MobileButton variant="primary" onClick={() => setEditing('new')}>
          + New
        </MobileButton>
      </div>

      <div className="mt-4 flex gap-1.5 overflow-x-auto scrollbar-hide pb-2">
        {ENTITY_FILTERS.map((t) => (
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
        {fields.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : rows.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No custom fields defined in this slice.</div>
          </Card>
        ) : (
          rows.map((f) => (
            <button key={f.id} type="button" onClick={() => setEditing(f)} className="block w-full text-left">
              <Card tight>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold truncate">
                    {f.entity_type} · {f.field_name}
                  </div>
                  <div className="text-[11px] text-ink-3 mt-0.5 truncate">
                    QBO def #{f.qbo_definition_id}
                    {f.qbo_label ? ` · ${f.qbo_label}` : ''}
                  </div>
                  {f.notes ? <div className="text-[11px] text-ink-3 mt-0.5 truncate">{f.notes}</div> : null}
                </div>
              </Card>
            </button>
          ))
        )}
      </div>

      <Attribution source="GET/PUT/DELETE /api/qbo/custom-fields" />

      {editing !== null ? (
        <CustomFieldForm
          key={editing === 'new' ? 'new' : editing.id}
          field={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (input) => {
            await upsert.mutateAsync(input)
            setEditing(null)
          }}
        />
      ) : null}
    </div>
  )
}

function CustomFieldForm({
  field,
  onClose,
  onSaved,
}: {
  field: QboCustomField | null
  onClose: () => void
  onSaved: (input: {
    entity_type: QboCustomFieldEntity
    field_name: string
    qbo_definition_id: string
    qbo_label?: string | null
    notes?: string | null
  }) => Promise<void>
}) {
  const del = useDeleteQboCustomField()
  const [confirmNode, askConfirm] = useConfirmSheet()
  const [entityType, setEntityType] = useState<QboCustomFieldEntity>(
    (field?.entity_type as QboCustomFieldEntity) ?? 'Estimate',
  )
  const [fieldName, setFieldName] = useState(field?.field_name ?? '')
  const [definitionId, setDefinitionId] = useState(field?.qbo_definition_id ?? '')
  const [label, setLabel] = useState(field?.qbo_label ?? '')
  const [notes, setNotes] = useState(field?.notes ?? '')
  const [error, setError] = useState<string | null>(null)

  // entity_type + field_name form the upsert key; editing an existing
  // row keeps both so the PUT lands on the same conflict target.
  const submit = async () => {
    setError(null)
    try {
      await onSaved({
        entity_type: entityType,
        field_name: fieldName.trim(),
        qbo_definition_id: definitionId.trim(),
        qbo_label: label.trim() || null,
        notes: notes.trim() || null,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const remove = async () => {
    if (!field) return
    const ok = await askConfirm({
      title: 'Delete custom field?',
      body: `Remove the ${field.entity_type} · ${field.field_name} → QBO def #${field.qbo_definition_id} mapping.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await del.mutateAsync({ id: field.id })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <Sheet open onClose={onClose} title={field ? 'Edit custom field' : 'New custom field'}>
      <div className="space-y-3">
        <Select
          label="Entity type"
          value={entityType}
          onChange={(v) => setEntityType(v as QboCustomFieldEntity)}
          options={QBO_CUSTOM_FIELD_ENTITIES}
        />
        <Field label="Field name" value={fieldName} onChange={setFieldName} placeholder="sqft_total" />
        <Field
          label="QBO definition id"
          value={definitionId}
          onChange={setDefinitionId}
          placeholder="QBO custom field DefinitionId"
        />
        <Field label="QBO label (optional)" value={label} onChange={setLabel} placeholder="Total Sq Ft" />
        <Field label="Notes (optional)" value={notes} onChange={setNotes} placeholder="why this mapping exists" />
        {error ? <div className="text-[12px] text-warn">{error}</div> : null}
        <div className={field ? 'grid grid-cols-2 gap-2' : ''}>
          <MobileButton variant="primary" onClick={submit} disabled={!fieldName.trim() || !definitionId.trim()}>
            {field ? 'Save' : 'Create'}
          </MobileButton>
          {field ? (
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
