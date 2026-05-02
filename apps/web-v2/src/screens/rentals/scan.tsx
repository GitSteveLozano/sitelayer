import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import {
  useDispatchMovement,
  useInventoryItems,
  useInventoryLocations,
  useProjects,
  useWorkers,
  type InventoryItem,
} from '@/lib/api'
import { BarcodeScannerSheet, isBarcodeScanSupported } from './barcode-scanner'

/**
 * `rnt-scan-dispatch` — worker scan-driven dispatch flow.
 *
 * Flow (from the design):
 *   1. Worker scans QR/barcode (or types the item code in the manual
 *      fallback when the camera permission is denied).
 *   2. The form auto-resolves the item from the catalog and asks for
 *      project + quantity + deliver/return type.
 *   3. POST /api/inventory/movements with worker_id, scan_payload,
 *      lat/lng, scanned_at — server stamps the audit trail.
 *
 * The browser BarcodeDetector API is used when available (Chrome /
 * Android). When unavailable (Safari / Firefox today), we fall back
 * to manual code entry — UX rule from the brief: degrade gracefully,
 * never block the worker.
 */
export function RentalsScanScreen() {
  const navigate = useNavigate()
  const items = useInventoryItems()
  const locations = useInventoryLocations()
  const projects = useProjects()
  const workers = useWorkers()
  const dispatch = useDispatchMovement()

  const [scanCode, setScanCode] = useState<string>('')
  const [quantity, setQuantity] = useState<string>('1')
  const [movementType, setMovementType] = useState<'deliver' | 'return'>('deliver')
  const [projectId, setProjectId] = useState<string>('')
  const [workerId, setWorkerId] = useState<string>('')
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [coordError, setCoordError] = useState<string | null>(null)
  const [posted, setPosted] = useState<boolean>(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const cameraSupported = useMemo(() => isBarcodeScanSupported(), [])
  // Return-condition check state — only meaningful when movementType ===
  // 'return'. Persisted into scan_payload as `{ scan: ..., condition:
  // { frame: 'ok' | 'flag' | 'na', ... } }` so the audit row carries
  // the foreman's read on the asset's state when it came back to the
  // yard. Sitemap §9 panel 4.
  const [condition, setCondition] = useState<Record<string, 'ok' | 'flag' | 'na'>>({})

  // Resolve item from scanned code. Catalog code is the source of truth;
  // anything else is a typo or wrong sticker.
  const resolved: InventoryItem | null = useMemo(() => {
    if (!scanCode.trim()) return null
    const code = scanCode.trim().toLowerCase()
    return items.data?.inventoryItems.find((i) => i.code.toLowerCase() === code) ?? null
  }, [scanCode, items.data])

  // Fire-and-forget geolocation. The audit trail is "best effort" — if
  // the worker denies the permission we still post the movement, but
  // without lat/lng. Per the AI Layer rule: amber, not red.
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setCoordError('Geolocation unavailable on this device')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => setCoordError(err.message),
      { enableHighAccuracy: true, timeout: 8_000 },
    )
  }, [])

  const defaultYard = useMemo(
    () => locations.data?.inventoryLocations.find((l) => l.is_default && l.location_type === 'yard') ?? null,
    [locations.data],
  )
  const projectLocation = useMemo(
    () => locations.data?.inventoryLocations.find((l) => l.project_id === projectId) ?? null,
    [locations.data, projectId],
  )

  const canSubmit =
    Boolean(resolved) && Boolean(workerId) && Boolean(projectId) && Number(quantity) > 0 && !dispatch.isPending

  const onSubmit = async () => {
    if (!resolved || !canSubmit) return
    const fromLocation = movementType === 'deliver' ? (defaultYard?.id ?? null) : (projectLocation?.id ?? null)
    const toLocation = movementType === 'deliver' ? (projectLocation?.id ?? null) : (defaultYard?.id ?? null)
    // For return movements, embed the condition checks into scan_payload
    // as a structured note alongside the raw scanned code so the audit
    // row carries the foreman's read.
    const payload =
      movementType === 'return' && Object.keys(condition).length > 0
        ? `${scanCode}\ncondition:${JSON.stringify(condition)}`
        : scanCode
    await dispatch.mutateAsync({
      inventory_item_id: resolved.id,
      quantity: Number(quantity),
      movement_type: movementType,
      from_location_id: fromLocation,
      to_location_id: toLocation,
      project_id: projectId,
      worker_id: workerId,
      scan_payload: payload,
      scanned_at: new Date().toISOString(),
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
    })
    setPosted(true)
    setTimeout(() => navigate('/rentals'), 800)
  }

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Rentals · scan dispatch</div>
        <h1 className="mt-1 font-display text-[24px] font-bold tracking-tight leading-tight">Scan to dispatch</h1>
        <p className="text-[12px] text-ink-3 mt-1">
          Scan the QR or type the asset code, then confirm where it's going.
        </p>
      </div>

      <div className="px-4 pb-8 space-y-3">
        <Card>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Asset code</label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="text"
              inputMode="text"
              autoComplete="off"
              value={scanCode}
              onChange={(e) => setScanCode(e.target.value)}
              placeholder="e.g. cup-lock-frame"
              className="flex-1 min-w-0 text-[16px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
            />
            {cameraSupported ? (
              <button
                type="button"
                onClick={() => setCameraOpen(true)}
                className="shrink-0 px-3 py-2 rounded-md bg-accent text-white text-[12px] font-semibold"
                aria-label="Scan barcode with camera"
              >
                Scan
              </button>
            ) : null}
          </div>
          {scanCode && !resolved ? (
            <div className="text-[11px] text-warn mt-1">
              No catalog match for “{scanCode}”. Check the sticker or try the catalog.
            </div>
          ) : resolved ? (
            <div className="text-[12px] text-ink-2 mt-1">
              <span className="font-semibold">{resolved.description}</span> · default $
              {Number(resolved.default_rental_rate).toFixed(2)}/{resolved.unit}
            </div>
          ) : null}
        </Card>

        <Card>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setMovementType('deliver')}
              className={`py-3 rounded-md text-[13px] font-semibold ${
                movementType === 'deliver' ? 'bg-accent text-white' : 'bg-card-soft text-ink-2'
              }`}
            >
              Deliver to job
            </button>
            <button
              type="button"
              onClick={() => setMovementType('return')}
              className={`py-3 rounded-md text-[13px] font-semibold ${
                movementType === 'return' ? 'bg-accent text-white' : 'bg-card-soft text-ink-2'
              }`}
            >
              Return to yard
            </button>
          </div>
        </Card>

        <Card>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Project</label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
          >
            <option value="">Pick a project…</option>
            {(projects.data?.projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <label className="block mt-3 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Worker</label>
          <select
            value={workerId}
            onChange={(e) => setWorkerId(e.target.value)}
            className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
          >
            <option value="">Pick a worker…</option>
            {(workers.data?.workers ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>

          <label className="block mt-3 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
            Quantity
          </label>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="mt-1 w-full text-[16px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
          />
        </Card>

        {movementType === 'return' ? <ConditionPanel value={condition} onChange={setCondition} /> : null}

        <Card tight>
          <div className="flex items-center justify-between">
            <div className="text-[12px] text-ink-3">Location stamp</div>
            {coords ? (
              <Pill tone="good">
                {coords.lat.toFixed(4)}, {coords.lng.toFixed(4)}
              </Pill>
            ) : coordError ? (
              <Pill tone="warn">{coordError}</Pill>
            ) : (
              <Pill tone="default">Waiting…</Pill>
            )}
          </div>
        </Card>

        <Attribution source="POST /api/inventory/movements with scan_payload + worker_id + lat/lng" />

        <MobileButton variant="primary" disabled={!canSubmit} onClick={onSubmit}>
          {dispatch.isPending ? 'Posting…' : posted ? 'Saved ✓' : `Confirm ${movementType}`}
        </MobileButton>

        {dispatch.isError ? (
          <div className="text-[12px] text-warn">{dispatch.error?.message ?? 'Failed to post movement'}</div>
        ) : null}
      </div>

      <BarcodeScannerSheet
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onDetected={(value) => {
          setScanCode(value.trim())
          setCameraOpen(false)
        }}
      />
    </div>
  )
}

/**
 * Condition checklist for the rental return flow (Sitemap §9 panel 4).
 * Four canonical checks; each toggles between three states with a
 * tone-aware row pill so the foreman can flag anything off without
 * leaving the screen.
 *
 * State is persisted to the parent so the submit handler can embed
 * the result in scan_payload — backend keeps the raw movement row,
 * we'll layer a richer return_inspections table later if the volume
 * justifies it.
 */
const CONDITION_CHECKS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'frame', label: 'Frame intact' },
  { id: 'planks', label: 'Planks accounted for' },
  { id: 'cleaned', label: 'Cleaned' },
  { id: 'damage', label: 'Damage / wear noted' },
]

