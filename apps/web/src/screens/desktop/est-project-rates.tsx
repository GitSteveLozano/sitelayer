/**
 * Project rates editor (Cavy, WhatsApp 4/11: "can the pricing rate section be
 * project specific?"). Lets the estimator set a per-project rate override for
 * any service item. Saving writes project_pricing_overrides (the write side of
 * the pricing chain) and recomputes the estimate so the new rates land on the
 * lines — the resolver reads project → customer → company → qbo → default.
 */
import { useEffect, useMemo, useState } from 'react'
import { useServiceItems, type ServiceItem } from '@/lib/api'
import {
  recomputeEstimate,
  useDeletePricingOverride,
  usePricingOverrides,
  useUpsertPricingOverride,
} from '@/lib/api/pricing-overrides'
import { DModal } from '@/components/d'
import { MButton } from '@/components/m'

interface ProjectRatesModalProps {
  projectId: string
  open: boolean
  onClose: () => void
  /** Called after a successful save + recompute so the caller can refresh the estimate. */
  onSaved?: () => void
}

export function ProjectRatesModal({ projectId, open, onClose, onSaved }: ProjectRatesModalProps) {
  const scope = useMemo(() => ({ kind: 'project' as const, id: projectId }), [projectId])
  const serviceItems = useServiceItems()
  const items = useMemo<ServiceItem[]>(() => serviceItems.data?.serviceItems ?? [], [serviceItems.data])
  const overridesQuery = usePricingOverrides(scope, open)
  const upsert = useUpsertPricingOverride(scope)
  const remove = useDeletePricingOverride(scope)

  // Original override rate per code (string) and the editable draft values.
  const originalByCode = useMemo(() => {
    const map = new Map<string, string>()
    for (const o of overridesQuery.data?.overrides ?? []) map.set(o.service_item_code, String(Number(o.rate)))
    return map
  }, [overridesQuery.data])

  const [edits, setEdits] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Seed the editable values from the loaded overrides when the modal opens.
  useEffect(() => {
    if (!open) return
    const seed: Record<string, string> = {}
    for (const [code, rate] of originalByCode) seed[code] = rate
    setEdits(seed)
    setError(null)
  }, [open, originalByCode])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      for (const item of items) {
        const code = item.code
        const next = (edits[code] ?? '').trim()
        const original = originalByCode.get(code) ?? ''
        if (next === original) continue
        if (next === '') {
          if (original !== '') await remove.mutateAsync({ service_item_code: code })
          continue
        }
        const rate = Number(next)
        if (!Number.isFinite(rate) || rate < 0) {
          setError(`"${code}" rate must be a non-negative number.`)
          setSaving(false)
          return
        }
        await upsert.mutateAsync({ service_item_code: code, rate })
      }
      // Recompute so the override rates flow onto the estimate lines.
      await recomputeEstimate(projectId)
      onSaved?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <DModal
      open={open}
      onClose={onClose}
      title="Project rates"
      width={620}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%' }}>
          <span style={{ fontSize: 12, color: error ? 'var(--m-red)' : 'var(--m-ink-3)' }}>
            {error ?? 'Blank = use the default rate. Saving recomputes the estimate.'}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <MButton variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </MButton>
            <MButton variant="primary" onClick={() => void handleSave()} disabled={saving || overridesQuery.isLoading}>
              {saving ? 'Saving…' : 'Save rates'}
            </MButton>
          </span>
        </div>
      }
    >
      <div style={{ display: 'grid', gap: 2, maxHeight: '60vh', overflow: 'auto' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 64px 110px 120px',
            gap: 10,
            padding: '6px 4px',
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-3)',
            position: 'sticky',
            top: 0,
            background: 'var(--m-paper)',
          }}
        >
          <span>Service item</span>
          <span>Unit</span>
          <span style={{ textAlign: 'right' }}>Default</span>
          <span style={{ textAlign: 'right' }}>Project rate</span>
        </div>
        {items.length === 0 ? (
          <div style={{ padding: 12, color: 'var(--m-ink-3)', fontSize: 13 }}>Loading items…</div>
        ) : null}
        {items.map((item) => {
          const def = item.default_rate == null ? null : Number(item.default_rate)
          return (
            <label
              key={item.code}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) 64px 110px 120px',
                gap: 10,
                alignItems: 'center',
                padding: '6px 4px',
                borderTop: '1px solid var(--m-ink-5, rgba(0,0,0,0.06))',
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0 }}>
                {item.code}
                <span style={{ color: 'var(--m-ink-3)', fontWeight: 400 }}> — {item.name}</span>
              </span>
              <span style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>{item.unit || '—'}</span>
              <span className="num" style={{ textAlign: 'right', fontSize: 13, color: 'var(--m-ink-3)' }}>
                {def == null ? '—' : `$${def.toFixed(2)}`}
              </span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={edits[item.code] ?? ''}
                placeholder={def == null ? 'default' : def.toFixed(2)}
                onChange={(e) => setEdits((prev) => ({ ...prev, [item.code]: e.target.value }))}
                style={{
                  width: '100%',
                  textAlign: 'right',
                  fontFamily: 'var(--m-num)',
                  fontSize: 14,
                  padding: '6px 8px',
                  border: '1px solid var(--m-ink-4, rgba(0,0,0,0.2))',
                  borderRadius: 6,
                  background: 'var(--m-paper)',
                }}
              />
            </label>
          )
        })}
      </div>
    </DModal>
  )
}
