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
  MSelect,
  MTopBar,
} from '@/components/m'
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
  const navigate = useNavigate()
  const [filter, setFilter] = useState<string>('')
  const fields = useQboCustomFields()
  const upsert = useUpsertQboCustomField()
  const [editing, setEditing] = useState<QboCustomField | 'new' | null>(null)

  const all = fields.data?.mappings ?? []
  const rows = filter ? all.filter((f) => f.entity_type === filter) : all

  return (
    <>
      <MTopBar
        back
        eyebrow="QuickBooks Online"
        title="QBO custom fields"
        sub={`${rows.length} defined`}
        actionLabel="New custom field"
        actionIcon={<span style={{ fontSize: 22, fontWeight: 800 }}>+</span>}
        onBack={() => navigate('/more/integrations/qbo')}
        onAction={() => setEditing('new')}
      />
      <MBody>
        <MChipRow>
          {ENTITY_FILTERS.map((t) => (
            <MChip key={t.value || 'all'} active={filter === t.value} onClick={() => setFilter(t.value)}>
              {t.label}
            </MChip>
          ))}
        </MChipRow>

        {fields.isPending ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            No custom fields defined in this slice.
          </div>
        ) : (
          <MListPlain>
            {rows.map((f) => (
              <MListRow
                key={f.id}
                headline={`${f.entity_type} · ${f.field_name}`}
                supporting={
                  <>
                    QBO def #{f.qbo_definition_id}
                    {f.qbo_label ? ` · ${f.qbo_label}` : ''}
                    {f.notes ? (
                      <>
                        <br />
                        {f.notes}
                      </>
                    ) : null}
                  </>
                }
                onTap={() => setEditing(f)}
              />
            ))}
          </MListPlain>
        )}

        <div style={{ padding: '8px 16px 24px' }}>
          <Attribution source="GET/PUT/DELETE /api/qbo/custom-fields" />
        </div>
      </MBody>

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
    </>
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
  const [confirmNode, askConfirm] = useMConfirm()
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
    <MSheet title={field ? 'Edit custom field' : 'New custom field'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 16 }}>
        <Field label="Entity type">
          <MSelect value={entityType} onChange={(e) => setEntityType(e.target.value as QboCustomFieldEntity)}>
            {QBO_CUSTOM_FIELD_ENTITIES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </MSelect>
        </Field>
        <Field label="Field name">
          <MInput value={fieldName} onChange={(e) => setFieldName(e.target.value)} placeholder="sqft_total" />
        </Field>
        <Field label="QBO definition id">
          <MInput
            value={definitionId}
            onChange={(e) => setDefinitionId(e.target.value)}
            placeholder="QBO custom field DefinitionId"
          />
        </Field>
        <Field label="QBO label (optional)">
          <MInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Total Sq Ft" />
        </Field>
        <Field label="Notes (optional)">
          <MInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="why this mapping exists" />
        </Field>
        {error ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
        {field ? (
          <MButtonRow>
            <MButton variant="primary" onClick={submit} disabled={!fieldName.trim() || !definitionId.trim()}>
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
          <MButton variant="primary" onClick={submit} disabled={!fieldName.trim() || !definitionId.trim()}>
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
