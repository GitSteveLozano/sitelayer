import { useEffect, useState, type PointerEvent } from 'react'
import {
  calculateLinealLength,
  calculateLinealQuantity,
  calculatePolygonArea,
  calculatePolygonCentroid,
  calculateTakeoffQuantity,
  calculateVolumeQuantity,
  clampBoardCoordinate,
  formatMoney,
  normalizeGeometry,
  type TakeoffGeometry,
  type TakeoffPoint,
} from '@sitelayer/domain'
import { API_URL, apiGet, apiPost } from '../api.js'
import type {
  BlueprintRow,
  BonusRuleRow,
  IntegrationMappingRow,
  LaborRow,
  MaterialBillRow,
  MeasurementRow,
  OfflineMutation,
  PricingProfileRow,
  ProjectRow,
  ProjectSummary,
  WorkerRow,
} from '../api.js'
import { FormRow } from './forms.js'
import { Button } from './ui/button.js'
import { Checkbox } from './ui/checkbox.js'
import { Input } from './ui/input.js'
import { Select } from './ui/select.js'
import { Textarea } from './ui/textarea.js'

type TakeoffTool = 'polygon' | 'lineal' | 'volume'

const TAKEOFF_TOOLS: Array<{ value: TakeoffTool; label: string; unitHint: string; minPoints: number }> = [
  { value: 'polygon', label: 'Area polygon', unitHint: 'sqft', minPoints: 3 },
  { value: 'lineal', label: 'Lineal path', unitHint: 'lf', minPoints: 2 },
  { value: 'volume', label: 'Volume box', unitHint: 'cu', minPoints: 0 },
]

