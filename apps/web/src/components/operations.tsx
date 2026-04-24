import { useEffect, useState, type PointerEvent } from 'react'
import {
  calculatePolygonArea,
  calculatePolygonCentroid,
  calculateTakeoffQuantity,
  clampBoardCoordinate,
  formatMoney,
  normalizePolygonGeometry,
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
                Revenue {formatMoney(division.revenue)} · Cost {formatMoney(division.cost)} · Margin {formatMoney(division.margin)}
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
        <input name="expected_version" type="hidden" defaultValue={project.version} />
        <input name="name" defaultValue={project.name} placeholder="Project name" />
        <input name="customer_name" defaultValue={project.customer_name} placeholder="Customer / builder" />
        <select name="division_code" defaultValue={project.division_code}>
          {divisions.map((division) => (
            <option key={division.code} value={division.code}>
              {division.code} - {division.name}
            </option>
          ))}
        </select>
        <input name="status" defaultValue={project.status} placeholder="Status" />
        <input name="bid_total" defaultValue={Number(project.bid_total)} type="number" step="0.01" placeholder="Bid total" />
        <input name="labor_rate" defaultValue={Number(project.labor_rate)} type="number" step="0.01" placeholder="Labor rate" />
        <input
          name="target_sqft_per_hr"
          defaultValue={project.target_sqft_per_hr ? Number(project.target_sqft_per_hr) : ''}
          type="number"
          step="0.01"
          placeholder="Target sqft/hr"
        />
        <input name="bonus_pool" defaultValue={Number(project.bonus_pool)} type="number" step="0.01" placeholder="Bonus pool" />
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
          <span className="muted compact">{customer.external_id ? `External ID ${customer.external_id}` : 'Local-only customer'}</span>
        </div>
        <div className="stacked alignRight">
          <span className="badge">{customer.source}</span>
          <span className="muted compact">v{customer.version}</span>
        </div>
      </div>
      <FormRow actionLabel="Save customer" busy={busy} onSubmit={onSubmit}>
        <input name="expected_version" type="hidden" defaultValue={customer.version} />
        <input name="name" defaultValue={customer.name} placeholder="Customer name" />
        <input name="external_id" defaultValue={customer.external_id ?? ''} placeholder="External ID" />
        <input name="source" defaultValue={customer.source} placeholder="Source" />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
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
          <span className="muted compact">
            {blueprint.replaces_blueprint_document_id ? 'revision' : 'source'}
          </span>
        </div>
      </div>
      <p className="muted compact">History: {lineage}</p>
      <FormRow actionLabel="Save blueprint" busy={busy} onSubmit={onSubmit}>
        <input name="expected_version" type="hidden" defaultValue={blueprint.version} />
        <input name="file_name" defaultValue={blueprint.file_name} placeholder="Blueprint file name" />
        <input name="storage_path" defaultValue={blueprint.storage_path} placeholder="Storage path" />
        <input name="preview_type" defaultValue={blueprint.preview_type} placeholder="Preview type" />
        <input name="calibration_length" defaultValue={blueprint.calibration_length ?? ''} placeholder="Calibration length" type="number" step="0.01" />
        <input name="calibration_unit" defaultValue={blueprint.calibration_unit ?? ''} placeholder="Calibration unit" />
        <input name="sheet_scale" defaultValue={blueprint.sheet_scale ?? ''} placeholder="Sheet scale" type="number" step="0.0001" />
        <input name="blueprint_file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/*" />
      </FormRow>
      <FormRow actionLabel="Create version" busy={busy} onSubmit={onCreateVersion}>
        <input name="file_name" defaultValue={blueprint.file_name} placeholder="Version file name" />
        <input name="storage_path" defaultValue={blueprint.storage_path} placeholder="Storage path" />
        <input name="preview_type" defaultValue={blueprint.preview_type} placeholder="Preview type" />
        <input name="calibration_length" defaultValue={blueprint.calibration_length ?? ''} placeholder="Calibration length" type="number" step="0.01" />
        <input name="calibration_unit" defaultValue={blueprint.calibration_unit ?? ''} placeholder="Calibration unit" />
        <input name="sheet_scale" defaultValue={blueprint.sheet_scale ?? ''} placeholder="Sheet scale" type="number" step="0.0001" />
        <input name="blueprint_file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/*" />
        <label className="checkbox">
          <input name="copy_measurements" type="checkbox" defaultChecked />
          <span>Copy measurements forward</span>
        </label>
      </FormRow>
      <p className="muted compact">
        File preview: {blueprint.file_url ? blueprint.file_url : 'not stored yet'} · Base storage: {blueprint.storage_path}
      </p>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
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
      <FormRow
        actionLabel="Save pricing profile"
        busy={busy}
        onSubmit={(form) => onSubmit(form)}
      >
        <input name="expected_version" type="hidden" defaultValue={profile.version} />
        <input name="name" defaultValue={profile.name} placeholder="Profile name" />
        <label className="checkbox">
          <input name="is_default" type="checkbox" defaultChecked={profile.is_default} />
          <span>Default profile</span>
        </label>
        <textarea
          name="config"
          rows={4}
          defaultValue={JSON.stringify(profile.config, null, 2)}
          placeholder='{"template":"la-default"}'
        />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
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
        <input name="expected_version" type="hidden" defaultValue={rule.version} />
        <input name="name" defaultValue={rule.name} placeholder="Rule name" />
        <label className="checkbox">
          <input name="is_active" type="checkbox" defaultChecked={rule.is_active} />
          <span>Active rule</span>
        </label>
        <textarea
          name="config"
          rows={4}
          defaultValue={JSON.stringify(rule.config, null, 2)}
          placeholder='{"basis":"margin","threshold":0.15}'
        />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
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
        <input name="expected_version" type="hidden" defaultValue={mapping.version} />
        <select name="entity_type" defaultValue={mapping.entity_type}>
          <option value="customer">customer</option>
          <option value="service_item">service_item</option>
          <option value="division">division</option>
          <option value="project">project</option>
        </select>
        <input name="local_ref" defaultValue={mapping.local_ref} placeholder="Local ref" />
        <input name="external_id" defaultValue={mapping.external_id} placeholder="QBO external id" />
        <input name="label" defaultValue={mapping.label ?? ''} placeholder="Label" />
        <input name="status" defaultValue={mapping.status} placeholder="Status" />
        <input name="notes" defaultValue={mapping.notes ?? ''} placeholder="Notes" />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
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
        <input name="expected_version" type="hidden" defaultValue={worker.version} />
        <input name="name" defaultValue={worker.name} placeholder="Worker name" />
        <input name="role" defaultValue={worker.role} placeholder="Role" />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
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
        <input name="expected_version" type="hidden" defaultValue={measurement.version} />
        <select name="service_item_code" defaultValue={measurement.service_item_code}>
          {serviceItems.map((item) => (
            <option key={item.code} value={item.code}>
              {item.code} - {item.name}
            </option>
          ))}
        </select>
        <input name="quantity" defaultValue={Number(measurement.quantity)} type="number" step="0.01" />
        <input name="unit" defaultValue={measurement.unit} placeholder="Unit" />
        <input name="notes" defaultValue={measurement.notes ?? ''} placeholder="Notes" />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
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
        <input name="expected_version" type="hidden" defaultValue={bill.version} />
        <input name="vendor" defaultValue={bill.vendor} placeholder="Vendor" />
        <input name="amount" defaultValue={Number(bill.amount)} type="number" step="0.01" />
        <input name="bill_type" defaultValue={bill.bill_type} placeholder="Type" />
        <input name="description" defaultValue={bill.description ?? ''} placeholder="Description" />
        <input name="occurred_on" defaultValue={bill.occurred_on ?? ''} placeholder="Occurred on" />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
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
        <input name="expected_version" type="hidden" defaultValue={laborEntry.version} />
        <select name="worker_id" defaultValue={laborEntry.worker_id ?? ''}>
          <option value="">Worker</option>
          {workers.map((worker) => (
            <option key={worker.id} value={worker.id}>
              {worker.name}
            </option>
          ))}
        </select>
        <select name="service_item_code" defaultValue={laborEntry.service_item_code}>
          {serviceItems.map((item) => (
            <option key={item.code} value={item.code}>
              {item.code} - {item.name}
            </option>
          ))}
        </select>
        <input name="hours" defaultValue={Number(laborEntry.hours)} type="number" step="0.25" placeholder="Hours" />
        <input name="sqft_done" defaultValue={Number(laborEntry.sqft_done)} type="number" step="0.1" placeholder="Sqft done" />
        <input name="status" defaultValue={laborEntry.status} placeholder="Status" />
        <input name="occurred_on" defaultValue={laborEntry.occurred_on} type="date" />
      </FormRow>
      <div className="actions">
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
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
  const [quantityMultiplier, setQuantityMultiplier] = useState(1)
  const [calibrationLength, setCalibrationLength] = useState('100')
  const [calibrationUnit, setCalibrationUnit] = useState('ft')

  const activeBlueprint = blueprints.find((blueprint) => blueprint.id === selectedBlueprintId) ?? blueprints[0] ?? null
  const blueprintMeasurements = measurements.filter((measurement) => measurement.blueprint_document_id === activeBlueprint?.id)
  const quantityMultiplierValue = Number.isFinite(quantityMultiplier) && quantityMultiplier > 0 ? quantityMultiplier : 1
  const draftArea = calculatePolygonArea(draftPoints)
  const draftQuantity = calculateTakeoffQuantity(draftPoints, quantityMultiplierValue)
  const selectedServiceItem = serviceItems.find((item) => item.code === serviceItemCode)
  const selectedUnit = selectedServiceItem?.unit ?? 'sqft'

  useEffect(() => {
    if (!selectedBlueprintId && blueprints[0]) {
      onSelectBlueprint(blueprints[0].id)
    }
  }, [blueprints, onSelectBlueprint, selectedBlueprintId])

  useEffect(() => {
    setDraftPoints([])
    setPointerPoint(null)
    const sheetScale = Number(activeBlueprint?.sheet_scale ?? 1)
    setQuantityMultiplier(Number.isFinite(sheetScale) && sheetScale > 0 ? sheetScale : 1)
    setCalibrationLength(activeBlueprint?.calibration_length ?? '100')
    setCalibrationUnit(activeBlueprint?.calibration_unit ?? 'ft')
  }, [activeBlueprint?.id])

  useEffect(() => {
    if (!serviceItemCode && serviceItems[0]) {
      setServiceItemCode(serviceItems[0].code)
    }
  }, [serviceItemCode, serviceItems])

  async function saveDraftMeasurement() {
    if (!activeBlueprint) {
      throw new Error('select a blueprint first')
    }
    if (!serviceItemCode) {
      throw new Error('service item is required')
    }
    if (draftPoints.length < 3) {
      throw new Error('draw at least 3 points')
    }
    if (!Number.isFinite(quantityMultiplier) || quantityMultiplier <= 0) {
      throw new Error('quantity multiplier must be greater than zero')
    }
    if (draftQuantity <= 0) {
      throw new Error('polygon area must be greater than zero')
    }
    setBusy(true)
    setError(null)
    try {
      await apiPost(
        `/api/projects/${projectId}/takeoff/measurement`,
        {
          blueprint_document_id: activeBlueprint.id,
          service_item_code: serviceItemCode,
          quantity: draftQuantity,
          unit: selectedUnit,
          notes: `polygon:${draftPoints.length}`,
          geometry: {
            kind: 'polygon',
            points: draftPoints,
            sheet_scale: quantityMultiplierValue,
            calibration_length: Number(calibrationLength) || null,
            calibration_unit: calibrationUnit,
          },
        },
        companySlug,
      )
      setDraftPoints([])
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
          <select value={activeBlueprint?.id ?? ''} onChange={(event) => onSelectBlueprint(event.target.value)}>
            <option value="">Choose blueprint</option>
            {blueprints.map((blueprint) => (
              <option key={blueprint.id} value={blueprint.id}>
                {blueprint.file_name} · v{blueprint.version}
              </option>
            ))}
          </select>
        </label>
        <label className="selectWrap">
          <span>Service item</span>
          <select value={serviceItemCode} onChange={(event) => setServiceItemCode(event.target.value)}>
            {serviceItems.map((item) => (
              <option key={item.code} value={item.code}>
                {item.code} · {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="selectWrap">
          <span>Quantity multiplier</span>
          <input value={quantityMultiplier} onChange={(event) => setQuantityMultiplier(Number(event.target.value))} type="number" step="0.01" />
        </label>
        <label className="selectWrap">
          <span>Calibration length</span>
          <input value={calibrationLength} onChange={(event) => setCalibrationLength(event.target.value)} type="number" step="0.01" />
        </label>
        <label className="selectWrap">
          <span>Calibration unit</span>
          <input value={calibrationUnit} onChange={(event) => setCalibrationUnit(event.target.value)} />
        </label>
        <label className="selectWrap">
          <span>Zoom</span>
          <input value={zoom} onChange={(event) => setZoom(Number(event.target.value))} type="range" min="0.6" max="2.2" step="0.1" />
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
              setPointerPoint(getBoardPointerPoint(event))
            }}
            onPointerLeave={() => setPointerPoint(null)}
            onPointerDown={(event) => {
              if (event.pointerType === 'mouse' && event.button !== 0) return
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              setDraftPoints((current) => [...current, getBoardPointerPoint(event)])
            }}
          >
            {pointerPoint ? (
              <>
                <line x1={pointerPoint.x} y1={0} x2={pointerPoint.x} y2={100} className="takeoffCrosshair" />
                <line x1={0} y1={pointerPoint.y} x2={100} y2={pointerPoint.y} className="takeoffCrosshair" />
              </>
            ) : null}
            {blueprintMeasurements
              .map((measurement) => {
                const geometry = normalizePolygonGeometry(measurement.geometry)
                if (!geometry) return null
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
              })}
            {draftPoints.length > 0 ? (
              <>
                <polyline points={polygonPointsToString(draftPoints)} className="takeoffLine draftLine" />
                <polygon points={polygonPointsToString(draftPoints)} className="takeoffPolygon draftPolygon" />
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
        <button type="button" onClick={() => setDraftPoints([])} disabled={busy || !draftPoints.length}>
          Clear draft
        </button>
        <button type="button" onClick={() => setDraftPoints((current) => current.slice(0, -1))} disabled={busy || !draftPoints.length}>
          Undo point
        </button>
        <button type="button" onClick={() => void saveDraftMeasurement()} disabled={busy || draftPoints.length < 3}>
          Save polygon
        </button>
      </div>

      <div className="takeoffMeta">
        <div>
          <strong>{activeBlueprint?.file_name ?? 'No blueprint selected'}</strong>
          <p className="muted">
            {activeBlueprint ? `v${activeBlueprint.version} · ${activeBlueprint.deleted_at ? 'deleted' : 'active'}` : 'Choose a blueprint to start drawing.'}
          </p>
        </div>
        <div>
          <strong>{draftQuantity} {selectedUnit}</strong>
          <p className="muted">{draftPoints.length} points · board area {draftArea.toFixed(2)} × {quantityMultiplierValue}</p>
        </div>
        <div>
          <strong>{calibrationLength || '0'} {calibrationUnit}</strong>
          <p className="muted">Calibration metadata is saved with each measurement for later refinement.</p>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
      <p className="muted takeoffHint">
        Click or tap the board to place vertices. The current draft is highlighted with numbered points and a live crosshair.
      </p>
      <ul className="list compact takeoffMeasurements">
        {blueprintMeasurements.length ? (
          blueprintMeasurements.map((measurement) => (
            <li key={measurement.id}>
              <strong>{measurement.service_item_code}</strong>
              <span>
                {measurement.quantity} {measurement.unit}
                {measurement.notes ? ` · ${measurement.notes}` : ''}
              </span>
            </li>
          ))
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

export function getBlueprintLineageLabel(blueprints: BlueprintRow[], blueprintId: string) {
  const byId = new Map(blueprints.map((blueprint) => [blueprint.id, blueprint]))
  const chain: BlueprintRow[] = []
  const seen = new Set<string>()
  let current = byId.get(blueprintId) ?? null
  while (current && !seen.has(current.id)) {
    chain.push(current)
    seen.add(current.id)
    current = current.replaces_blueprint_document_id ? byId.get(current.replaces_blueprint_document_id) ?? null : null
  }
  const labels = chain
    .slice()
    .reverse()
    .map((blueprint) => `v${blueprint.version}`)
  return labels.length ? labels.join(' → ') : `v${byId.get(blueprintId)?.version ?? 1}`
}

export function MutationOutboxWidget({ companySlug, refreshKey }: { companySlug: string; refreshKey: number }) {
  const [data, setData] = useState<{ outbox: Array<{ entity_type: string; entity_id: string; mutation_type: string; status: string; created_at: string }> } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = () =>
    apiGet<{ outbox: Array<{ entity_type: string; entity_id: string; mutation_type: string; status: string; created_at: string }> }>('/api/sync/outbox?limit=5', companySlug)
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
              <strong>{mutation.method} {mutation.path}</strong>
              <span>{mutation.createdAt} · {mutation.userId}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No queued offline mutations.</p>
      )}
    </div>
  )
}
