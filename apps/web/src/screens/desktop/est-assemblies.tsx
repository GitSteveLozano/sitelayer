/**
 * Estimator desktop — EST · ASSEMBLIES (Desktop v2 · Estimator · Bid Out).
 *
 * The Assembly surface the design ("Estimator · Bid Out") calls for. An
 * assembly is a named recipe attached to a scope service-item code: a bundle
 * of cost components (material / labor / sub / freight), each with a
 * per-unit-of-assembly quantity, unit cost and optional waste %. The takeoff
 * surfaces a single unit rate for speed; this screen is where estimators
 * crack the recipe open and edit the components.
 *
 * Read side reuses `useAssemblies` (GET /api/assemblies). The editor reuses
 * the existing create/add-component hooks and the editor-only mutations added
 * in lib/api/assemblies.ts (rename header, edit/remove component, delete). The
 * server recomputes the header's cached `total_rate` on every component write.
 *
 * Per the spec each editor row is anchored on a service item picked from
 * `useServiceItems` (MSelect) — selecting one seeds the component name / unit
 * / unit cost from the catalog — plus a quantity. Kind + waste % round out the
 * recipe so the saved component matches the real schema.
 */
import { useEffect, useMemo, useState } from 'react'
import { useServiceItems, type ServiceItem } from '@/lib/api/service-items'
import {
  useAddAssemblyComponent,
  useAssemblies,
  useAssembly,
  useCreateAssembly,
  useDeleteAssembly,
  useRemoveAssemblyComponent,
  useUpdateAssembly,
  useUpdateAssemblyComponent,
  type Assembly,
  type AssemblyComponent,
  type AssemblyComponentKind,
} from '@/lib/api/assemblies'
import {
  DataTable,
  DEmptyState,
  DErrorState,
  DEyebrow,
  DH1,
  DKpi,
  DKpiStrip,
  DLoadingState,
  DModal,
  type DColumn,
} from '@/components/d'
import { MButton, MInput, MPill, MSelect } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

const KINDS: AssemblyComponentKind[] = ['material', 'labor', 'sub', 'freight']
const KIND_TONE: Record<AssemblyComponentKind, 'accent' | 'green' | 'amber' | undefined> = {
  material: 'accent',
  labor: 'green',
  sub: 'amber',
  freight: undefined,
}

// One editable component row in the editor. `key` is a stable local id so React
// can track rows across add/remove; `id` is the persisted component id (null
// for rows added in this session and not yet saved).
interface DraftRow {
  key: string
  id: string | null
  service_item_code: string
  kind: AssemblyComponentKind
  name: string
  quantity_per_unit: string
  unit: string
  unit_cost: string
  waste_pct: string
}

let rowSeq = 0
function newRowKey(): string {
  rowSeq += 1
  return `r${rowSeq}`
}

function emptyRow(): DraftRow {
  return {
    key: newRowKey(),
    id: null,
    service_item_code: '',
    kind: 'material',
    name: '',
    quantity_per_unit: '1',
    unit: 'ea',
    unit_cost: '0',
    waste_pct: '0',
  }
}

function rowFromComponent(c: AssemblyComponent): DraftRow {
  return {
    key: newRowKey(),
    id: c.id,
    // Components carry no service_item_code of their own; the picker drives
    // name/unit/cost. Leave the picker unselected for already-saved rows and
    // surface the stored name instead.
    service_item_code: '',
    kind: c.kind,
    name: c.name,
    quantity_per_unit: String(Number(c.quantity_per_unit)),
    unit: c.unit,
    unit_cost: String(Number(c.unit_cost)),
    waste_pct: String(Number(c.waste_pct)),
  }
}

function rowLineTotal(r: DraftRow): number {
  const qty = Number(r.quantity_per_unit)
  const cost = Number(r.unit_cost)
  const waste = Number(r.waste_pct)
  if (!Number.isFinite(qty) || !Number.isFinite(cost) || !Number.isFinite(waste)) return 0
  return qty * (1 + waste / 100) * cost
}

