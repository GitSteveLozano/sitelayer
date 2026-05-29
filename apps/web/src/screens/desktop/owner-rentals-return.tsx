/**
 * Owner desktop rentals — RETURN + CONDITION (Desktop v2 · RENTALS · RETURN +
 * CONDITION, registry id m-rentr / DRentReturn).
 *
 * Split layout: left column = a condition picker (Good / Wear / Damage
 * grade grid) + a free-text condition note + a photo dropzone; right aside =
 * a live return summary (asset · returning-to-yard · grade · damage charge)
 * with the CONFIRM RETURN button. The desktop twin of the mobile
 * `MobileRentalScan` return mode (rentals-scan.tsx) — same three condition
 * grades, same `useDispatchMovement` plumbing.
 *
 * Reached from the asset detail screen
 * (`/desktop/rentals/:itemId/return`). Parent (DesktopWorkspace) wires the
 * route. On success we navigate back to the asset detail.
 *
 * Wiring: GOOD/WEAR post a `return` movement; DAMAGE posts the canonical
 * `damaged` movement (yard-bound, project-bound from the last dispatch) so
 * the API's auto-bill path can open a replacement-cost charge, and an
 * operator-entered charge amount creates a real damage_charges row via
 * `useCreateDamageCharge`. The project/from-location are resolved from the
 * most recent deliver/transfer movement (`useInventoryMovements`).
 * GAP: there is no returns/damage photo-upload endpoint, so the dropzone
 * records placeholder names and the count rides in the movement notes.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  useDispatchMovement,
  useInventoryItems,
  useInventoryLocations,
  useInventoryMovements,
  type InventoryMovement,
} from '@/lib/api/rentals'
import { useCreateDamageCharge } from '@/lib/api/damage-charges'
import { DEyebrow, DH1 } from '@/components/d'
import { MButton, MInput, MTextarea } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

type Grade = 'good' | 'wear' | 'damage'

const GRADES: ReadonlyArray<{ status: Grade; label: string; desc: string }> = [
  { status: 'good', label: 'GOOD', desc: 'Clean · ready' },
  { status: 'wear', label: 'WEAR', desc: 'Normal wear' },
  { status: 'damage', label: 'DAMAGE', desc: 'Repair needed' },
]

const fieldLabel = {
  fontFamily: 'var(--m-num)',
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--m-ink-3)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase' as const,
}

function Fact({ label, value, valueTone }: { label: string; value: string; valueTone?: 'accent' | 'bad' | undefined }) {
  const color =
    valueTone === 'accent' ? 'var(--m-accent)' : valueTone === 'bad' ? 'var(--m-red)' : 'var(--m-ink)'
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 0',
        borderBottom: '1px solid var(--m-line-2)',
      }}
    >
      <span style={{ fontSize: 13, color: 'var(--m-ink-3)' }}>{label}</span>
      <span className="num" style={{ fontSize: 14, fontWeight: 700, color }}>
        {value}
      </span>
    </div>
  )
}

export function OwnerRentalsReturn() {
  const params = useParams<{ itemId: string }>()
  const navigate = useNavigate()
  const itemId = params.itemId ?? ''

  const itemsQuery = useInventoryItems()
  const locationsQuery = useInventoryLocations()
  const movementsQuery = useInventoryMovements({ itemId })
  const returnMovement = useDispatchMovement()

  const item = useMemo(
    () => (itemsQuery.data?.inventoryItems ?? []).find((i) => i.id === itemId) ?? null,
    [itemsQuery.data?.inventoryItems, itemId],
  )

  // Returns land back in the default yard.
  const yard = useMemo(
    () => (locationsQuery.data?.inventoryLocations ?? []).find((l) => l.location_type === 'yard') ?? null,
    [locationsQuery.data?.inventoryLocations],
  )

  // Resolve where the item is currently out FROM the most recent dispatch
  // (deliver/transfer) so the return movement balances the ledger and we
  // know which project/customer to bill an explicit damage charge against.
  const lastDispatch = useMemo(
    () =>
      (movementsQuery.data?.inventoryMovements ?? []).find(
        (m) => m.movement_type === 'deliver' || m.movement_type === 'transfer',
      ) ?? null,
    [movementsQuery.data?.inventoryMovements],
  )
  const activeProjectId = lastDispatch?.project_id ?? null
  const fromLocationId = lastDispatch?.to_location_id ?? null

  const [grade, setGrade] = useState<Grade>('good')
  const [note, setNote] = useState('')
  // Presentational photo list — names only. There is no returns/damage photo
  // upload endpoint yet (see GAP LIST); the count rides in the movement notes.
  const [photos, setPhotos] = useState<string[]>([])
  const [damageCharge, setDamageCharge] = useState('')

  // Always-constructed (hooks rule); only invoked when activeProjectId is set.
  const createDamageCharge = useCreateDamageCharge(activeProjectId ?? '')

  const isDamage = grade === 'damage'
  const canReturn = Boolean(item) && Boolean(yard) && !returnMovement.isPending && !createDamageCharge.isPending

  const handleReturn = () => {
    if (!canReturn || !item || !yard) return
    const summaryParts = [`Condition: ${grade}`]
    if (note.trim()) summaryParts.push(note.trim())
    if (isDamage && damageCharge) summaryParts.push(`Damage charge ${formatMoney(damageCharge)}`)
    if (photos.length > 0) summaryParts.push(`${photos.length} photo(s)`)

    // DAMAGE returns post the canonical `damaged` movement so the ledger
    // flags them AND the API's auto-bill path can open a replacement-cost
    // charge when the item has a replacement_value; GOOD/WEAR are plain
    // `return` movements. from = the project location it's coming back from,
    // to = the yard.
    const movementType: InventoryMovement['movement_type'] = isDamage ? 'damaged' : 'return'
    const chargeAmount = Number(damageCharge)
    const shouldBillExplicitDamage =
      isDamage && Boolean(activeProjectId) && Number.isFinite(chargeAmount) && chargeAmount > 0

    returnMovement.mutate(
      {
        inventory_item_id: item.id,
        quantity: 1,
        movement_type: movementType,
        from_location_id: fromLocationId,
        to_location_id: yard.id,
        project_id: activeProjectId,
        notes: summaryParts.join(' · '),
      },
      {
        onSuccess: () => {
          // Operator-entered damage charge → a real damage_charges row
          // (kind='damage', open) the office can invoice/waive. Auto-bill in
          // the movement handler only fires off replacement_value, so this is
          // the path for a manually-quoted repair amount.
          if (shouldBillExplicitDamage && activeProjectId) {
            createDamageCharge.mutate(
              {
                kind: 'damage',
                description: `Return damage — ${item.code} ${item.description}`.trim(),
                quantity: 1,
                total_amount: Number(chargeAmount.toFixed(2)),
                inventory_item_id: item.id,
                ...(note.trim() ? { notes: note.trim() } : {}),
              },
              { onSettled: () => navigate(`/desktop/rentals/${item.id}`) },
            )
          } else {
            navigate(`/desktop/rentals/${item.id}`)
          }
        },
      },
    )
  }

  if (!item) {
    return (
      <div className="d-content">
        <div className="d-stack">
          <div>
            <DEyebrow>Owner · Rentals · Return</DEyebrow>
            <DH1>{itemsQuery.isPending ? 'Loading asset…' : 'Asset not found'}</DH1>
          </div>
          {!itemsQuery.isPending ? (
            <div className="d-card" style={{ color: 'var(--m-ink-2)' }}>
              This asset may have been removed from inventory.
              <div style={{ marginTop: 14 }}>
                <MButton variant="primary" onClick={() => navigate('/desktop/rentals')}>
                  Back to rentals
                </MButton>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Rentals · Return · {item.code}</DEyebrow>
          <DH1>Return {item.description}</DH1>
        </div>

        <div className="d-split">
          <div className="d-card">
            <div style={fieldLabel}>Condition</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 8 }}>
              {GRADES.map((g) => {
                const active = grade === g.status
                return (
                  <button
                    key={g.status}
                    type="button"
                    onClick={() => setGrade(g.status)}
                    style={{
                      padding: '16px 12px',
                      border: '2px solid var(--m-ink)',
                      background: active ? 'var(--m-accent)' : 'transparent',
                      color: active ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      font: 'inherit',
                    }}
                  >
                    <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 16 }}>{g.label}</div>
                    <div style={{ fontSize: 11, marginTop: 4, opacity: 0.8 }}>{g.desc}</div>
                  </button>
                )
              })}
            </div>

            <div style={{ ...fieldLabel, marginTop: 22 }}>Note</div>
            <MTextarea
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
              placeholder="Anything the next crew should know…"
              rows={3}
              style={{ marginTop: 8 }}
            />

            {isDamage ? (
              <>
                <div style={{ ...fieldLabel, marginTop: 22 }}>Damage charge</div>
                <MInput
                  value={damageCharge}
                  onChange={(e) => setDamageCharge(e.currentTarget.value)}
                  inputMode="decimal"
                  placeholder="0.00"
                  style={{ marginTop: 8 }}
                />
                {damageCharge && !activeProjectId ? (
                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--m-ink-3)' }}>
                    No active dispatch found for this asset, so the charge can&apos;t be billed to a project. The
                    damage will still be recorded on the movement ledger.
                  </div>
                ) : null}
              </>
            ) : null}

            <div style={{ ...fieldLabel, marginTop: 22 }}>Photos</div>
            {/* GAP: no returns/damage photo-upload endpoint yet. The dropzone
                records placeholder names; the count rides in the movement notes. */}
            <button
              type="button"
              onClick={() => setPhotos((cur) => [...cur, `photo-${cur.length + 1}.jpg`])}
              style={{
                marginTop: 8,
                width: '100%',
                padding: '24px',
                border: '2px dashed var(--m-ink)',
                background: 'var(--m-card-soft)',
                color: 'var(--m-ink-2)',
                cursor: 'pointer',
                font: 'inherit',
                fontSize: 13,
              }}
            >
              + Add photo
            </button>
            {photos.length > 0 ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                {photos.map((p, idx) => (
                  <div
                    key={p}
                    style={{
                      padding: '6px 10px',
                      border: '1px solid var(--m-ink)',
                      fontSize: 12,
                      fontFamily: 'var(--m-num)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    {p}
                    <button
                      type="button"
                      onClick={() => setPhotos((cur) => cur.filter((_, i) => i !== idx))}
                      aria-label={`Remove ${p}`}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', font: 'inherit' }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {returnMovement.isError || createDamageCharge.isError ? (
              <div
                style={{
                  marginTop: 16,
                  padding: '12px 14px',
                  border: '2px solid var(--m-red)',
                  color: 'var(--m-red)',
                  fontFamily: 'var(--m-num)',
                  fontWeight: 600,
                  fontSize: 12,
                }}
              >
                {returnMovement.error instanceof Error
                  ? returnMovement.error.message
                  : createDamageCharge.error instanceof Error
                    ? `Return recorded, but the damage charge failed: ${createDamageCharge.error.message}`
                    : 'Return failed.'}
              </div>
            ) : null}
          </div>

          <aside className="d-card" style={{ position: 'sticky', top: 16, alignSelf: 'start' }}>
            <div className="d-eyebrow">Return summary</div>
            <Fact label="Asset" value={`${item.code} · ${item.description}`} />
            <Fact label="Returning to" value={yard?.name ?? '—'} valueTone={yard ? undefined : 'bad'} />
            <Fact
              label="Condition"
              value={grade.toUpperCase()}
              valueTone={isDamage ? 'bad' : grade === 'wear' ? 'accent' : undefined}
            />
            {isDamage ? (
              <Fact label="Damage charge" value={damageCharge ? formatMoney(damageCharge) : '—'} valueTone="bad" />
            ) : null}
            <Fact label="Photos" value={String(photos.length)} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 22 }}>
              <MButton variant="primary" disabled={!canReturn} onClick={handleReturn}>
                {returnMovement.isPending || createDamageCharge.isPending ? 'Recording…' : 'Confirm return'}
              </MButton>
              <MButton variant="ghost" onClick={() => navigate(`/desktop/rentals/${item.id}`)}>
                Cancel
              </MButton>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
