import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { MButton, MI, MInput, MPill, MSelect } from '@/components/m'
import { Attribution } from '@/components/ai'
import {
  useAddTakeoffTag,
  useRemoveTakeoffTag,
  useServiceItems,
  useTakeoffTags,
  useUpdateTakeoffTag,
  type ServiceItem,
  type TakeoffTag,
} from '@/lib/api'

/**
 * `prj-takeoff-tag-sheet` — multi-condition tag editor.
 *
 * Bottom sheet opened from the canvas (right-click / long-press a saved
 * polygon) or the detail screen. Lists existing tags with inline qty/rate
 * edits, plus an "Add condition" form that posts to the existing
 * `useAddTakeoffTag` mutation. Closes via backdrop tap, Escape, or the
 * Done button.
 *
 * Design source: `/tmp/sitelayer_design_stuff/view-takeoff.jsx` —
 * `MeasurementRow` shows pill-shaped tags with a "+ tag" inline picker.
 * Mobile-first sheet adapts that pattern to the sitelayer mobile shell.
 */
export interface TakeoffTagSheetProps {
  open: boolean
  onClose: () => void
  measurementId: string | null
  /** Optional default qty when adding the first condition (e.g. polygon area). */
  defaultQuantity?: number | undefined
  /** Optional default unit when adding the first condition. */
  defaultUnit?: string | undefined
}