type ConditionStatus = 'ok' | 'flag' | 'na'

function ConditionPanel({
  value,
  onChange,
}: {
  value: Record<string, ConditionStatus>
  onChange: (next: Record<string, ConditionStatus>) => void
}) {
  return (
    <Card>
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-2">Condition check</div>
      <div className="space-y-2">
        {CONDITION_CHECKS.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-ink truncate">{c.label}</span>
            <div className="flex gap-1 shrink-0">
              {(['ok', 'flag', 'na'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={value[c.id] === s}
                  onClick={() => onChange({ ...value, [c.id]: s })}
                  className={
                    value[c.id] === s
                      ? toneActiveClass(s)
                      : 'inline-flex items-center justify-center w-9 h-7 rounded-md text-[11px] font-semibold border bg-card-soft text-ink-3 border-line'
                  }
                >
                  {s === 'ok' ? '✓' : s === 'flag' ? '⚠' : '—'}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-ink-3 mt-3 leading-relaxed">
        Tap ✓ if it came back clean, ⚠ to flag for repair, — if not applicable.
      </div>
    </Card>
  )
}

function toneActiveClass(s: ConditionStatus): string {
  if (s === 'ok')
    return 'inline-flex items-center justify-center w-9 h-7 rounded-md text-[11px] font-semibold border bg-good-soft text-good border-good/30'
  if (s === 'flag')
    return 'inline-flex items-center justify-center w-9 h-7 rounded-md text-[11px] font-semibold border bg-warn-soft text-warn border-warn/30'
  return 'inline-flex items-center justify-center w-9 h-7 rounded-md text-[11px] font-semibold border bg-card text-ink-2 border-line-2'
}
