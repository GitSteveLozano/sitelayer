/**
 * Canonical mobile rental scan / return flow.
 *
 * This replaces the old full-screen scanner route for the role-aware
 * shell. It keeps camera scanning as a progressive enhancement: browsers
 * without BarcodeDetector still get a fast manual tag entry.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  apiPost,
  listInventoryItems,
  listInventoryLocations,
  type BootstrapResponse,
  type InventoryItemRow,
  type InventoryLocationRow,
} from '../../api-v1-compat.js'
import {
  MBody,
  MButton,
  MButtonStack,
  MChip,
  MChipRow,
  MI,
  MInput,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MSelect,
  MTopBar,
} from '../../components/m/index.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'

type Mode = 'deliver' | 'return'
type ConditionStatus = 'ok' | 'flag' | 'na'

const CONDITION_CHECKS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'frame', label: 'Frame intact' },
  { id: 'parts', label: 'Parts accounted for' },
  { id: 'clean', label: 'Clean enough for next job' },
  { id: 'damage', label: 'Damage noted' },
]

export function MobileRentalScan({
  bootstrap,
  companySlug,
  initialMode = 'deliver',
}: {
  bootstrap: BootstrapResponse | null
  companySlug: string
  initialMode?: Mode
}) {
  const navigate = useNavigate()
  const [items, setItems] = useState<readonly InventoryItemRow[] | null>(null)
  const [locations, setLocations] = useState<readonly InventoryLocationRow[]>([])
  const [mode, setMode] = useState<Mode>(initialMode)
  const [assetCode, setAssetCode] = useState('')
  const [projectId, setProjectId] = useState('')
  const [workerId, setWorkerId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [condition, setCondition] = useState<Record<string, ConditionStatus>>({})
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([listInventoryItems(companySlug), listInventoryLocations(companySlug)])
      .then(([itemRes, locationRes]) => {
        if (cancelled) return
        setItems(itemRes.inventoryItems.filter((i) => !i.deleted_at))
        setLocations(locationRes.inventoryLocations.filter((l) => !l.deleted_at))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setItems([])
      })
    return () => {
      cancelled = true
    }
  }, [companySlug])

  useEffect(() => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (pos) => setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setCoords(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    )
  }, [])

  const item = useMemo(() => {
    const code = assetCode.trim().toLowerCase()
    if (!code || !items) return null
    return items.find((i) => i.code.toLowerCase() === code) ?? null
  }, [assetCode, items])

  const yard =
    locations.find((l) => l.location_type === 'yard' && l.is_default) ??
    locations.find((l) => l.location_type === 'yard')
  const projectLocation = locations.find((l) => l.project_id === projectId) ?? null
  const workers = bootstrap?.workers.filter((w) => !w.deleted_at) ?? []
  const projects = (bootstrap?.projects ?? []).filter((p) => /active|progress|accepted/i.test(p.status))
  const available = (items ?? []).filter((i) => i.active)
  const out = (items ?? []).filter((i) => !i.active)
  const submitDisabled = !item || Number(quantity) <= 0 || busy

  const handleSubmit = async () => {
    if (!item || submitDisabled) return
    setBusy(true)
    setError(null)
    try {
      const scanPayload = JSON.stringify({
        assetCode: assetCode.trim(),
        source: 'mobile-shell',
        condition: mode === 'return' ? condition : undefined,
      })
      await apiPost(
        '/api/inventory/movements',
        {
          inventory_item_id: item.id,
          quantity: Number(quantity),
          movement_type: mode,
          from_location_id: mode === 'deliver' ? (yard?.id ?? null) : (projectLocation?.id ?? null),
          to_location_id: mode === 'deliver' ? (projectLocation?.id ?? null) : (yard?.id ?? null),
          project_id: projectId || null,
          worker_id: workerId || null,
          scan_payload: scanPayload,
          scanned_at: new Date().toISOString(),
          lat: coords?.lat ?? null,
          lng: coords?.lng ?? null,
          notes: mode === 'return' ? summarizeCondition(condition) : null,
        },
        companySlug,
      )
      navigate('/rentals')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <MTopBar
        back
        title={mode === 'return' ? 'Return equipment' : 'Scan equipment'}
        sub={mode === 'return' ? 'Check in to yard' : 'Dispatch to job'}
        onBack={() => navigate('/rentals')}
      />
      <MBody>
        <MChipRow>
          <MChip active={mode === 'deliver'} onClick={() => setMode('deliver')}>
            Dispatch
          </MChip>
          <MChip active={mode === 'return'} onClick={() => setMode('return')}>
            Return
          </MChip>
        </MChipRow>

        <MSectionH>Asset tag</MSectionH>
        <div style={{ padding: '0 16px', display: 'flex', gap: 8 }}>
          <MInput
            value={assetCode}
            onChange={(e) => setAssetCode(e.currentTarget.value)}
            placeholder="Type or scan asset code"
            autoCapitalize="characters"
            style={{ flex: 1 }}
          />
          <MButton
            variant="quiet"
            onClick={() => setAssetCode((mode === 'return' ? out[0] : available[0])?.code ?? '')}
          >
            <MI.Camera size={18} />
          </MButton>
        </div>
        {assetCode && !item ? (
          <div style={{ padding: '8px 16px 0', color: 'var(--m-amber)', fontSize: 13 }}>
            No catalog match for {assetCode}. Check the sticker.
          </div>
        ) : item ? (
          <div style={{ padding: '8px 16px 0' }}>
            <MPill tone={item.active ? 'green' : 'amber'} dot>
              {item.description} · {item.code}
            </MPill>
          </div>
        ) : null}

        <MSectionH>{mode === 'return' ? 'Coming from' : 'Going to'}</MSectionH>
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <MSelect value={projectId} onChange={(e) => setProjectId(e.currentTarget.value)}>
            <option value="">{mode === 'return' ? 'Pick source project...' : 'Pick destination project...'}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </MSelect>
          <MSelect value={workerId} onChange={(e) => setWorkerId(e.currentTarget.value)}>
            <option value="">Worker / driver optional</option>
            {workers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </MSelect>
          <MInput
            type="number"
            inputMode="decimal"
            min="0"
            value={quantity}
            onChange={(e) => setQuantity(e.currentTarget.value)}
            placeholder="Quantity"
          />
        </div>

        {mode === 'return' ? <ConditionPanel value={condition} onChange={setCondition} /> : null}

        <MSectionH>{mode === 'return' ? 'Out now' : 'Available now'}</MSectionH>
        {items === null ? (
          <MSkeletonList count={4} />
        ) : (mode === 'return' ? out : available).length === 0 ? (
          <MEmptyState
            title={mode === 'return' ? 'Nothing is marked out' : 'No equipment available'}
            body={
              mode === 'return'
                ? 'Returns will appear once equipment is dispatched.'
                : 'Add equipment or return items to the yard.'
            }
          />
        ) : (
          <MListInset>
            {(mode === 'return' ? out : available).slice(0, 8).map((i) => (
              <MListRow
                key={i.id}
                leading={<MI.Truck size={18} />}
                leadingTone={assetCode === i.code ? 'accent' : undefined}
                headline={i.description}
                supporting={`${i.code} · ${i.category}`}
                trailing={
                  <span className="num">
                    ${i.default_rental_rate}/{i.unit || 'day'}
                  </span>
                }
                onTap={() => setAssetCode(i.code)}
              />
            ))}
          </MListInset>
        )}

        {coords ? (
          <div style={{ padding: '8px 16px 0', fontSize: 12, color: 'var(--m-ink-3)' }}>
            Location stamped · {coords.lat.toFixed(4)}, {coords.lng.toFixed(4)}
          </div>
        ) : null}
        {error ? <div style={{ padding: '10px 16px 0', color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
        <div style={{ padding: 16 }}>
          <MButtonStack>
            <MButton variant="primary" disabled={submitDisabled} onClick={handleSubmit}>
              {busy ? 'Saving...' : mode === 'return' ? 'Check in to yard' : 'Dispatch to job'}
            </MButton>
            <MButton variant="ghost" onClick={() => navigate('/rentals')}>
              Cancel
            </MButton>
          </MButtonStack>
        </div>
      </MBody>
    </>
  )
}

function ConditionPanel({
  value,
  onChange,
}: {
  value: Record<string, ConditionStatus>
  onChange: (next: Record<string, ConditionStatus>) => void
}) {
  return (
    <>
      <MSectionH>Condition</MSectionH>
      <MListInset>
        {CONDITION_CHECKS.map((check) => (
          <MListRow
            key={check.id}
            headline={check.label}
            trailing={
              <span style={{ display: 'inline-flex', gap: 4 }}>
                {(['ok', 'flag', 'na'] as const).map((status) => (
                  <button
                    key={status}
                    type="button"
                    className="m-chip"
                    data-active={value[check.id] === status ? 'true' : undefined}
                    onClick={() => onChange({ ...value, [check.id]: status })}
                    style={{ padding: '4px 8px', fontSize: 11 }}
                  >
                    {status === 'ok' ? 'OK' : status === 'flag' ? 'Flag' : 'N/A'}
                  </button>
                ))}
              </span>
            }
          />
        ))}
      </MListInset>
    </>
  )
}

function summarizeCondition(condition: Record<string, ConditionStatus>): string | null {
  const entries = Object.entries(condition)
  if (entries.length === 0) return null
  return entries.map(([key, value]) => `${key}:${value}`).join(', ')
}
