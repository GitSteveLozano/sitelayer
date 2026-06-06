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
import { evaluateFormulaUnsafe, type FormulaContext } from '@sitelayer/formula-evaluator'
import { useServiceItems, type ServiceItem } from '@/lib/api/service-items'
import {
  useAddAssemblyComponent,
  useAssemblies,
  useAssembly,
  useCloneAssembly,
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
  /**
   * Phase 2 — optional quantity formula. When non-empty, explode evaluates it
   * (with `measurement_quantity` + the row's named vars bound) and the result
   * replaces the static `quantity_per_unit`. Empty → static-quantity path.
   */
  quantity_formula: string
  /** Editable named-var rows feeding `formula_vars` (e.g. coverage_rate=32). */
  vars: VarRow[]
}

/** One key/value pair for a row's `formula_vars`. */
interface VarRow {
  key: string
  name: string
  value: string
}

let varSeq = 0
function newVarKey(): string {
  varSeq += 1
  return `v${varSeq}`
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
    quantity_formula: '',
    vars: [],
  }
}

function varsFromRecord(raw: Record<string, number | string> | null | undefined): VarRow[] {
  if (!raw) return []
  return Object.keys(raw).map((name) => ({ key: newVarKey(), name, value: String(raw[name]) }))
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
    quantity_formula: c.quantity_formula ?? '',
    vars: varsFromRecord(c.formula_vars),
  }
}

/** Build the `formula_vars` record a row submits — only well-formed pairs. */
function rowFormulaVars(r: DraftRow): Record<string, number | string> | null {
  const out: Record<string, number | string> = {}
  for (const v of r.vars) {
    const name = v.name.trim()
    if (!name) continue
    const num = Number(v.value)
    out[name] = v.value.trim() !== '' && Number.isFinite(num) ? num : v.value
  }
  return Object.keys(out).length ? out : null
}

/** Whether a row uses the formula path (non-empty formula text). */
function rowHasFormula(r: DraftRow): boolean {
  return r.quantity_formula.trim() !== ''
}

/**
 * Resolve a row's per-unit quantity at a sample `measurement_quantity`. Returns
 * the static `quantity_per_unit` when no formula is set, otherwise the
 * client-side `evaluateFormulaUnsafe` result. `error` is non-null on a bad
 * formula so the editor can surface it inline.
 */
function resolveRowQuantity(r: DraftRow, sampleQty: number, sampleUnit: string): { qty: number; error: string | null } {
  if (!rowHasFormula(r)) {
    const qty = Number(r.quantity_per_unit)
    return { qty: Number.isFinite(qty) ? qty : 0, error: null }
  }
  const ctx: FormulaContext = {
    measurement_quantity: Number.isFinite(sampleQty) ? sampleQty : 0,
    measurement_unit: sampleUnit,
    ...(rowFormulaVars(r) ?? {}),
  }
  const result = evaluateFormulaUnsafe(r.quantity_formula, ctx)
  if (!result.ok || result.value === undefined) {
    return { qty: 0, error: result.error?.message ?? 'formula evaluation failed' }
  }
  return { qty: result.value, error: null }
}

/**
 * Line total at a sample measurement quantity. When a formula is set the
 * resolved (formula) quantity is the per-unit qty; static rows use the typed
 * `quantity_per_unit`. Waste % and unit cost apply on top in both paths.
 */