export function AnalyticsWidget({ companySlug }: { companySlug: string }) {
  const [data, setData] = useState<{
    projects: Array<{
      project: ProjectSummary['project']
      metrics: {
        totalHours: number
        totalSqft: number
        laborCost: number
        materialCost: number
        subCost: number
        totalCost: number
        revenue: number
        profit: number
        margin: number
        bonus: { eligible: boolean; payoutPercent: number; payout: number }
        sqftPerHr: number
      }
    }>
    divisions: Array<{ divisionCode: string; revenue: number; cost: number; margin: number; count: number }>
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void apiGet<{
      projects: Array<{
        project: ProjectSummary['project']
        metrics: {
          totalHours: number
          totalSqft: number
          laborCost: number
          materialCost: number
          subCost: number
          totalCost: number
          revenue: number
          profit: number
          margin: number
          bonus: { eligible: boolean; payoutPercent: number; payout: number }
          sqftPerHr: number
        }
      }>
      divisions: Array<{ divisionCode: string; revenue: number; cost: number; margin: number; count: number }>
    }>('/api/analytics', companySlug)
      .then(setData)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'unknown error'))
  }, [companySlug])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading analytics...</p>

  return (
    <div className="analytics">
      <div>
        <h3>Division Rollups</h3>
        <ul className="list compact">
          {data.divisions.map((division) => (
            <li key={division.divisionCode}>
              <strong>{division.divisionCode}</strong>
              <span>
                Revenue {formatMoney(division.revenue)} · Cost {formatMoney(division.cost)} · Margin{' '}
                {formatMoney(division.margin)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3>Project Metrics</h3>
        <ul className="list compact">
          {data.projects.map((entry) => (
            <li key={entry.project.id}>
              <strong>{entry.project.name}</strong>
              <span>
                Labor {formatMoney(entry.metrics.laborCost)} · Cost {formatMoney(entry.metrics.totalCost)} · Margin{' '}
                {(entry.metrics.margin * 100).toFixed(2)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function ProjectEditor({
  project,
  divisions,
  busy,
  onSubmit,
}: {
  project: ProjectRow
  divisions: Array<{ code: string; name: string; sort_order: number }>
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
}) {
  const divisionLabel = divisions.find((division) => division.code === project.division_code)
  return (
    <div className="editor">
      <div className="rowBetween">
        <div className="stacked">
          <h3>Edit Project</h3>
          <span className="muted compact">{project.customer_name}</span>
        </div>
        <div className="stacked alignRight">
          <span className="badge">{project.status}</span>
          <span className="muted compact">
            {divisionLabel ? `${divisionLabel.code} · ${divisionLabel.name}` : project.division_code}
          </span>
        </div>
      </div>
      <FormRow actionLabel="Save project" busy={busy} onSubmit={onSubmit}>
        <Input name="expected_version" type="hidden" defaultValue={project.version} />
        <Input name="name" defaultValue={project.name} placeholder="Project name" />
        <Input name="customer_name" defaultValue={project.customer_name} placeholder="Customer / builder" />
        <Select name="division_code" defaultValue={project.division_code}>
          {divisions.map((division) => (
            <option key={division.code} value={division.code}>
              {division.code} - {division.name}
            </option>
          ))}
        </Select>
        <Input name="status" defaultValue={project.status} placeholder="Status" />
        <Input
          name="bid_total"
          defaultValue={Number(project.bid_total)}
          type="number"
          step="0.01"
          placeholder="Bid total"
        />
        <Input
          name="labor_rate"
          defaultValue={Number(project.labor_rate)}
          type="number"
          step="0.01"
          placeholder="Labor rate"
        />
        <Input
          name="target_sqft_per_hr"
          defaultValue={project.target_sqft_per_hr ? Number(project.target_sqft_per_hr) : ''}
          type="number"
          step="0.01"
          placeholder="Target sqft/hr"
        />
        <Input
          name="bonus_pool"
          defaultValue={Number(project.bonus_pool)}
          type="number"
          step="0.01"
          placeholder="Bonus pool"
        />
      </FormRow>
    </div>
  )
}

export function CustomerEditor({
  customer,
  busy,
  onSubmit,
  onDelete,
}: {
  customer: { id: string; name: string; external_id: string | null; source: string; version: number }
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <div className="stacked">
          <strong>{customer.name}</strong>
          <span className="muted compact">
            {customer.external_id ? `External ID ${customer.external_id}` : 'Local-only customer'}
          </span>
        </div>
        <div className="stacked alignRight">
          <span className="badge">{customer.source}</span>
          <span className="muted compact">v{customer.version}</span>
        </div>
      </div>
      <FormRow actionLabel="Save customer" busy={busy} onSubmit={onSubmit}>
        <Input name="expected_version" type="hidden" defaultValue={customer.version} />
        <Input name="name" defaultValue={customer.name} placeholder="Customer name" />
        <Input name="external_id" defaultValue={customer.external_id ?? ''} placeholder="External ID" />
        <Input name="source" defaultValue={customer.source} placeholder="Source" />
      </FormRow>
      <div className="actions">
        <Button type="button" onClick={() => void onDelete()}>
          Delete
        </Button>
      </div>
    </div>
  )
}

export function BlueprintEditor({
  blueprint,
  lineage,
  busy,
  onSubmit,
  onCreateVersion,
  onDelete,
}: {
  blueprint: BlueprintRow
  lineage: string
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onCreateVersion: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <div className="stacked">
          <strong>v{blueprint.version}</strong>
          <span className="muted compact">{blueprint.deleted_at ? 'deleted' : 'active'}</span>
        </div>
        <div className="stacked alignRight">
          <span className="badge">{blueprint.preview_type}</span>
          <span className="muted compact">{blueprint.replaces_blueprint_document_id ? 'revision' : 'source'}</span>
        </div>
      </div>
      <p className="muted compact">History: {lineage}</p>
      <FormRow actionLabel="Save blueprint" busy={busy} onSubmit={onSubmit}>
        <Input name="expected_version" type="hidden" defaultValue={blueprint.version} />
        <Input name="file_name" defaultValue={blueprint.file_name} placeholder="Blueprint file name" />
        <Input name="storage_path" defaultValue={blueprint.storage_path} placeholder="Storage path" />
        <Input name="preview_type" defaultValue={blueprint.preview_type} placeholder="Preview type" />
        <Input
          name="calibration_length"
          defaultValue={blueprint.calibration_length ?? ''}
          placeholder="Calibration length"
          type="number"
          step="0.01"
        />
        <Input name="calibration_unit" defaultValue={blueprint.calibration_unit ?? ''} placeholder="Calibration unit" />
        <Input
          name="sheet_scale"
          defaultValue={blueprint.sheet_scale ?? ''}
          placeholder="Sheet scale"
          type="number"
          step="0.0001"
        />
        <Input name="blueprint_file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/*" />
      </FormRow>
      <FormRow actionLabel="Create version" busy={busy} onSubmit={onCreateVersion}>
        <Input name="file_name" defaultValue={blueprint.file_name} placeholder="Version file name" />
        <Input name="storage_path" defaultValue={blueprint.storage_path} placeholder="Storage path" />
        <Input name="preview_type" defaultValue={blueprint.preview_type} placeholder="Preview type" />
        <Input
          name="calibration_length"
          defaultValue={blueprint.calibration_length ?? ''}
          placeholder="Calibration length"
          type="number"
          step="0.01"
        />
        <Input name="calibration_unit" defaultValue={blueprint.calibration_unit ?? ''} placeholder="Calibration unit" />
        <Input
          name="sheet_scale"
          defaultValue={blueprint.sheet_scale ?? ''}
          placeholder="Sheet scale"
          type="number"
          step="0.0001"
        />
        <Input name="blueprint_file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/*" />
        <label className="checkbox">
          <Checkbox name="copy_measurements" type="checkbox" defaultChecked />
          <span>Copy measurements forward</span>
        </label>
      </FormRow>
      <p className="muted compact">
        File preview: {blueprint.file_url ? blueprint.file_url : 'not stored yet'} · Base storage:{' '}
        {blueprint.storage_path}
      </p>
      <div className="actions">
        <Button type="button" onClick={() => void onDelete()}>
          Delete
        </Button>
      </div>
    </div>
  )
}

export function PricingProfileEditor({
  profile,
  busy,
  onSubmit,
  onDelete,
}: {
  profile: PricingProfileRow
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <strong>{profile.name}</strong>
        <span className="muted">{profile.is_default ? 'default' : 'custom'}</span>
      </div>
      <FormRow actionLabel="Save pricing profile" busy={busy} onSubmit={(form) => onSubmit(form)}>
        <Input name="expected_version" type="hidden" defaultValue={profile.version} />
        <Input name="name" defaultValue={profile.name} placeholder="Profile name" />
        <label className="checkbox">
          <Checkbox name="is_default" type="checkbox" defaultChecked={profile.is_default} />
          <span>Default profile</span>
        </label>
        <Textarea
          name="config"
          rows={4}
          defaultValue={JSON.stringify(profile.config, null, 2)}
          placeholder='{"template":"la-default"}'
        />
      </FormRow>
      <div className="actions">
        <Button type="button" onClick={() => void onDelete()}>
          Delete
        </Button>
      </div>
    </div>
  )
}

export function BonusRuleEditor({
  rule,
  busy,
  onSubmit,
  onDelete,
}: {
  rule: BonusRuleRow
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <strong>{rule.name}</strong>
        <span className="muted">{rule.is_active ? 'active' : 'inactive'}</span>
      </div>
      <FormRow actionLabel="Save bonus rule" busy={busy} onSubmit={(form) => onSubmit(form)}>
        <Input name="expected_version" type="hidden" defaultValue={rule.version} />
        <Input name="name" defaultValue={rule.name} placeholder="Rule name" />
        <label className="checkbox">
          <Checkbox name="is_active" type="checkbox" defaultChecked={rule.is_active} />
          <span>Active rule</span>
        </label>
        <Textarea
          name="config"
          rows={4}
          defaultValue={JSON.stringify(rule.config, null, 2)}
          placeholder='{"basis":"margin","threshold":0.15}'
        />
      </FormRow>
      <div className="actions">
        <Button type="button" onClick={() => void onDelete()}>
          Delete
        </Button>
      </div>
    </div>
  )
}

export function IntegrationMappingEditor({
  mapping,
  busy,
  onSubmit,
  onDelete,
}: {
  mapping: IntegrationMappingRow
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <strong>{mapping.entity_type}</strong>
        <span className="muted">v{mapping.version}</span>
      </div>
      <FormRow actionLabel="Save mapping" busy={busy} onSubmit={onSubmit}>
        <Input name="expected_version" type="hidden" defaultValue={mapping.version} />
        <Select name="entity_type" defaultValue={mapping.entity_type}>
          <option value="customer">customer</option>
          <option value="service_item">service_item</option>
          <option value="division">division</option>
          <option value="project">project</option>
        </Select>
        <Input name="local_ref" defaultValue={mapping.local_ref} placeholder="Local ref" />
        <Input name="external_id" defaultValue={mapping.external_id} placeholder="QBO external id" />
        <Input name="label" defaultValue={mapping.label ?? ''} placeholder="Label" />
        <Input name="status" defaultValue={mapping.status} placeholder="Status" />
        <Input name="notes" defaultValue={mapping.notes ?? ''} placeholder="Notes" />
      </FormRow>
      <div className="actions">
        <Button type="button" onClick={() => void onDelete()}>
          Delete
        </Button>
      </div>
    </div>
  )
}

export function WorkerEditor({
  worker,
  busy,
  onSubmit,
  onDelete,
}: {
  worker: WorkerRow
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <strong>{worker.name}</strong>
        <span className="muted">v{worker.version}</span>
      </div>
      <FormRow actionLabel="Save worker" busy={busy} onSubmit={onSubmit}>
        <Input name="expected_version" type="hidden" defaultValue={worker.version} />
        <Input name="name" defaultValue={worker.name} placeholder="Worker name" />
        <Input name="role" defaultValue={worker.role} placeholder="Role" />
      </FormRow>
      <div className="actions">
        <Button type="button" onClick={() => void onDelete()}>
          Delete
        </Button>
      </div>
    </div>
  )
}

export function MeasurementEditor({
  measurement,
  serviceItems,
  busy,
  onSubmit,
  onDelete,
}: {
  measurement: MeasurementRow
  serviceItems: Array<{ code: string; name: string; category: string; unit: string; default_rate: string | null }>
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <strong>{measurement.service_item_code}</strong>
        <span className="muted">v{measurement.version}</span>
      </div>
      <FormRow actionLabel="Save measurement" busy={busy} onSubmit={onSubmit}>
        <Input name="expected_version" type="hidden" defaultValue={measurement.version} />
        <Select name="service_item_code" defaultValue={measurement.service_item_code}>
          {serviceItems.map((item) => (
            <option key={item.code} value={item.code}>
              {item.code} - {item.name}
            </option>
          ))}
        </Select>
        <Input name="quantity" defaultValue={Number(measurement.quantity)} type="number" step="0.01" />
        <Input name="unit" defaultValue={measurement.unit} placeholder="Unit" />
        <Input name="notes" defaultValue={measurement.notes ?? ''} placeholder="Notes" />
      </FormRow>
      <div className="actions">
        <Button type="button" onClick={() => void onDelete()}>
          Delete
        </Button>
      </div>
    </div>
  )
}

export function MaterialBillEditor({
  bill,
  busy,
  onSubmit,
  onDelete,
}: {
  bill: MaterialBillRow
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <strong>{bill.vendor}</strong>
        <span className="muted">v{bill.version}</span>
      </div>
      <FormRow actionLabel="Save bill" busy={busy} onSubmit={onSubmit}>
        <Input name="expected_version" type="hidden" defaultValue={bill.version} />
        <Input name="vendor" defaultValue={bill.vendor} placeholder="Vendor" />
        <Input name="amount" defaultValue={Number(bill.amount)} type="number" step="0.01" />
        <Input name="bill_type" defaultValue={bill.bill_type} placeholder="Type" />
        <Input name="description" defaultValue={bill.description ?? ''} placeholder="Description" />
        <Input name="occurred_on" defaultValue={bill.occurred_on ?? ''} placeholder="Occurred on" />
      </FormRow>
      <div className="actions">
        <Button type="button" onClick={() => void onDelete()}>
          Delete
        </Button>
      </div>
    </div>
  )
}

export function LaborEditor({
  laborEntry,
  workers,
  serviceItems,
  busy,
  onSubmit,
  onDelete,
}: {
  laborEntry: LaborRow
  workers: WorkerRow[]
  serviceItems: Array<{ code: string; name: string; category: string; unit: string; default_rate: string | null }>
  busy: boolean
  onSubmit: (formData: FormData) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <div className="editor">
      <div className="rowBetween">
        <strong>{laborEntry.service_item_code}</strong>
        <span className="muted">v{laborEntry.version}</span>
      </div>
      <FormRow actionLabel="Save labor entry" busy={busy} onSubmit={onSubmit}>
        <Input name="expected_version" type="hidden" defaultValue={laborEntry.version} />
        <Select name="worker_id" defaultValue={laborEntry.worker_id ?? ''}>
          <option value="">Worker</option>
          {workers.map((worker) => (
            <option key={worker.id} value={worker.id}>
              {worker.name}
            </option>
          ))}
        </Select>
        <Select name="service_item_code" defaultValue={laborEntry.service_item_code}>
          {serviceItems.map((item) => (
            <option key={item.code} value={item.code}>
              {item.code} - {item.name}
            </option>
          ))}
        </Select>
        <Input name="hours" defaultValue={Number(laborEntry.hours)} type="number" step="0.25" placeholder="Hours" />
        <Input
          name="sqft_done"
          defaultValue={Number(laborEntry.sqft_done)}
          type="number"
          step="0.1"
          placeholder="Sqft done"
        />
        <Input name="status" defaultValue={laborEntry.status} placeholder="Status" />
        <Input name="occurred_on" defaultValue={laborEntry.occurred_on} type="date" />
      </FormRow>
      <div className="actions">
        <Button type="button" onClick={() => void onDelete()}>
          Delete
        </Button>
      </div>
    </div>
  )
}

export function TakeoffWorkspace({
  projectId,
  companySlug,
  blueprints,
  measurements,
  serviceItems,
  selectedBlueprintId,
  onSelectBlueprint,
  onSaved,
}: {
  projectId: string
  companySlug: string
  blueprints: BlueprintRow[]
  measurements: MeasurementRow[]
  serviceItems: Array<{ code: string; name: string; category: string; unit: string; default_rate: string | null }>
  selectedBlueprintId: string
  onSelectBlueprint: (blueprintId: string) => void
  onSaved: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftPoints, setDraftPoints] = useState<TakeoffPoint[]>([])
  const [pointerPoint, setPointerPoint] = useState<TakeoffPoint | null>(null)
  const [zoom, setZoom] = useState(1)
  const [serviceItemCode, setServiceItemCode] = useState(serviceItems[0]?.code ?? '')
  const [takeoffTool, setTakeoffTool] = useState<TakeoffTool>('polygon')
  const [quantityMultiplier, setQuantityMultiplier] = useState(1)
  const [calibrationLength, setCalibrationLength] = useState('100')
  const [calibrationUnit, setCalibrationUnit] = useState('ft')
  const [volumeLength, setVolumeLength] = useState('')
  const [volumeWidth, setVolumeWidth] = useState('')
  const [volumeHeight, setVolumeHeight] = useState('')

  const activeBlueprint = blueprints.find((blueprint) => blueprint.id === selectedBlueprintId) ?? blueprints[0] ?? null
  const blueprintMeasurements = measurements.filter(
    (measurement) => measurement.blueprint_document_id === activeBlueprint?.id,
  )
  const selectedTool = TAKEOFF_TOOLS.find((tool) => tool.value === takeoffTool) ?? TAKEOFF_TOOLS[0]!
  const quantityMultiplierValue = Number.isFinite(quantityMultiplier) && quantityMultiplier > 0 ? quantityMultiplier : 1
  const draftArea = calculatePolygonArea(draftPoints)
  const draftLinealLength = calculateLinealLength(draftPoints)
  const volumeDimensions = {
    length: Number(volumeLength),
    width: Number(volumeWidth),
    height: Number(volumeHeight),
  }
  const draftQuantity =
    takeoffTool === 'polygon'
      ? calculateTakeoffQuantity(draftPoints, quantityMultiplierValue)
      : takeoffTool === 'lineal'
        ? calculateLinealQuantity(draftPoints, quantityMultiplierValue)
        : calculateVolumeQuantity(volumeDimensions)
  const selectedServiceItem = serviceItems.find((item) => item.code === serviceItemCode)
  const selectedUnit = selectedServiceItem?.unit ?? selectedTool.unitHint
  const multiplierIsValid = takeoffTool === 'volume' || (Number.isFinite(quantityMultiplier) && quantityMultiplier > 0)
  const draftDirty =
    draftPoints.length > 0 ||
    volumeLength.trim().length > 0 ||
    volumeWidth.trim().length > 0 ||
    volumeHeight.trim().length > 0
  const canSaveDraft =
    Boolean(activeBlueprint) &&
    Boolean(serviceItemCode) &&
    multiplierIsValid &&
    draftQuantity > 0 &&
    (takeoffTool === 'volume' ? true : draftPoints.length >= selectedTool.minPoints)
  const saveActionLabel =
    takeoffTool === 'polygon' ? 'Save area' : takeoffTool === 'lineal' ? 'Save line' : 'Save volume'

  useEffect(() => {
    if (!selectedBlueprintId && blueprints[0]) {
      onSelectBlueprint(blueprints[0].id)
    }
  }, [blueprints, onSelectBlueprint, selectedBlueprintId])

  useEffect(() => {
    setDraftPoints([])
    setPointerPoint(null)
    setVolumeLength('')
    setVolumeWidth('')
    setVolumeHeight('')
    const sheetScale = Number(activeBlueprint?.sheet_scale ?? 1)
    setQuantityMultiplier(Number.isFinite(sheetScale) && sheetScale > 0 ? sheetScale : 1)
    setCalibrationLength(activeBlueprint?.calibration_length ?? '100')
    setCalibrationUnit(activeBlueprint?.calibration_unit ?? 'ft')
  }, [
    activeBlueprint?.calibration_length,
    activeBlueprint?.calibration_unit,
    activeBlueprint?.id,
    activeBlueprint?.sheet_scale,
  ])

  useEffect(() => {
    if (!serviceItemCode && serviceItems[0]) {
      setServiceItemCode(serviceItems[0].code)
    }
  }, [serviceItemCode, serviceItems])

  useEffect(() => {
    setDraftPoints([])
    setPointerPoint(null)
    setError(null)
  }, [takeoffTool])

  // Keyboard shortcuts for the takeoff editor:
  //   • Escape — clear the entire draft (matches the "Clear draft" button)
  //   • Ctrl/Cmd+Z — undo the last point (matches the "Undo point" button)
  //   • Enter — save when the active tool has enough data
  // Skipped while busy or while focus is in a form input/textarea so people
  // can still type calibration values, search, etc. without triggering.
  useEffect(() => {
    if (typeof window === 'undefined') return
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false
      if (target.isContentEditable) return true
      const tag = target.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    }
    function onKeyDown(event: KeyboardEvent) {
      if (busy) return
      if (isEditableTarget(event.target)) return
      if (event.key === 'Escape' && draftDirty) {
        event.preventDefault()
        clearDraft()
        return
      }
      if (
        takeoffTool !== 'volume' &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'z' &&
        !event.shiftKey
      ) {
        if (draftPoints.length === 0) return
        event.preventDefault()
        setDraftPoints((current) => current.slice(0, -1))
        return
      }
      if (event.key === 'Enter' && canSaveDraft) {
        event.preventDefault()
        void saveDraftMeasurement()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // saveDraftMeasurement is stable for our purposes (closes over current
    // state via React), but we deliberately don't include it in the deps —
    // including it would re-bind the listener every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, canSaveDraft, draftDirty, draftPoints.length, takeoffTool])

  function clearDraft() {
    setDraftPoints([])
    setPointerPoint(null)
    setVolumeLength('')
    setVolumeWidth('')
    setVolumeHeight('')
  }

  async function saveDraftMeasurement() {
    setError(null)
    try {
      if (!activeBlueprint) {
        throw new Error('select a blueprint first')
      }
      if (!serviceItemCode) {
        throw new Error('service item is required')
      }
      if (takeoffTool !== 'volume' && (!Number.isFinite(quantityMultiplier) || quantityMultiplier <= 0)) {
        throw new Error('quantity multiplier must be greater than zero')
      }

      let geometry: TakeoffGeometry
      let notes: string
      if (takeoffTool === 'polygon') {
        if (draftPoints.length < selectedTool.minPoints) {
          throw new Error('draw at least 3 points')
        }
        if (draftQuantity <= 0) {
          throw new Error('polygon area must be greater than zero')
        }
        geometry = {
          kind: 'polygon',
          points: draftPoints,
          sheet_scale: quantityMultiplierValue,
          calibration_length: Number(calibrationLength) || null,
          calibration_unit: calibrationUnit,
        }
        notes = `polygon:${draftPoints.length}`
      } else if (takeoffTool === 'lineal') {
        if (draftPoints.length < selectedTool.minPoints) {
          throw new Error('draw at least 2 points')
        }
        if (draftQuantity <= 0) {
          throw new Error('lineal length must be greater than zero')
        }
        geometry = {
          kind: 'lineal',
          points: draftPoints,
          sheet_scale: quantityMultiplierValue,
          calibration_length: Number(calibrationLength) || null,
          calibration_unit: calibrationUnit,
        }
        notes = `lineal:${draftPoints.length}`
      } else {
        if (draftQuantity <= 0) {
          throw new Error('volume dimensions must be greater than zero')
        }
        geometry = {
          kind: 'volume',
          length: volumeDimensions.length,
          width: volumeDimensions.width,
          height: volumeDimensions.height,
          unit: selectedUnit,
        }
        notes = `volume:${volumeDimensions.length}x${volumeDimensions.width}x${volumeDimensions.height} ${selectedUnit}`
      }

      setBusy(true)
      await apiPost(
        `/api/projects/${projectId}/takeoff/measurement`,
        {
          blueprint_document_id: activeBlueprint.id,
          service_item_code: serviceItemCode,
          quantity: draftQuantity,
          unit: selectedUnit,
          notes,
          geometry,
        },
        companySlug,
      )
      clearDraft()
      onSaved()
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'unknown error')
    } finally {
      setBusy(false)
    }
  }

  function getBoardPointerPoint(event: PointerEvent<SVGSVGElement>): TakeoffPoint {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * 100
    const y = ((event.clientY - rect.top) / rect.height) * 100
    return {
      x: clampBoardCoordinate(x),
      y: clampBoardCoordinate(y),
    }
  }

  return (
    <div className="takeoffWorkspace">
      <div className="takeoffToolbar">
        <label className="selectWrap">
          <span>Blueprint</span>
          <Select value={activeBlueprint?.id ?? ''} onChange={(event) => onSelectBlueprint(event.target.value)}>
            <option value="">Choose blueprint</option>
            {blueprints.map((blueprint) => (
              <option key={blueprint.id} value={blueprint.id}>
                {blueprint.file_name} · v{blueprint.version}
              </option>
            ))}
          </Select>
        </label>
        <label className="selectWrap">
          <span>Service item</span>
          <Select value={serviceItemCode} onChange={(event) => setServiceItemCode(event.target.value)}>
            {serviceItems.map((item) => (
              <option key={item.code} value={item.code}>
                {item.code} · {item.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="selectWrap">
          <span>Measurement type</span>
          <Select value={takeoffTool} onChange={(event) => setTakeoffTool(event.target.value as TakeoffTool)}>
            {TAKEOFF_TOOLS.map((tool) => (
              <option key={tool.value} value={tool.value}>
                {tool.label}
              </option>
            ))}
          </Select>
        </label>
        {takeoffTool === 'volume' ? (
          <>
            <label className="selectWrap">
              <span>Length</span>
              <Input
                value={volumeLength}
                onChange={(event) => setVolumeLength(event.target.value)}
                type="number"
                min="0"
                step="0.01"
              />
            </label>
            <label className="selectWrap">
              <span>Width</span>
              <Input
                value={volumeWidth}
                onChange={(event) => setVolumeWidth(event.target.value)}
                type="number"
                min="0"
                step="0.01"
              />
            </label>
            <label className="selectWrap">
              <span>Height</span>
              <Input
                value={volumeHeight}
                onChange={(event) => setVolumeHeight(event.target.value)}
                type="number"
                min="0"
                step="0.01"
              />
            </label>
          </>
        ) : (
          <>
            <label className="selectWrap">
              <span>Quantity multiplier</span>
              <Input
                value={quantityMultiplier}
                onChange={(event) => setQuantityMultiplier(Number(event.target.value))}
                type="number"
                step="0.01"
              />
            </label>
            <label className="selectWrap">
              <span>Calibration length</span>
              <Input
                value={calibrationLength}
                onChange={(event) => setCalibrationLength(event.target.value)}
                type="number"
                step="0.01"
              />
            </label>
            <label className="selectWrap">
              <span>Calibration unit</span>
              <Input value={calibrationUnit} onChange={(event) => setCalibrationUnit(event.target.value)} />
            </label>
          </>
        )}
        <label className="selectWrap">
          <span>Zoom</span>
          <Input
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            type="range"
            min="0.6"
            max="2.2"
            step="0.1"
          />
        </label>
      </div>

      <div className="takeoffStageWrap">
        <div className="takeoffStage" style={{ transform: `scale(${zoom})` }}>
          <div className="takeoffBackdrop">
            {activeBlueprint?.file_url ? (
              <iframe title={activeBlueprint.file_name} src={`${API_URL}${activeBlueprint.file_url}`} />
            ) : activeBlueprint?.storage_path && /^https?:\/\//.test(activeBlueprint.storage_path) ? (
              <iframe title={activeBlueprint.file_name} src={activeBlueprint.storage_path} />
            ) : (
              <div className="takeoffGrid" />
            )}
          </div>
          <svg
            className="takeoffSvg"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            onPointerMove={(event) => {
              if (takeoffTool === 'volume') {
                setPointerPoint(null)
                return
              }
              setPointerPoint(getBoardPointerPoint(event))
            }}
            onPointerLeave={() => setPointerPoint(null)}
            onPointerDown={(event) => {
              if (takeoffTool === 'volume') return
              if (event.pointerType === 'mouse' && event.button !== 0) return
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              setDraftPoints((current) => [...current, getBoardPointerPoint(event)])
            }}
          >
            {takeoffTool !== 'volume' && pointerPoint ? (
              <>
                <line x1={pointerPoint.x} y1={0} x2={pointerPoint.x} y2={100} className="takeoffCrosshair" />
                <line x1={0} y1={pointerPoint.y} x2={100} y2={pointerPoint.y} className="takeoffCrosshair" />
              </>
            ) : null}
            {blueprintMeasurements.map((measurement) => {
              const geometry = normalizeGeometry(measurement.geometry)
              if (!geometry) return null
              if (geometry.kind === 'polygon') {
                const points = geometry.points
                const labelPoint = calculatePolygonCentroid(points)
                return (
                  <g key={measurement.id}>
                    <polygon points={polygonPointsToString(points)} className="takeoffPolygon measurementPolygon" />
                    {labelPoint ? (
                      <text x={labelPoint.x} y={labelPoint.y} className="takeoffLabel">
                        {measurement.service_item_code} · {measurement.quantity} {measurement.unit}
                      </text>
                    ) : null}
                  </g>
                )
              }
              if (geometry.kind === 'lineal') {
                const points = geometry.points
                const labelPoint = pathLabelPoint(points)
                return (
                  <g key={measurement.id}>
                    <polyline points={polygonPointsToString(points)} className="takeoffLine measurementLine" />
                    {labelPoint ? (
                      <text x={labelPoint.x} y={labelPoint.y} className="takeoffLabel">
                        {measurement.service_item_code} · {measurement.quantity} {measurement.unit}
                      </text>
                    ) : null}
                  </g>
                )
              }
              return null
            })}
            {takeoffTool !== 'volume' && draftPoints.length > 0 ? (
              <>
                <polyline points={polygonPointsToString(draftPoints)} className="takeoffLine draftLine" />
                {takeoffTool === 'polygon' && draftPoints.length >= 3 ? (
                  <polygon points={polygonPointsToString(draftPoints)} className="takeoffPolygon draftPolygon" />
                ) : null}
                {draftPoints.map((point, index) => (
                  <g key={`${index}-${point.x}-${point.y}`}>
                    <circle cx={point.x} cy={point.y} r={1.15} className="takeoffPoint" />
                    <text x={point.x} y={point.y + 0.8} className="takeoffVertexLabel">
                      {index + 1}
                    </text>
                  </g>
                ))}
              </>
            ) : null}
          </svg>
        </div>
      </div>

      <div className="takeoffActions">
        <Button type="button" onClick={clearDraft} disabled={busy || !draftDirty}>
          Clear draft
        </Button>
        <Button
          type="button"
          onClick={() => setDraftPoints((current) => current.slice(0, -1))}
          disabled={busy || takeoffTool === 'volume' || !draftPoints.length}
        >
          Undo point
        </Button>
        <Button type="button" onClick={() => void saveDraftMeasurement()} disabled={busy || !canSaveDraft}>
          {saveActionLabel}
        </Button>
      </div>

      <div className="takeoffMeta">
        <div>
          <strong>{activeBlueprint?.file_name ?? 'No blueprint selected'}</strong>
          <p className="muted">
            {activeBlueprint
              ? `v${activeBlueprint.version} · ${activeBlueprint.deleted_at ? 'deleted' : 'active'}`
              : 'Choose a blueprint to start drawing.'}
          </p>
        </div>
        <div>
          <strong>
            {draftQuantity} {selectedUnit}
          </strong>
          <p className="muted">
            {takeoffTool === 'polygon'
              ? `${draftPoints.length} points · board area ${draftArea.toFixed(2)} × ${quantityMultiplierValue}`
              : takeoffTool === 'lineal'
                ? `${draftPoints.length} points · board length ${draftLinealLength.toFixed(2)} × ${quantityMultiplierValue}`
                : `${volumeLength || '0'} × ${volumeWidth || '0'} × ${volumeHeight || '0'} ${selectedUnit}`}
          </p>
        </div>
        <div>
          <strong>
            {takeoffTool === 'volume' ? selectedTool.label : `${calibrationLength || '0'} ${calibrationUnit}`}
          </strong>
          <p className="muted">
            {takeoffTool === 'volume'
              ? 'Dimensions are saved as volume geometry for estimate recompute.'
              : 'Calibration metadata is saved with each measurement for later refinement.'}
          </p>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
      <p className="muted takeoffHint">
        {takeoffTool === 'polygon'
          ? 'Click or tap the board to place area vertices. The current draft is highlighted with numbered points and a live crosshair.'
          : takeoffTool === 'lineal'
            ? 'Click or tap the board to trace a lineal path. Use Enter to save once the path has at least two points.'
            : 'Enter length, width, and height for volume-based scope. The saved measurement stays tied to the selected blueprint.'}
      </p>
      <ul className="list compact takeoffMeasurements">
        {blueprintMeasurements.length ? (
          blueprintMeasurements.map((measurement) => {
            const geometry = normalizeGeometry(measurement.geometry)
            return (
              <li key={measurement.id}>
                <strong>{measurement.service_item_code}</strong>
                <span>
                  {measurement.quantity} {measurement.unit}
                  {geometry ? ` · ${geometryKindLabel(geometry)}` : ''}
                  {geometry ? ` · ${geometryMetaLabel(geometry)}` : ''}
                  {measurement.notes ? ` · ${measurement.notes}` : ''}
                </span>
              </li>
            )
          })
        ) : (
          <li>No measurements on this blueprint yet</li>
        )}
      </ul>
    </div>
  )
}

function polygonPointsToString(points: readonly TakeoffPoint[]) {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
}

function pathLabelPoint(points: readonly TakeoffPoint[]) {
  if (points.length === 0) return null
  return points[Math.floor((points.length - 1) / 2)] ?? null
}

function geometryKindLabel(geometry: TakeoffGeometry) {
  if (geometry.kind === 'polygon') return 'area'
  if (geometry.kind === 'lineal') return 'lineal'
  return 'volume'
}

function geometryMetaLabel(geometry: TakeoffGeometry) {
  if (geometry.kind === 'polygon') return `${geometry.points.length} points`
  if (geometry.kind === 'lineal') return `${geometry.points.length} points`
  return `${geometry.length} × ${geometry.width} × ${geometry.height}${geometry.unit ? ` ${geometry.unit}` : ''}`
}

export function getBlueprintLineageLabel(blueprints: BlueprintRow[], blueprintId: string) {
  const byId = new Map(blueprints.map((blueprint) => [blueprint.id, blueprint]))
  const chain: BlueprintRow[] = []
  const seen = new Set<string>()
  let current = byId.get(blueprintId) ?? null
  while (current && !seen.has(current.id)) {
    chain.push(current)
    seen.add(current.id)
    current = current.replaces_blueprint_document_id ? (byId.get(current.replaces_blueprint_document_id) ?? null) : null
  }
  const labels = chain
    .slice()
    .reverse()
    .map((blueprint) => `v${blueprint.version}`)
  return labels.length ? labels.join(' → ') : `v${byId.get(blueprintId)?.version ?? 1}`
}

export function MutationOutboxWidget({ companySlug, refreshKey }: { companySlug: string; refreshKey: number }) {
  const [data, setData] = useState<{
    outbox: Array<{ entity_type: string; entity_id: string; mutation_type: string; status: string; created_at: string }>
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = () =>
      apiGet<{
        outbox: Array<{
          entity_type: string
          entity_id: string
          mutation_type: string
          status: string
          created_at: string
        }>
      }>('/api/sync/outbox?limit=5', companySlug)
        .then((next) => {
          if (active) setData(next)
        })
        .catch((caught: unknown) => {
          if (active) setError(caught instanceof Error ? caught.message : 'unknown error')
        })

    void load()
    const timer = window.setInterval(() => void load(), 8000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [companySlug, refreshKey])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading mutation outbox...</p>

  if (!data.outbox.length) {
    return <p className="muted">No pending local mutations yet.</p>
  }

  return (
    <ul className="list compact">
      {data.outbox.map((entry) => (
        <li key={`${entry.entity_type}:${entry.entity_id}:${entry.created_at}`}>
          <strong>{entry.entity_type}</strong>
          <span>
            {entry.mutation_type} · {entry.status} · {entry.created_at}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function OfflineQueueWidget({ companySlug, queue }: { companySlug: string; queue: OfflineMutation[] }) {
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => setRefreshTick((current) => current + 1), 6000)
    const handleStorage = () => setRefreshTick((current) => current + 1)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  const scopedQueue = queue.filter((mutation) => mutation.companySlug === companySlug)

  return (
    <div className="offlineQueue">
      <div className="rowBetween">
        <h3>Local Offline Queue</h3>
        <span className="muted">refresh {refreshTick}</span>
      </div>
      {scopedQueue.length ? (
        <ul className="list compact">
          {scopedQueue.map((mutation) => (
            <li key={mutation.id}>
              <strong>
                {mutation.method} {mutation.path}
              </strong>
              <span>
                {mutation.createdAt} · {mutation.userId}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No queued offline mutations.</p>
      )}
    </div>
  )
}
