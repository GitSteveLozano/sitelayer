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
  type InventoryItem,
  type InventoryLocation,
} from '@/lib/api'
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
  MSectionH,
  MSelect,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'

type Mode = 'deliver' | 'return'
type ConditionStatus = 'ok' | 'flag' | 'na'

// Single GOOD / WEAR / DAMAGE grade row (msg__73). One grade per return,
// not a per-attribute matrix.
const GRADES: ReadonlyArray<{ status: ConditionStatus; label: string; desc: string }> = [
  { status: 'ok', label: 'GOOD', desc: 'CLEAN · READY' },
  { status: 'flag', label: 'WEAR', desc: 'NORMAL' },
  { status: 'na', label: 'DAMAGE', desc: 'REPAIR NEEDED' },
]

// Static faux-QR pattern for the scanner target. Computed once at module load
// so it stays stable across re-renders (no Math.random in render).
const QR_CELLS: ReadonlyArray<boolean> = Array.from({ length: 64 }, () => Math.random() > 0.55)

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
  const [items, setItems] = useState<readonly InventoryItem[] | null>(null)
  const [locations, setLocations] = useState<readonly InventoryLocation[]>([])
  const [mode, setMode] = useState<Mode>(initialMode)
  const [assetCode, setAssetCode] = useState('')
  const [projectId, setProjectId] = useState('')
  const [workerId, setWorkerId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [condition, setCondition] = useState<ConditionStatus | null>(null)
  const [note, setNote] = useState('')
  const [photos, setPhotos] = useState<readonly string[]>([])
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
        photos: mode === 'return' && photos.length ? photos : undefined,
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
          notes: mode === 'return' ? mergeReturnNotes(condition, note) : null,
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
    <div className="m-dark">
      <MTopBar
        back
        backVariant="close"
        title={mode === 'return' ? 'RETURN' : 'SCAN TAG'}
        sub={mode === 'return' ? 'CHECK IN TO YARD' : 'DISPATCH TO JOB'}
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

        {/* Camera viewport with faux-QR target frame */}
        <div
          style={{
            position: 'relative',
            margin: '12px 16px 0',
            aspectRatio: '1',
            overflow: 'hidden',
            border: '2px solid var(--m-line)',
            background: 'var(--m-card-soft)',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%,-50%)',
              width: '56%',
              aspectRatio: '1',
            }}
          >
            {/* Corner brackets */}
            <span
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: 32,
                height: 32,
                borderTop: '3px solid var(--m-accent)',
                borderLeft: '3px solid var(--m-accent)',
              }}
            />
            <span
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                width: 32,
                height: 32,
                borderTop: '3px solid var(--m-accent)',
                borderRight: '3px solid var(--m-accent)',
              }}
            />
            <span
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                width: 32,
                height: 32,
                borderBottom: '3px solid var(--m-accent)',
                borderLeft: '3px solid var(--m-accent)',
              }}
            />
            <span
              style={{
                position: 'absolute',
                bottom: 0,
                right: 0,
                width: 32,
                height: 32,
                borderBottom: '3px solid var(--m-accent)',
                borderRight: '3px solid var(--m-accent)',
              }}
            />
            {/* Mock QR target */}
            <div
              aria-hidden
              style={{
                position: 'absolute',
                inset: 24,
                background: 'var(--m-sand)',
                display: 'grid',
                gridTemplateColumns: 'repeat(8, 1fr)',
                gridTemplateRows: 'repeat(8, 1fr)',
              }}
            >
              {QR_CELLS.map((fill, i) => (
                <span key={i} style={{ background: fill ? 'var(--m-ink)' : 'var(--m-sand)' }} />
              ))}
            </div>
          </div>
          <div style={{ position: 'absolute', top: 16, left: 0, right: 0, textAlign: 'center' }}>
            <span
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.06em',
                color: 'var(--m-ink-2)',
              }}
            >
              POINT AT TAG ON ASSET
            </span>
          </div>
        </div>

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
          /* Recognized strip */
          <div
            style={{
              margin: '10px 16px 0',
              padding: '12px 14px',
              background: 'var(--m-accent)',
              color: 'var(--m-accent-ink)',
              border: '2px solid var(--m-line)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span style={{ width: 14, height: 14, background: 'var(--m-accent-ink)' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em' }}>
                RECOGNIZED · {item.code}
              </div>
              <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 14, marginTop: 3 }}>
                {item.description}
              </div>
            </div>
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

        {mode === 'return' ? (
          <ConditionPanel
            grade={condition}
            onGrade={setCondition}
            photos={photos}
            onPhotos={setPhotos}
            note={note}
            onNote={setNote}
          />
        ) : null}

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
              {busy ? 'SAVING…' : mode === 'return' ? 'RETURN TO YARD' : 'DISPATCH FROM HERE'}
            </MButton>
            <MButton variant="ghost" onClick={() => navigate('/rentals')}>
              Cancel
            </MButton>
          </MButtonStack>
        </div>
      </MBody>
    </div>
  )
}

