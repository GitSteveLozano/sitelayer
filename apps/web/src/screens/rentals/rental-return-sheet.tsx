import { useEffect, useMemo, type ReactNode } from 'react'
import { MButton, MI, MPill } from '@/components/m'
import { Attribution } from '@/components/ai'
import { useRentalReturn, type RentalRow } from '@/lib/api'
import { useRentalReturn as useRentalReturnMachine } from '@/machines/rental-return'

/**
 * `rnt-return-sheet` — returns reconciliation modal.
 *
 * Wired from `rentals/scan.tsx` (after a return movement) and from
 * `inventory-admin/rental-contract.tsx` (line-level return). Mirrors the
 * design's three-tone layout (Good / Damaged / Lost) plus optional photo
 * upload and a damage charge calculator.
 *
 * The xstate machine in `machines/rental-return.ts` owns transient UI state
 * (counts, photos, charges, isSubmitting). The API hook is responsible for
 * persistence; on success the parent closes the sheet via the `onSuccess`
 * callback.
 */
export interface RentalReturnSheetProps {
  open: boolean
  onClose: () => void
  rentalId: string
  /** Original quantity dispatched on the rental, for the sum-validation. */
  originalQty?: number
  /** Replacement value (cents) for the asset; drives the damage charge calc. */
  replacementValueCents?: number
  /** Humanized label for the rental row (used in the sheet header). */
  itemLabel?: string
  onSuccess?: (row: RentalRow) => void
}

// Damage charge defaults (matches the design copy in views-rentals.jsx):
//   damaged units → 15% of replacement
//   lost units    → 100% of replacement
// Frontend computes a suggested charge; the operator can override before
// submit. Server takes whatever cents value the client sends.
function suggestDamageChargesCents(
  damaged: number,
  lost: number,
  replacementValueCents: number | null | undefined,
): number {
  const replacement = Math.max(0, Math.floor(Number(replacementValueCents ?? 0)))
  const damagedCharge = Math.round(damaged * replacement * 0.15)
  const lostCharge = lost * replacement
  return damagedCharge + lostCharge
}

export function RentalReturnSheet({
  open,
  onClose,
  rentalId,
  originalQty,
  replacementValueCents,
  itemLabel,
  onSuccess,
}: RentalReturnSheetProps) {
  const mutate = useRentalReturn(rentalId)
  const machine = useRentalReturnMachine<RentalRow>(async (payload) => {
    const row = await mutate.mutateAsync(payload)
    return row
  })

  const sum = machine.counts.qty_good + machine.counts.qty_damaged + machine.counts.qty_lost
  const remaining = originalQty != null ? Math.max(0, originalQty - sum) : null
  const overcommit = originalQty != null && sum > originalQty

  const suggestedCents = useMemo(
    () => suggestDamageChargesCents(machine.counts.qty_damaged, machine.counts.qty_lost, replacementValueCents),
    [machine.counts.qty_damaged, machine.counts.qty_lost, replacementValueCents],
  )

  const onSubmit = async () => {
    if (overcommit) return
    if (sum <= 0) return
    machine.submit({
      qty_good: machine.counts.qty_good,
      qty_damaged: machine.counts.qty_damaged,
      qty_lost: machine.counts.qty_lost,
      damage_photos: machine.photos,
      damage_charges_cents: machine.damageChargesCents || suggestedCents,
      ...(originalQty != null ? { original_qty: originalQty } : {}),
    })
  }

  // When the machine reports success, hand the result back and close.
  if (machine.success && machine.result) {
    onSuccess?.(machine.result)
    machine.reset()
    onClose()
  }

  if (!open) return null

  return (
    <MSheet title={itemLabel ? `Return — ${itemLabel}` : 'Return'} onClose={onClose}>
      <div className="space-y-3">
        {originalQty != null ? (
          <div className="text-[12px] text-ink-3">
            Out: <span className="num">{originalQty}</span> · accounted for{' '}
            <span className="num">{Math.min(sum, originalQty)}</span> · remaining{' '}
            <span className="num">{remaining ?? 0}</span>
          </div>
        ) : null}

        <CountRow
          label="Good"
          help="Back in inventory at full"
          tone="good"
          value={machine.counts.qty_good}
          onChange={(v) => machine.setCount('qty_good', v)}
        />
        <CountRow
          label="Damaged"
          help="15% of replacement value"
          tone="warn"
          value={machine.counts.qty_damaged}
          onChange={(v) => machine.setCount('qty_damaged', v)}
        />
        <CountRow
          label="Lost"
          help="100% of replacement value"
          tone="danger"
          value={machine.counts.qty_lost}
          onChange={(v) => machine.setCount('qty_lost', v)}
        />

        <div className="m-card m-card-tight">
          <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
            Damage charge (cents)
          </label>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            value={machine.damageChargesCents || suggestedCents}
            onChange={(e) => machine.setCharges(Number(e.target.value || 0))}
            className="mt-1 w-full text-[15px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent num"
          />
          {suggestedCents > 0 ? (
            <div className="text-[11px] text-ink-3 mt-1">
              Suggested ${(suggestedCents / 100).toFixed(2)} based on damaged/lost counts
            </div>
          ) : null}
        </div>

        <PhotoSlot
          photos={machine.photos}
          onChange={machine.setPhotos}
          required={machine.counts.qty_damaged > 0 || machine.counts.qty_lost > 0}
        />

        {overcommit ? (
          <div className="text-[12px] text-warn">
            Sum exceeds original ({sum} of {originalQty}) — adjust counts before saving.
          </div>
        ) : null}
        {machine.error ? <div className="text-[12px] text-warn">{machine.error}</div> : null}

        <Attribution source="POST /api/rentals/:id/return — sets returned_on=now() and status='returned'" />

        <MButton variant="primary" onClick={onSubmit} disabled={machine.isSubmitting || overcommit || sum <= 0}>
          {machine.isSubmitting ? 'Saving…' : 'Receive return'}
        </MButton>
      </div>
    </MSheet>
  )
}