export function TakeoffTagSheet({ open, onClose, measurementId, defaultQuantity, defaultUnit }: TakeoffTagSheetProps) {
  const tags = useTakeoffTags(measurementId)
  const items = useServiceItems()
  const add = useAddTakeoffTag(measurementId ?? '')
  const update = useUpdateTakeoffTag(measurementId ?? '')
  const remove = useRemoveTakeoffTag(measurementId ?? '')

  const tagRows = tags.data?.tags ?? []
  const usedCodes = useMemo(() => new Set(tagRows.map((t) => t.service_item_code)), [tagRows])
  const availableItems = useMemo(
    () => (items.data?.serviceItems ?? []).filter((s) => !usedCodes.has(s.code)),
    [items.data, usedCodes],
  )

  const [adding, setAdding] = useState(false)
  const [draftCode, setDraftCode] = useState('')
  const [draftQty, setDraftQty] = useState<string>('')
  const [draftUnit, setDraftUnit] = useState<string>('')
  const [draftRate, setDraftRate] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  // Pre-fill defaults whenever the sheet opens or the available item set
  // changes — only matters before the user starts typing.
  const initDraft = (item: ServiceItem | undefined) => {
    setDraftCode(item?.code ?? '')
    setDraftQty(defaultQuantity != null ? String(defaultQuantity) : '')
    setDraftUnit(item?.unit ?? defaultUnit ?? '')
    const rate = item?.default_rate ?? null
    setDraftRate(rate != null ? String(rate) : '')
  }

  const beginAdd = () => {
    setError(null)
    setAdding(true)
    initDraft(availableItems[0])
  }

  const cancelAdd = () => {
    setAdding(false)
    setError(null)
  }

  const onSelectDraftItem = (code: string) => {
    setDraftCode(code)
    const item = items.data?.serviceItems.find((s) => s.code === code)
    if (item) {
      // Re-derive unit + rate from the catalog when the user switches
      // service items. Quantity stays so the user can carry over the
      // polygon area to the new line.
      setDraftUnit(item.unit ?? draftUnit)
      const rate = item.default_rate
      if (rate != null) setDraftRate(String(rate))
    }
  }

  const onSubmitAdd = async () => {
    if (!measurementId) return
    setError(null)
    const code = draftCode.trim()
    if (!code) {
      setError('Pick a service item first.')
      return
    }
    const qty = Number(draftQty)
    if (!Number.isFinite(qty) || qty < 0) {
      setError('Quantity must be a non-negative number.')
      return
    }
    const rate = draftRate === '' ? 0 : Number(draftRate)
    if (!Number.isFinite(rate) || rate < 0) {
      setError('Rate must be a non-negative number.')
      return
    }
    try {
      await add.mutateAsync({
        service_item_code: code,
        quantity: qty,
        unit: draftUnit.trim() || 'sqft',
        rate,
      })
      setAdding(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add condition')
    }
  }

  const onRemoveTag = async (tag: TakeoffTag) => {
    setError(null)
    try {
      await remove.mutateAsync(tag.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove condition')
    }
  }

  if (!open) return null

  return (
    <MSheet title="Multi-condition tags" onClose={onClose}>
      <div className="space-y-3">
        {tags.isPending ? (
          <div className="m-quiet-sm">Loading conditions…</div>
        ) : tagRows.length === 0 ? (
          <div className="m-card">
            <div className="text-[13px] font-semibold">No conditions yet</div>
            <div className="m-quiet-sm mt-1 leading-snug">
              One physical surface can carry several billable lines (EPS + basecoat + finish coat + air barrier). Add a
              condition to attach a service item with its own quantity and rate.
            </div>
          </div>
        ) : (
          <ul className="space-y-2">
            {tagRows.map((t) => (
              <li key={t.id}>
                <TagEditorRow
                  tag={t}
                  serviceItems={items.data?.serviceItems ?? []}
                  onCommit={(input) =>
                    update
                      .mutateAsync({ tagId: t.id, ...input })
                      .then(() => undefined)
                      .catch((err: unknown) => {
                        setError(err instanceof Error ? err.message : 'Failed to update condition')
                      })
                  }
                  onRemove={() => onRemoveTag(t)}
                  busy={update.isPending || remove.isPending}
                />
              </li>
            ))}
          </ul>
        )}

        {adding ? (
          <div className="m-card">
            <div className="m-field-l mb-1">Add condition</div>
            <label className="m-field-l mt-2" htmlFor="takeoff-tag-item">
              Service item
            </label>
            <MSelect id="takeoff-tag-item" value={draftCode} onChange={(e) => onSelectDraftItem(e.target.value)}>
              {availableItems.length === 0 ? <option value="">No catalog items left</option> : null}
              {availableItems.map((it) => (
                <option key={it.code} value={it.code}>
                  {it.code} — {it.name}
                </option>
              ))}
            </MSelect>

            <div className="grid grid-cols-3 gap-2 mt-3">
              <label className="block">
                <span className="m-field-l">Qty</span>
                <MInput
                  type="number"
                  inputMode="decimal"
                  value={draftQty}
                  onChange={(e) => setDraftQty(e.target.value)}
                  className="font-mono tabular-nums"
                />
              </label>
              <label className="block">
                <span className="m-field-l">Unit</span>
                <MInput type="text" value={draftUnit} onChange={(e) => setDraftUnit(e.target.value)} />
              </label>
              <label className="block">
                <span className="m-field-l">Rate</span>
                <MInput
                  type="number"
                  inputMode="decimal"
                  value={draftRate}
                  onChange={(e) => setDraftRate(e.target.value)}
                  className="font-mono tabular-nums"
                />
              </label>
            </div>

            {error ? <div style={{ color: 'var(--m-red)', fontSize: 12, marginTop: 8 }}>{error}</div> : null}

            <div className="grid grid-cols-2 gap-2 mt-3">
              <MButton variant="ghost" onClick={cancelAdd}>
                Cancel
              </MButton>
              <MButton variant="primary" onClick={onSubmitAdd} disabled={add.isPending}>
                {add.isPending ? 'Adding…' : 'Add condition'}
              </MButton>
            </div>
          </div>
        ) : (
          <div>
            <MButton
              variant="primary"
              style={{ width: '100%' }}
              onClick={beginAdd}
              disabled={availableItems.length === 0 || !measurementId}
            >
              + Add condition
            </MButton>
            {availableItems.length === 0 && tagRows.length > 0 ? (
              <div className="m-quiet-sm mt-2">All catalog items already attached.</div>
            ) : null}
          </div>
        )}

        {error && !adding ? <div style={{ color: 'var(--m-red)', fontSize: 12 }}>{error}</div> : null}

        <div className="flex items-center justify-between pt-1">
          <MPill>
            {tagRows.length} condition{tagRows.length === 1 ? '' : 's'}
          </MPill>
          <button type="button" onClick={onClose} className="text-[13px] font-semibold text-accent">
            Done
          </button>
        </div>

        <Attribution source="GET / POST / PATCH / DELETE /api/takeoff/measurements/:id/tags · /api/takeoff/tags/:id" />
      </div>
    </MSheet>
  )
}

/**
 * Bottom sheet in the `.m-sheet` idiom (styles/m.css — square corners, 2px
 * ink top rule, hard offset shadow, no grabber/blur). Same pattern as the
 * AssignmentSheet swap in screens/mobile/schedule.tsx (e9b7c7f3); replaces
 * the retired wave-2 kit Sheet. ESC and backdrop-tap dismiss.
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
        <div className="m-sheet-body" style={{ padding: '16px 20px 0' }}>
          {children}
        </div>
      </div>
    </div>
  )
}

interface TagEditorRowProps {
  tag: TakeoffTag
  serviceItems: ServiceItem[]
  onCommit: (input: { quantity?: number; rate?: number; unit?: string }) => Promise<unknown>
  onRemove: () => void
  busy: boolean
}

function TagEditorRow({ tag, serviceItems, onCommit, onRemove, busy }: TagEditorRowProps) {
  const [qty, setQty] = useState<string>(tag.quantity)
  const [rate, setRate] = useState<string>(tag.rate)
  const [unit, setUnit] = useState<string>(tag.unit)
  const item = serviceItems.find((s) => s.code === tag.service_item_code)

  const dirty = qty !== tag.quantity || rate !== tag.rate || unit !== tag.unit

  const commit = () => {
    if (!dirty || busy) return
    const q = Number(qty)
    const r = Number(rate)
    const patch: { quantity?: number; rate?: number; unit?: string } = {}
    if (qty !== tag.quantity && Number.isFinite(q) && q >= 0) patch.quantity = q
    if (rate !== tag.rate && Number.isFinite(r) && r >= 0) patch.rate = r
    if (unit !== tag.unit && unit.trim()) patch.unit = unit.trim()
    if (Object.keys(patch).length === 0) return
    void onCommit(patch)
  }

  return (
    <div className="m-card m-card-tight">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold truncate">{tag.service_item_code}</div>
          {item ? <div className="m-quiet text-[11px] truncate">{item.name}</div> : null}
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label="Remove condition"
          className="m-quiet text-[12px] px-1.5 py-0.5"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          ×
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-2">
        <label className="block">
          <span className="m-field-l">Qty</span>
          <MInput
            type="number"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onBlur={commit}
            className="font-mono tabular-nums"
          />
        </label>
        <label className="block">
          <span className="m-field-l">Unit</span>
          <MInput type="text" value={unit} onChange={(e) => setUnit(e.target.value)} onBlur={commit} />
        </label>
        <label className="block">
          <span className="m-field-l">Rate</span>
          <MInput
            type="number"
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            onBlur={commit}
            className="font-mono tabular-nums"
          />
        </label>
      </div>
    </div>
  )
}
