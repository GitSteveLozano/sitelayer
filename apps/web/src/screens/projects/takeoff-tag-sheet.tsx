import { useMemo, useState } from 'react'
import { Card, MobileButton, Pill, Sheet } from '@/components/mobile'
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

export function TakeoffTagSheet({
  open,
  onClose,
  measurementId,
  defaultQuantity,
  defaultUnit,
}: TakeoffTagSheetProps) {
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

  return (
    <Sheet open={open} onClose={onClose} title="Multi-condition tags">
      <div className="space-y-3">
        {tags.isPending ? (
          <div className="text-[12px] text-ink-3">Loading conditions…</div>
        ) : tagRows.length === 0 ? (
          <Card>
            <div className="text-[13px] font-semibold">No conditions yet</div>
            <div className="text-[12px] text-ink-3 mt-1 leading-snug">
              One physical surface can carry several billable lines (EPS + basecoat + finish coat + air barrier). Add a
              condition to attach a service item with its own quantity and rate.
            </div>
          </Card>
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
          <Card>
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1">Add condition</div>
            <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 mt-2">
              Service item
            </label>
            <select
              value={draftCode}
              onChange={(e) => onSelectDraftItem(e.target.value)}
              className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
            >
              {availableItems.length === 0 ? <option value="">No catalog items left</option> : null}
              {availableItems.map((it) => (
                <option key={it.code} value={it.code}>
                  {it.code} — {it.name}
                </option>
              ))}
            </select>

            <div className="grid grid-cols-3 gap-2 mt-2">
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Qty</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={draftQty}
                  onChange={(e) => setDraftQty(e.target.value)}
                  className="mt-1 w-full text-[14px] py-1.5 bg-transparent border-b border-line focus:outline-none focus:border-accent font-mono tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Unit</label>
                <input
                  type="text"
                  value={draftUnit}
                  onChange={(e) => setDraftUnit(e.target.value)}
                  className="mt-1 w-full text-[14px] py-1.5 bg-transparent border-b border-line focus:outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Rate</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={draftRate}
                  onChange={(e) => setDraftRate(e.target.value)}
                  className="mt-1 w-full text-[14px] py-1.5 bg-transparent border-b border-line focus:outline-none focus:border-accent font-mono tabular-nums"
                />
              </div>
            </div>

            {error ? <div className="text-[12px] text-bad mt-2">{error}</div> : null}

            <div className="grid grid-cols-2 gap-2 mt-3">
              <MobileButton variant="ghost" onClick={cancelAdd}>
                Cancel
              </MobileButton>
              <MobileButton variant="primary" onClick={onSubmitAdd} disabled={add.isPending}>
                {add.isPending ? 'Adding…' : 'Add condition'}
              </MobileButton>
            </div>
          </Card>
        ) : (
          <div>
            <MobileButton
              variant="primary"
              onClick={beginAdd}
              disabled={availableItems.length === 0 || !measurementId}
            >
              + Add condition
            </MobileButton>
            {availableItems.length === 0 && tagRows.length > 0 ? (
              <div className="text-[11px] text-ink-3 mt-2">All catalog items already attached.</div>
            ) : null}
          </div>
        )}

        {error && !adding ? <div className="text-[12px] text-bad">{error}</div> : null}

        <div className="flex items-center justify-between pt-1">
          <Pill tone="default">{tagRows.length} condition{tagRows.length === 1 ? '' : 's'}</Pill>
          <button type="button" onClick={onClose} className="text-[13px] font-semibold text-accent">
            Done
          </button>
        </div>

        <Attribution source="GET / POST / PATCH / DELETE /api/takeoff/measurements/:id/tags · /api/takeoff/tags/:id" />
      </div>
    </Sheet>
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
    <Card tight>
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold truncate">{tag.service_item_code}</div>
          {item ? <div className="text-[11px] text-ink-3 truncate">{item.name}</div> : null}
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label="Remove condition"
          className="text-[12px] text-ink-3 hover:text-bad px-1.5 py-0.5"
        >
          ×
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-2">
        <label className="block">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Qty</span>
          <input
            type="number"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onBlur={commit}
            className="mt-0.5 w-full text-[13px] py-1 bg-transparent border-b border-line focus:outline-none focus:border-accent font-mono tabular-nums"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Unit</span>
          <input
            type="text"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            onBlur={commit}
            className="mt-0.5 w-full text-[13px] py-1 bg-transparent border-b border-line focus:outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Rate</span>
          <input
            type="number"
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            onBlur={commit}
            className="mt-0.5 w-full text-[13px] py-1 bg-transparent border-b border-line focus:outline-none focus:border-accent font-mono tabular-nums"
          />
        </label>
      </div>
    </Card>
  )
}
