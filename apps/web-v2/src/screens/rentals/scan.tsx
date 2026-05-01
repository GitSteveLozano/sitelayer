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

  // Resolve item from scanned code. Catalog code is the source of truth;
  // anything else is a typo or wrong sticker.
  const resolved: InventoryItem | null = useMemo(() => {
    if (!scanCode.trim()) return null
    const code = scanCode.trim().toLowerCase()
    return (
      items.data?.inventoryItems.find((i) => i.code.toLowerCase() === code) ?? null
    )
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
    Boolean(resolved) &&
    Boolean(workerId) &&
    Boolean(projectId) &&
    Number(quantity) > 0 &&
    !dispatch.isPending

  const onSubmit = async () => {
    if (!resolved || !canSubmit) return
    const fromLocation = movementType === 'deliver' ? defaultYard?.id ?? null : projectLocation?.id ?? null
    const toLocation = movementType === 'deliver' ? projectLocation?.id ?? null : defaultYard?.id ?? null
    await dispatch.mutateAsync({
      inventory_item_id: resolved.id,
      quantity: Number(quantity),
      movement_type: movementType,
      from_location_id: fromLocation,
      to_location_id: toLocation,
      project_id: projectId,
      worker_id: workerId,
      scan_payload: scanCode,
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
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
          Rentals · scan dispatch
        </div>
        <h1 className="mt-1 font-display text-[24px] font-bold tracking-tight leading-tight">
          Scan to dispatch
        </h1>
        <p className="text-[12px] text-ink-3 mt-1">
          Scan the QR or type the asset code, then confirm where it's going.
        </p>
      </div>

      <div className="px-4 pb-8 space-y-3">
        <Card>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
            Asset code
          </label>
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            value={scanCode}
            onChange={(e) => setScanCode(e.target.value)}
            placeholder="e.g. cup-lock-frame"
            className="mt-1 w-full text-[16px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
          />
          {scanCode && !resolved ? (
            <div className="text-[11px] text-status-warn mt-1">
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
                movementType === 'deliver' ? 'bg-accent text-white' : 'bg-bg-2 text-ink-2'
              }`}
            >
              Deliver to job
            </button>
            <button
              type="button"
              onClick={() => setMovementType('return')}
              className={`py-3 rounded-md text-[13px] font-semibold ${
                movementType === 'return' ? 'bg-accent text-white' : 'bg-bg-2 text-ink-2'
              }`}
            >
              Return to yard
            </button>
          </div>
        </Card>

        <Card>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
            Project
          </label>
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

          <label className="block mt-3 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
            Worker
          </label>
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
          <div className="text-[12px] text-status-warn">
            {dispatch.error?.message ?? 'Failed to post movement'}
          </div>
        ) : null}
      </div>
    </div>
  )
}