function CountRow({
  label,
  help,
  tone,
  value,
  onChange,
}: {
  label: string
  help: string
  tone: 'good' | 'warn' | 'danger'
  value: number
  onChange: (next: number) => void
}) {
  const pillTone: 'green' | 'amber' = tone === 'good' ? 'green' : 'amber'
  return (
    <div className="m-card m-card-tight">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <MPill tone={pillTone}>{label}</MPill>
          <div className="text-[11px] text-ink-3 mt-1">{help}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            aria-label={`Decrease ${label}`}
            className="w-9 h-9 bg-card-soft text-[18px] font-semibold"
            onClick={() => onChange(Math.max(0, value - 1))}
          >
            −
          </button>
          <span className="num text-[18px] font-semibold w-8 text-center">{value}</span>
          <button
            type="button"
            aria-label={`Increase ${label}`}
            className="w-9 h-9 bg-card-soft text-[18px] font-semibold"
            onClick={() => onChange(value + 1)}
          >
            +
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Photo upload stub. We accept an array of object-storage URLs/keys so the
 * sheet stays decoupled from the storage backend; the actual upload UX can
 * land separately by piping into apps/web/src/lib/api/daily-logs.ts-style
 * presigned uploads. The required indicator surfaces when damaged/lost > 0
 * so the operator knows to attach evidence before saving.
 */
function PhotoSlot({
  photos,
  onChange,
  required,
}: {
  photos: string[]
  onChange: (photos: string[]) => void
  required: boolean
}) {
  return (
    <div className="m-card m-card-tight">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[12px] font-semibold">
            Photos {required ? <span className="text-warn">*</span> : null}
          </div>
          <div className="text-[11px] text-ink-3 mt-0.5">
            {required ? 'Required for damaged or lost items' : 'Optional — attach evidence if useful'}
          </div>
        </div>
        <input
          type="text"
          placeholder="Paste photo URL"
          aria-label="Add photo URL"
          className="text-[12px] py-1 px-2 border-b border-line bg-transparent focus:outline-none focus:border-accent w-44"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const value = (e.target as HTMLInputElement).value.trim()
              if (value) {
                onChange([...photos, value])
                ;(e.target as HTMLInputElement).value = ''
              }
            }
          }}
        />
      </div>
      {photos.length > 0 ? (
        <ul className="mt-2 text-[11px] text-ink-3 space-y-1">
          {photos.map((p, i) => (
            <li key={`${p}-${i}`} className="flex items-center gap-2">
              <span className="truncate flex-1">{p}</span>
              <button
                type="button"
                onClick={() => onChange(photos.filter((_, j) => j !== i))}
                className="text-warn"
                aria-label="Remove photo"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Bottom sheet in the `.m-sheet` idiom (styles/m.css — square corners, 2px
 * ink top rule, hard offset shadow). Replaces the legacy
 * mobile-kit Sheet (rounded-t-[24px]) this sheet used pre-v2.
 * ESC and backdrop-tap dismiss. Same local-helper pattern as
 * screens/mobile/schedule.tsx and screens/financial/generate-payroll-export-sheet.tsx.
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
        <div className="m-sheet-body" style={{ padding: '16px 20px' }}>
          {children}
        </div>
      </div>
    </div>
  )
}
