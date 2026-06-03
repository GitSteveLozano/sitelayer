import { useEffect, useMemo, useState } from 'react'
import { type TakeoffMeasurement } from '@/lib/api'
import { useAssemblies, useAttachAssemblyToMeasurement, useExplodeAssembly, type Assembly } from '@/lib/api/assemblies'
import { formatQty } from '@/lib/takeoff/canvas-totals'
import { MPill, MSelect } from '@/components/m'
import { formatMoney } from '../../mobile/format.js'

/**
 * PlanSwift Phase 2 — attach an assembly recipe to a committed measurement
 * (the "drop assembly onto a takeoff" moment). Selecting an assembly PATCHes
 * the measurement's `assembly_id`, which makes the next estimate recompute
 * explode it into N priced material/labor/sub/freight lines. We also run the
 * preview-only `/explode` endpoint at the measurement's real quantity so the
 * estimator sees the resulting per-kind cost breakdown inline before leaving
 * the canvas. Unit mismatch between the assembly and the measurement is a soft
 * warning, never a block (pilot estimators know their units).
 */
export function AssemblyAttachPanel({ measurement }: { measurement: TakeoffMeasurement }) {
  const assembliesQuery = useAssemblies()
  const attach = useAttachAssemblyToMeasurement()
  const explode = useExplodeAssembly()
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ assemblyId: string; total: number; byKind: Record<string, number> } | null>(
    null,
  )

  const attachedId = measurement.assembly_id ?? ''
  const assemblies = useMemo<Assembly[]>(() => assembliesQuery.data?.assemblies ?? [], [assembliesQuery.data])
  // Surface assemblies whose scope matches this measurement's item first.
  const sorted = useMemo(() => {
    const code = measurement.service_item_code
    return [...assemblies].sort((a, b) => {
      const am = a.service_item_code === code ? 0 : 1
      const bm = b.service_item_code === code ? 0 : 1
      return am - bm || a.name.localeCompare(b.name)
    })
  }, [assemblies, measurement.service_item_code])

  const attachedAssembly = assemblies.find((a) => a.id === attachedId) ?? null
  const measurementQty = Number(measurement.quantity) || 0
  const unitMismatch = attachedAssembly != null && attachedAssembly.unit !== measurement.unit

  // Run the explode preview whenever the attached assembly (or qty) changes.
  useEffect(() => {
    if (!attachedId) {
      setPreview(null)
      return
    }
    let cancelled = false
    explode
      .mutateAsync({
        id: attachedId,
        measurement_quantity: measurementQty,
        measurement_unit: measurement.unit,
        is_deduction: measurement.is_deduction === true,
      })
      .then((res) => {
        if (cancelled) return
        setPreview({ assemblyId: attachedId, total: res.markup.total, byKind: res.resolution.by_kind })
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setPreview(null)
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
    // Re-run only when the attached assembly or the measurement's
    // quantity/unit/deduction changes. `explode` is intentionally NOT a dep:
    // the react-query mutation object gets a new reference each render
    // (isPending toggles), so depending on it would loop. (The
    // react-hooks/exhaustive-deps rule is not enabled in this project.)
  }, [attachedId, measurementQty, measurement.unit, measurement.is_deduction])

  const onSelect = (value: string) => {
    setError(null)
    attach.mutate(
      { measurementId: measurement.id, assemblyId: value || null, expectedVersion: measurement.version },
      { onError: (err) => setError(err instanceof Error ? err.message : String(err)) },
    )
  }

  const KIND_LABEL: Record<string, string> = { material: 'Mat', labor: 'Labor', sub: 'Sub', freight: 'Freight' }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color: 'var(--m-ink-3)',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
          }}
        >
          Assembly
        </span>
        <MSelect
          value={attachedId}
          onChange={(e) => onSelect(e.target.value)}
          disabled={attach.isPending || assembliesQuery.isLoading}
          aria-label="Apply assembly to measurement"
          style={{ flex: 1, minWidth: 0 }}
        >
          <option value="">{assembliesQuery.isLoading ? 'Loading…' : 'None (flat line)'}</option>
          {sorted.map((a) => (
            <option key={a.id} value={a.id}>
              {a.service_item_code === measurement.service_item_code ? '★ ' : ''}
              {a.name} ({a.unit})
            </option>
          ))}
        </MSelect>
      </div>

      {unitMismatch ? (
        <MPill tone="amber">
          Unit differs: assembly {attachedAssembly?.unit} vs measurement {measurement.unit}
        </MPill>
      ) : null}

      {error ? <span style={{ fontSize: 12, color: 'var(--m-red)' }}>{error}</span> : null}

      {attachedId && preview && preview.assemblyId === attachedId ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>
              Explodes at {formatQty(measurementQty)} {measurement.unit}
              {measurement.is_deduction ? ' (deduction)' : ''}
            </span>
            <span className="num" style={{ fontWeight: 800, fontSize: 16, fontVariantNumeric: 'tabular-nums' }}>
              {formatMoney(preview.total)}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['material', 'labor', 'sub', 'freight'] as const).map((k) => {
              const v = preview.byKind[k] ?? 0
              if (!v) return null
              return (
                <MPill key={k} tone={k === 'material' ? 'accent' : k === 'labor' ? 'green' : 'amber'}>
                  {KIND_LABEL[k]} {formatMoney(Math.abs(v))}
                </MPill>
              )
            })}
          </div>
        </div>
      ) : attachedId && explode.isPending ? (
        <span style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>Computing explosion…</span>
      ) : null}
    </div>
  )
}