function rowLineTotal(r: DraftRow, sampleQty = 1, sampleUnit = 'sqft'): number {
  const { qty, error } = resolveRowQuantity(r, sampleQty, sampleUnit)
  if (error) return 0
  const cost = Number(r.unit_cost)
  const waste = Number(r.waste_pct)
  if (!Number.isFinite(qty) || !Number.isFinite(cost) || !Number.isFinite(waste)) return 0
  // For a static row sampleQty is ignored (qty IS the per-unit); for a formula
  // row the evaluated qty already folds in the sample, so don't multiply twice.
  const perUnitTimesSample = rowHasFormula(r) ? qty : qty * sampleQty
  return perUnitTimesSample * (1 + waste / 100) * cost
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

  const cloneAssembly = useCloneAssembly()
  // Which row is mid-clone — disables that row's button while the create +
  // component copies are in flight.
  const [cloningId, setCloningId] = useState<string | null>(null)
  const [cloneError, setCloneError] = useState<string | null>(null)

  const openNew = () => {
    setEditingId(null)
    setEditorOpen(true)
  }
  const openEdit = (id: string) => {
    setEditingId(id)
    setEditorOpen(true)
  }
  const handleClone = async (id: string) => {
    setCloningId(id)
    setCloneError(null)
    try {
      await cloneAssembly.mutateAsync({ id })
      void assembliesQuery.refetch()
    } catch (err) {
      setCloneError(err instanceof Error ? err.message : String(err))
    } finally {
      setCloningId(null)
    }
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
        <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
          <MButton
            size="sm"
            variant="quiet"
            disabled={cloningId === r.id}
            onClick={(e) => {
              e.stopPropagation()
              void handleClone(r.id)
            }}
          >
            {cloningId === r.id ? 'Cloning…' : 'Clone'}
          </MButton>
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
        </span>
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

        {cloneError ? (
          <div style={{ fontSize: 12, color: 'var(--m-red)' }}>Couldn’t clone assembly: {cloneError}</div>
        ) : null}

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
  // Live-preview sample: a hypothetical takeoff quantity (e.g. 100 sqft) used
  // to evaluate every row's formula client-side so the estimator sees the
  // resolved per-line quantity + total as they type. Does not persist.
  const [sampleQty, setSampleQty] = useState('100')
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

  // Sample quantity for the live preview. NaN/blank → 0 so a row's formula
  // still evaluates (and surfaces a divide-by-zero, etc.) deterministically.
  const sampleQtyNum = useMemo(() => {
    const n = Number(sampleQty)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }, [sampleQty])

  // Recipe rate at the sample: per-unit total for static rows, evaluated total
  // for formula rows. Drives the footer "Recipe rate … at N {unit}" hint.
  const previewRate = useMemo(
    () => rows.reduce((sum, r) => sum + rowLineTotal(r, sampleQtyNum, unit || 'sqft'), 0),
    [rows, sampleQtyNum, unit],
  )

  const updateRow = (key: string, patch: Partial<DraftRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const addVar = (rowKey: string) =>
    setRows((prev) =>
      prev.map((r) => (r.key === rowKey ? { ...r, vars: [...r.vars, { key: newVarKey(), name: '', value: '' }] } : r)),
    )
  const updateVar = (rowKey: string, varKey: string, patch: Partial<VarRow>) =>
    setRows((prev) =>
      prev.map((r) =>
        r.key === rowKey ? { ...r, vars: r.vars.map((v) => (v.key === varKey ? { ...v, ...patch } : v)) } : r,
      ),
    )
  const removeVar = (rowKey: string, varKey: string) =>
    setRows((prev) => prev.map((r) => (r.key === rowKey ? { ...r, vars: r.vars.filter((v) => v.key !== varKey) } : r)))

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
      // A formula row's static quantity is ignored at explode time, so only
      // validate it for non-formula rows.
      if (!rowHasFormula(r)) {
        const qty = Number(r.quantity_per_unit)
        if (!Number.isFinite(qty) || qty < 0) return `Quantity for "${label}" must be a non-negative number.`
      } else {
        // Surface a bad formula before the server 400s on save.
        const { error } = resolveRowQuantity(r, sampleQtyNum, unit || 'sqft')
        if (error) return `Formula for "${label}" is invalid: ${error}`
      }
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
              // Phase 2: send the formula (null clears it back to static) + vars.
              quantity_formula: rowHasFormula(r) ? r.quantity_formula.trim() : null,
              formula_vars: rowHasFormula(r) ? rowFormulaVars(r) : null,
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
    const formula = rowHasFormula(r) ? r.quantity_formula.trim() : null
    const vars = rowHasFormula(r) ? rowFormulaVars(r) : null
    if (targetId === assemblyId) {
      await addComponent.mutateAsync({
        kind: r.kind,
        name: r.name.trim(),
        quantity_per_unit: Number(r.quantity_per_unit),
        unit: r.unit.trim() || 'ea',
        unit_cost: Number(r.unit_cost),
        waste_pct: Number(r.waste_pct),
        ...(formula ? { quantity_formula: formula, formula_vars: vars } : {}),
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
        ...(formula ? { quantity_formula: formula, formula_vars: vars } : {}),
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
            {error ??
              (rows.some(rowHasFormula)
                ? `Recipe cost ${formatMoney(previewRate)} at ${sampleQtyNum.toLocaleString('en-US')} ${unit || 'unit'} (formula-driven)`
                : `Recipe rate ${formatMoney(previewRate)} / ${unit || 'unit'}`)}
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

            {rows.map((r) => {
              const usesFormula = rowHasFormula(r)
              const { qty: resolvedQty, error: formulaError } = resolveRowQuantity(r, sampleQtyNum, unit || 'sqft')
              const lineTotal = rowLineTotal(r, sampleQtyNum, unit || 'sqft')
              return (
                <div
                  key={r.key}
                  style={{
                    display: 'grid',
                    gap: 6,
                    borderTop: '1px solid var(--m-ink-5, rgba(0,0,0,0.06))',
                    paddingTop: 6,
                  }}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: COMPONENT_GRID, gap: 8, alignItems: 'center' }}>
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
                      disabled={usesFormula}
                      title={
                        usesFormula ? 'Quantity is formula-driven; clear the formula to set a static qty' : undefined
                      }
                      style={{ textAlign: 'right', opacity: usesFormula ? 0.4 : 1 }}
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

                  {/* Formula sub-row: a quantity formula + its named vars. The
                      formula evaluates client-side against the sample qty for a
                      live preview, mirroring exactly what the explode endpoint
                      computes server-side. */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 2fr) auto',
                      gap: 8,
                      alignItems: 'center',
                      paddingLeft: 2,
                    }}
                  >
                    <MInput
                      value={r.quantity_formula}
                      placeholder="Formula (optional) e.g. measurement_quantity / coverage_rate"
                      onChange={(e) => updateRow(r.key, { quantity_formula: e.target.value })}
                      aria-label="Quantity formula"
                      style={{ fontFamily: 'var(--m-num)', fontSize: 12 }}
                    />
                    {/* Named vars feeding formula_vars. */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                      {r.vars.map((v) => (
                        <span key={v.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <MInput
                            value={v.name}
                            placeholder="var"
                            onChange={(e) => updateVar(r.key, v.key, { name: e.target.value })}
                            aria-label="Formula variable name"
                            style={{ width: 96, fontSize: 12 }}
                          />
                          <span style={{ color: 'var(--m-ink-3)' }}>=</span>
                          <MInput
                            value={v.value}
                            placeholder="0"
                            onChange={(e) => updateVar(r.key, v.key, { value: e.target.value })}
                            aria-label="Formula variable value"
                            style={{ width: 64, fontSize: 12, textAlign: 'right' }}
                          />
                          <button
                            type="button"
                            onClick={() => removeVar(r.key, v.key)}
                            aria-label="Remove variable"
                            style={{
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              color: 'var(--m-ink-3)',
                              fontSize: 13,
                              lineHeight: 1,
                            }}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                      <MButton size="sm" variant="quiet" onClick={() => addVar(r.key)}>
                        + var
                      </MButton>
                    </div>
                    {/* Live resolved qty / line total at the sample. */}
                    <span
                      style={{
                        fontSize: 12,
                        whiteSpace: 'nowrap',
                        textAlign: 'right',
                        color: formulaError ? 'var(--m-red)' : 'var(--m-ink-3)',
                        fontFamily: 'var(--m-num)',
                      }}
                    >
                      {formulaError
                        ? formulaError
                        : usesFormula
                          ? `→ ${resolvedQty.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${r.unit} · ${formatMoney(lineTotal)}`
                          : `${formatMoney(lineTotal)} @ ${sampleQtyNum.toLocaleString('en-US')} ${unit || 'unit'}`}
                    </span>
                  </div>
                </div>
              )
            })}

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                marginTop: 4,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <MButton size="sm" variant="quiet" onClick={addRow}>
                  + Add component
                </MButton>
                {/* Live-preview sample: a hypothetical takeoff quantity that
                    every formula row evaluates against. */}
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span style={{ color: 'var(--m-ink-3)' }}>Preview at</span>
                  <MInput
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="1"
                    value={sampleQty}
                    onChange={(e) => setSampleQty(e.target.value)}
                    aria-label="Preview measurement quantity"
                    style={{ width: 84, textAlign: 'right' }}
                  />
                  <span style={{ color: 'var(--m-ink-3)' }}>{unit || 'unit'}</span>
                </label>
              </span>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {KINDS.map((k) => {
                  const sum = rows
                    .filter((r) => r.kind === k)
                    .reduce((s, r) => s + rowLineTotal(r, sampleQtyNum, unit || 'sqft'), 0)
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
