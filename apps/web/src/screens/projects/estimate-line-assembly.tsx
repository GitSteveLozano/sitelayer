import { Card } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { useAssemblyByServiceItem, type AssemblyComponent } from '@/lib/api/assemblies'

/**
 * Assembly drill-down for an Estimate Builder line item.
 *
 * Reads from `apps/api/src/routes/assemblies.ts` via
 * `useAssemblyByServiceItem(code)` and renders the components that make up
 * one unit of the assembly:
 *   - kind (material / labor / sub / freight)
 *   - quantity_per_unit + unit + unit_cost
 *   - waste %
 *   - per-component contribution = quantity_per_unit × (1 + waste/100) × unit_cost
 *   - assembly total_rate (the cached header sum from the API)
 *
 * Pure read-only display in this slice. Editing components lives in the
 * settings/pricebook screen — out of scope for the Estimate Builder MVP.
 */
export interface EstimateLineAssemblyProps {
  serviceItemCode: string
  /** Used in the closeable subtitle so the user always knows which line they're inspecting. */
  lineLabel?: string
}

export function EstimateLineAssembly({ serviceItemCode, lineLabel }: EstimateLineAssemblyProps) {
  const assembly = useAssemblyByServiceItem(serviceItemCode)

  if (assembly.isPending) {
    return (
      <Card tight>
        <div className="text-[12px] text-ink-3">Loading assembly…</div>
      </Card>
    )
  }
  if (assembly.isError || !assembly.data) {
    return (
      <Card tight>
        <div className="text-[12px] font-semibold mb-1">No assembly defined</div>
        <div className="text-[11px] text-ink-3">
          {serviceItemCode} doesn't have a PlanSwift-style assembly yet — the rate falls back to the service item's
          default. Configure components in Settings → Pricebook to break this line down by material/labor/waste.
        </div>
      </Card>
    )
  }

  const { assembly: header, components } = assembly.data
  const total = Number(header.total_rate)
  const materials = components.filter((c) => c.kind === 'material')
  const labor = components.filter((c) => c.kind === 'labor')
  const other = components.filter((c) => c.kind === 'sub' || c.kind === 'freight')

  return (
    <Card tight>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold truncate">{header.name}</div>
          <div className="text-[10.5px] text-ink-3 mt-0.5">
            {serviceItemCode}
            {lineLabel ? ` · ${lineLabel}` : ''} · per {header.unit}
          </div>
        </div>
        <div className="num text-[13px] font-semibold shrink-0">${total.toFixed(2)}</div>
      </div>

      {components.length === 0 ? (
        <div className="text-[11px] text-ink-3">Assembly has no components yet.</div>
      ) : (
        <div className="space-y-2">
          {materials.length > 0 ? <ComponentGroup label="Materials" components={materials} /> : null}
          {labor.length > 0 ? <ComponentGroup label="Labor" components={labor} /> : null}
          {other.length > 0 ? <ComponentGroup label="Subs & freight" components={other} /> : null}
        </div>
      )}

      <div className="mt-3 pt-2 border-t border-dashed border-line">
        <Attribution source={`Live from /api/assemblies/${header.id.slice(0, 8)}…`} />
      </div>
    </Card>
  )
}

function ComponentGroup({ label, components }: { label: string; components: AssemblyComponent[] }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1">{label}</div>
      <ul className="divide-y divide-line">
        {components.map((c) => (
          <ComponentRow key={c.id} component={c} />
        ))}
      </ul>
    </div>
  )
}

function ComponentRow({ component }: { component: AssemblyComponent }) {
  const qty = Number(component.quantity_per_unit)
  const cost = Number(component.unit_cost)
  const waste = Number(component.waste_pct)
  const contribution = qty * (1 + waste / 100) * cost
  return (
    <li className="py-1.5 flex items-baseline gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium truncate">{component.name}</div>
        <div className="text-[10.5px] text-ink-3 num">
          {qty.toLocaleString()} {component.unit} × ${cost.toFixed(2)}
          {waste > 0 ? ` · +${waste.toFixed(0)}% waste` : ''}
        </div>
      </div>
      <div className="num text-[12px] font-semibold shrink-0">${contribution.toFixed(2)}</div>
    </li>
  )
}