const COMPONENT_GRID = 'minmax(0, 1.4fr) 96px minmax(0, 1fr) 78px 84px 90px 70px 32px'

export function EstAssemblies() {
  const assembliesQuery = useAssemblies()
  const assemblies = useMemo<Assembly[]>(
    () => assembliesQuery.data?.assemblies ?? [],
    [assembliesQuery.data?.assemblies],
  )

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const openNew = () => {
    setEditingId(null)
    setEditorOpen(true)
  }
  const openEdit = (id: string) => {
    setEditingId(id)
    setEditorOpen(true)
  }

  const totalRateSum = useMemo(() => assemblies.reduce((sum, a) => sum + (Number(a.total_rate) || 0), 0), [assemblies])

  const columns: Array<DColumn<Assembly>> = [
    { key: 'name', header: 'Assembly', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'service_item_code', header: 'Scope item', render: (r) => <MPill>{r.service_item_code}</MPill> },
    { key: 'unit', header: 'Unit', render: (r) => r.unit || '—' },
    {
      key: 'total_rate',
      header: 'Unit rate',
      numeric: true,
      render: (r) => formatMoney(r.total_rate),
    },
    {
      key: 'edit',
      header: '',
      render: (r) => (
        <MButton
          size="sm"
          variant="quiet"
          onClick={(e) => {
            e.stopPropagation()
            openEdit(r.id)
          }}
        >
          Edit
        </MButton>
      ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Estimator · Assemblies</DEyebrow>
          <DH1>
            {assemblies.length} {assemblies.length === 1 ? 'assembly' : 'assemblies'}
          </DH1>
        </div>

        <DKpiStrip>
          <DKpi label="Assemblies" value={String(assemblies.length)} meta="Named recipes" />
          <DKpi
            label="Total unit rate"
            value={assemblies.length ? formatMoney(totalRateSum) : '—'}
            tone="accent"
            meta="Summed cached rates"
          />
          <DKpi
            label="Scope items covered"
            value={String(new Set(assemblies.map((a) => a.service_item_code)).size)}
            meta="Distinct service items"
          />
        </DKpiStrip>

        {assembliesQuery.isLoading ? (
          <DLoadingState label="Loading assemblies…" />
        ) : assembliesQuery.isError ? (
          <DErrorState
            body="Couldn’t load assemblies. Your catalog is safe."
            actions={
              <MButton size="sm" variant="ghost" onClick={() => void assembliesQuery.refetch()}>
                Retry
              </MButton>
            }
          />
        ) : assemblies.length === 0 ? (
          <DEmptyState
            title="No assemblies yet"
            body="An assembly bundles the materials, labor, subs and freight behind one scope item so the takeoff can surface a single unit rate. Create your first to get started."
            action={
              <MButton variant="primary" onClick={openNew}>
                + New assembly
              </MButton>
            }
          />
        ) : (
          <DataTable<Assembly>
            title="Company assemblies"
            action={
              <MButton size="sm" variant="quiet" onClick={openNew}>
                + New assembly
              </MButton>
            }
            columns={columns}
            rows={assemblies}
            rowKey={(r) => r.id}
            onRowClick={(r) => openEdit(r.id)}
            empty="No assemblies yet."
          />
        )}
      </div>

      {editorOpen ? (
        <AssemblyEditor
          assemblyId={editingId}
          onClose={() => setEditorOpen(false)}
          onSaved={() => {
            setEditorOpen(false)
            void assembliesQuery.refetch()
          }}
        />
      ) : null}
    </div>
  )
}

interface AssemblyEditorProps {
  /** null = create a new assembly; otherwise edit this one. */
  assemblyId: string | null
  onClose: () => void
  onSaved: () => void
}

function AssemblyEditor({ assemblyId, onClose, onSaved }: AssemblyEditorProps) {
  const isEdit = assemblyId != null
  const detail = useAssembly(assemblyId)
  const serviceItemsQuery = useServiceItems()
  const items = useMemo<ServiceItem[]>(
    () => serviceItemsQuery.data?.serviceItems ?? [],
    [serviceItemsQuery.data?.serviceItems],
  )
  const itemByCode = useMemo(() => {
    const map = new Map<string, ServiceItem>()
    for (const it of items) map.set(it.code, it)
    return map
  }, [items])

  const createAssembly = useCreateAssembly()
  const updateAssembly = useUpdateAssembly()
  const deleteAssembly = useDeleteAssembly()
  const addComponent = useAddAssemblyComponent(assemblyId ?? '')
  const updateComponent = useUpdateAssemblyComponent()
  const removeComponent = useRemoveAssemblyComponent()

  const [name, setName] = useState('')
  const [scopeCode, setScopeCode] = useState('')
  const [unit, setUnit] = useState('sqft')
  const [rows, setRows] = useState<DraftRow[]>([emptyRow()])
  // Persisted component ids present when the editor opened — used to compute
  // which rows were removed and need a server delete.
  const [originalComponentIds, setOriginalComponentIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [seeded, setSeeded] = useState(false)

  // Seed the form once from the loaded detail (edit) or defaults (create).
  useEffect(() => {
    if (seeded) return
    if (!isEdit) {
      setName('')
      setScopeCode('')
      setUnit('sqft')
      setRows([emptyRow()])
      setOriginalComponentIds([])
      setSeeded(true)
      return
    }
    if (detail.data) {
      const a = detail.data.assembly
      setName(a.name)
      setScopeCode(a.service_item_code)
      setUnit(a.unit || 'sqft')
      const seededRows = detail.data.components.map(rowFromComponent)
      setRows(seededRows.length ? seededRows : [emptyRow()])
      setOriginalComponentIds(detail.data.components.map((c) => c.id))
      setSeeded(true)
    }
  }, [seeded, isEdit, detail.data])

  const previewRate = useMemo(() => rows.reduce((sum, r) => sum + rowLineTotal(r), 0), [rows])

  const updateRow = (key: string, patch: Partial<DraftRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  // Picking a service item seeds the component's name / unit / cost from the
  // catalog (the spec's "service item + qty" shape) while keeping them editable.
  const pickServiceItem = (key: string, code: string) => {
    const item = code ? itemByCode.get(code) : undefined
    updateRow(key, {
      service_item_code: code,
      ...(item
        ? {
            name: item.name,
            unit: item.unit || 'ea',
            unit_cost: item.default_rate == null ? '0' : String(Number(item.default_rate)),
          }
        : {}),
    })
  }

  const addRow = () => setRows((prev) => [...prev, emptyRow()])
  const removeRow = (key: string) => setRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.key !== key)))

  function validate(): string | null {
    if (!name.trim()) return 'Assembly name is required.'
    if (!scopeCode.trim()) return 'Pick the scope service item this assembly is for.'
    if (!unit.trim()) return 'Unit is required.'
    for (const r of rows) {
      const label = r.name.trim() || r.service_item_code || 'a component'
      if (!r.name.trim()) return `Every component needs a name (pick a service item or type one) — check ${label}.`
      const qty = Number(r.quantity_per_unit)
      if (!Number.isFinite(qty) || qty < 0) return `Quantity for "${label}" must be a non-negative number.`
      const cost = Number(r.unit_cost)
      if (!Number.isFinite(cost) || cost < 0) return `Unit cost for "${label}" must be a non-negative number.`
      const waste = Number(r.waste_pct)
      if (!Number.isFinite(waste) || waste < 0) return `Waste % for "${label}" must be a non-negative number.`
    }
    return null
  }

  const handleSave = async () => {
    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }
    setSaving(true)
    setError(null)
    try {
      let targetId = assemblyId
      if (!isEdit) {
        const created = await createAssembly.mutateAsync({
          service_item_code: scopeCode.trim(),
          name: name.trim(),
          unit: unit.trim(),
        })
        targetId = created.assembly.id
        // Fresh assembly: every row is a brand-new component.
        for (const r of rows) {
          await addComponentTo(targetId, r)
        }
      } else {
        await updateAssembly.mutateAsync({
          id: assemblyId!,
          name: name.trim(),
          service_item_code: scopeCode.trim(),
          unit: unit.trim(),
        })
        // Removed rows → delete; existing rows → patch; new rows → add.
        const keptIds = new Set(rows.filter((r) => r.id).map((r) => r.id as string))
        for (const oldId of originalComponentIds) {
          if (!keptIds.has(oldId)) {
            await removeComponent.mutateAsync({ assemblyId: assemblyId!, componentId: oldId })
          }
        }
        for (const r of rows) {
          if (r.id) {
            await updateComponent.mutateAsync({
              assemblyId: assemblyId!,
              componentId: r.id,
              kind: r.kind,
              name: r.name.trim(),
              quantity_per_unit: Number(r.quantity_per_unit),
              unit: r.unit.trim() || 'ea',
              unit_cost: Number(r.unit_cost),
              waste_pct: Number(r.waste_pct),
            })
          } else {
            await addComponentTo(assemblyId!, r)
          }
        }
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // addComponent's hook is bound to the assembly id; for a freshly-created
  // assembly we have to POST to the new id directly via the same endpoint.
  async function addComponentTo(targetId: string, r: DraftRow) {
    if (targetId === assemblyId) {
      await addComponent.mutateAsync({
        kind: r.kind,
        name: r.name.trim(),
        quantity_per_unit: Number(r.quantity_per_unit),
        unit: r.unit.trim() || 'ea',
        unit_cost: Number(r.unit_cost),
        waste_pct: Number(r.waste_pct),
      })
      return
    }
    const { request } = await import('@/lib/api/client')
    await request(`/api/assemblies/${encodeURIComponent(targetId)}/components`, {
      method: 'POST',
      json: {
        kind: r.kind,
        name: r.name.trim(),
        quantity_per_unit: Number(r.quantity_per_unit),
        unit: r.unit.trim() || 'ea',
        unit_cost: Number(r.unit_cost),
        waste_pct: Number(r.waste_pct),
      },
    })
  }

  const handleDelete = async () => {
    if (!isEdit) return
    setSaving(true)
    setError(null)
    try {
      await deleteAssembly.mutateAsync({ id: assemblyId! })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  const loadingDetail = isEdit && detail.isLoading

  return (
    <DModal
      open
      onClose={onClose}
      title={isEdit ? 'Edit assembly' : 'New assembly'}
      width={760}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%' }}>
          <span style={{ fontSize: 12, color: error ? 'var(--m-red)' : 'var(--m-ink-3)' }}>
            {error ?? `Recipe rate ${formatMoney(previewRate)} / ${unit || 'unit'}`}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            {isEdit ? (
              <MButton variant="ghost" onClick={() => void handleDelete()} disabled={saving}>
                Delete
              </MButton>
            ) : null}
            <MButton variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </MButton>
            <MButton variant="primary" onClick={() => void handleSave()} disabled={saving || loadingDetail}>
              {saving ? 'Saving…' : isEdit ? 'Save assembly' : 'Create assembly'}
            </MButton>
          </span>
        </div>
      }
    >
      {loadingDetail ? (
        <DLoadingState label="Loading assembly…" />
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {/* Header fields */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr) 96px', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={labelStyle}>Assembly name</span>
              <MInput value={name} placeholder="e.g. EIFS wall system" onChange={(e) => setName(e.target.value)} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={labelStyle}>Scope service item</span>
              <MSelect value={scopeCode} onChange={(e) => setScopeCode(e.target.value)}>
                <option value="">Select…</option>
                {items.map((it) => (
                  <option key={it.code} value={it.code}>
                    {it.code} — {it.name}
                  </option>
                ))}
              </MSelect>
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={labelStyle}>Unit</span>
              <MInput value={unit} placeholder="sqft" onChange={(e) => setUnit(e.target.value)} />
            </label>
          </div>

          {/* Components */}
          <div style={{ display: 'grid', gap: 6 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: COMPONENT_GRID,
                gap: 8,
                ...labelStyle,
                padding: '0 2px',
              }}
            >
              <span>Service item</span>
              <span>Kind</span>
              <span>Name</span>
              <span style={{ textAlign: 'right' }}>Qty</span>
              <span>Unit</span>
              <span style={{ textAlign: 'right' }}>Unit cost</span>
              <span style={{ textAlign: 'right' }}>Waste %</span>
              <span />
            </div>

            {rows.map((r) => (
              <div
                key={r.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: COMPONENT_GRID,
                  gap: 8,
                  alignItems: 'center',
                  borderTop: '1px solid var(--m-ink-5, rgba(0,0,0,0.06))',
                  paddingTop: 6,
                }}
              >
                <MSelect
                  value={r.service_item_code}
                  onChange={(e) => pickServiceItem(r.key, e.target.value)}
                  aria-label="Component service item"
                >
                  <option value="">— pick —</option>
                  {items.map((it) => (
                    <option key={it.code} value={it.code}>
                      {it.code}
                    </option>
                  ))}
                </MSelect>
                <MSelect
                  value={r.kind}
                  onChange={(e) => updateRow(r.key, { kind: e.target.value as AssemblyComponentKind })}
                  aria-label="Component kind"
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </MSelect>
                <MInput
                  value={r.name}
                  placeholder="Component name"
                  onChange={(e) => updateRow(r.key, { name: e.target.value })}
                  aria-label="Component name"
                />
                <MInput
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.0001"
                  value={r.quantity_per_unit}
                  onChange={(e) => updateRow(r.key, { quantity_per_unit: e.target.value })}
                  style={{ textAlign: 'right' }}
                  aria-label="Quantity per unit"
                />
                <MInput
                  value={r.unit}
                  placeholder="ea"
                  onChange={(e) => updateRow(r.key, { unit: e.target.value })}
                  aria-label="Component unit"
                />
                <MInput
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={r.unit_cost}
                  onChange={(e) => updateRow(r.key, { unit_cost: e.target.value })}
                  style={{ textAlign: 'right' }}
                  aria-label="Unit cost"
                />
                <MInput
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={r.waste_pct}
                  onChange={(e) => updateRow(r.key, { waste_pct: e.target.value })}
                  style={{ textAlign: 'right' }}
                  aria-label="Waste percent"
                />
                <button
                  type="button"
                  onClick={() => removeRow(r.key)}
                  disabled={rows.length <= 1}
                  aria-label="Remove component"
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: rows.length <= 1 ? 'not-allowed' : 'pointer',
                    color: 'var(--m-ink-3)',
                    fontSize: 16,
                    lineHeight: 1,
                    opacity: rows.length <= 1 ? 0.4 : 1,
                  }}
                >
                  ✕
                </button>
              </div>
            ))}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
              <MButton size="sm" variant="quiet" onClick={addRow}>
                + Add component
              </MButton>
              <span style={{ display: 'flex', gap: 6 }}>
                {KINDS.map((k) => {
                  const sum = rows.filter((r) => r.kind === k).reduce((s, r) => s + rowLineTotal(r), 0)
                  if (sum <= 0) return null
                  return (
                    <MPill key={k} tone={KIND_TONE[k]}>
                      {k} {formatMoney(sum)}
                    </MPill>
                  )
                })}
              </span>
            </div>
          </div>
        </div>
      )}
    </DModal>
  )
}

const labelStyle = {
  fontFamily: 'var(--m-num)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase' as const,
  color: 'var(--m-ink-3)',
}