function ConditionPanel({
  grade,
  onGrade,
  photos,
  onPhotos,
  note,
  onNote,
}: {
  grade: ConditionStatus | null
  onGrade: (next: ConditionStatus) => void
  photos: readonly string[]
  onPhotos: (next: readonly string[]) => void
  note: string
  onNote: (next: string) => void
}) {
  // Three optional photo tiles. A real object-storage upload is a follow-up;
  // for now each "+" stamps a placeholder capture reference so the row +
  // payload exercise the structure (mirrors scaffold-inspection's stub).
  const stampPhoto = (slot: number) => {
    const next = [...photos]
    next[slot] = `capture://return/${Date.now()}-${slot}`
    onPhotos(next.filter(Boolean))
  }

  return (
    <>
      {/* CONDITION — single GOOD / WEAR / DAMAGE grade row (msg__73). */}
      <MSectionH>Condition</MSectionH>
      <div style={{ padding: '0 16px' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            border: '2px solid var(--m-line)',
          }}
        >
          {GRADES.map((g, i) => {
            const on = grade === g.status
            return (
              <button
                key={g.status}
                type="button"
                onClick={() => onGrade(g.status)}
                style={{
                  padding: '16px 0',
                  background: on ? 'var(--m-accent)' : 'transparent',
                  color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                  border: 'none',
                  borderRight: i < GRADES.length - 1 ? '2px solid var(--m-line)' : 'none',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 15 }}>{g.label}</div>
                <div
                  style={{
                    fontFamily: 'var(--m-num)',
                    fontSize: 9,
                    marginTop: 4,
                    fontWeight: 600,
                    opacity: 0.75,
                  }}
                >
                  {g.desc}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* PHOTOS · OPTIONAL — three dashed capture tiles (msg__73). */}
      <MSectionH>Photos · optional</MSectionH>
      <div style={{ padding: '0 16px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {[0, 1, 2].map((slot) => {
          const filled = Boolean(photos[slot])
          return (
            <button
              key={slot}
              type="button"
              aria-label={filled ? `Photo ${slot + 1} captured` : `Add photo ${slot + 1}`}
              onClick={() => stampPhoto(slot)}
              style={{
                aspectRatio: '1',
                border: filled ? '2px solid var(--m-accent)' : '2px dashed var(--m-line)',
                background: filled ? 'var(--m-card-soft)' : 'transparent',
                color: filled ? 'var(--m-accent)' : 'var(--m-ink-3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              {filled ? <MI.Check size={22} /> : <MI.Plus size={22} />}
            </button>
          )
        })}
      </div>

      {/* NOTE — free-text condition note (msg__73). */}
      <MSectionH>Note</MSectionH>
      <div style={{ padding: '0 16px' }}>
        <MTextarea
          rows={3}
          placeholder="e.g. Top rail bent slightly. Still usable."
          value={note}
          onChange={(e) => onNote(e.currentTarget.value)}
          style={{ width: '100%' }}
        />
      </div>
    </>
  )
}

/** Merge the single condition grade + the free-text note into the movement
 * note string. Returns null when there's nothing to record. */
function mergeReturnNotes(grade: ConditionStatus | null, note: string): string | null {
  const parts: string[] = []
  if (grade) parts.push(`condition:${grade}`)
  const trimmed = note.trim()
  if (trimmed) parts.push(trimmed)
  return parts.length ? parts.join(' · ') : null
}
