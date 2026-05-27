import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Card, MobileButton, Banner } from '@/components/mobile'
import { useProjectBoms, useBom, useApproveBom, type Bom, type BomLine } from '@/lib/api/scaffold-ops'

const MM_PER_FOOT = 304.8

/**
 * Project bill-of-materials list + detail. Surfaces the BOMs saved by the
 * scaffold designer (source='scaffold_design') and any manual ones, with their
 * lines and the approve action. Without this, saved BOMs were invisible.
 */
export function ProjectBomsScreen() {
  const { id: projectId } = useParams<{ id: string }>()
  const boms = useProjectBoms(projectId ?? '')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (!projectId) {
    return (
      <div className="px-5 pt-8">
        <Link to="/projects" className="text-[12px] text-ink-3">
          ← Projects
        </Link>
      </div>
    )
  }

  const rows = boms.data?.boms ?? []

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to={`/projects/${projectId}`} className="text-[12px] text-ink-3">
        ← Project
      </Link>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <h1 className="font-display text-[26px] font-bold tracking-tight leading-tight">Bills of materials</h1>
        <Link to="/scaffold-designer" className="shrink-0 text-[12px] font-medium text-accent">
          Scaffold designer →
        </Link>
      </div>
      <p className="text-[12px] text-ink-3 mt-1">{rows.length} BOM(s) for this project.</p>

      <div className="mt-5 space-y-3">
        {boms.isPending ? <Card>Loading…</Card> : null}
        {!boms.isPending && rows.length === 0 ? (
          <Card>
            <div className="text-[13px] font-semibold">No BOMs yet</div>
            <div className="text-[12px] text-ink-3 mt-0.5">
              Generate one in the{' '}
              <Link to="/scaffold-designer" className="text-accent">
                scaffold designer
              </Link>{' '}
              and save it to this project.
            </div>
          </Card>
        ) : null}
        {rows.map((bom) => (
          <button key={bom.id} type="button" onClick={() => setSelectedId(bom.id)} className="block w-full text-left">
            <Card>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold truncate">{bom.name}</div>
                  <div className="text-[12px] text-ink-3 mt-0.5">
                    {bom.source} · {bom.total_lines} line(s) · {Number(bom.total_weight_kg).toFixed(0)} kg
                  </div>
                </div>
                <StatusBadge status={bom.status} />
              </div>
            </Card>
          </button>
        ))}
      </div>

      {selectedId ? <BomDetailCard bomId={selectedId} onClose={() => setSelectedId(null)} /> : null}
    </div>
  )
}

function StatusBadge({ status }: { status: Bom['status'] }) {
  const cls =
    status === 'approved'
      ? 'bg-good-soft text-good'
      : status === 'superseded'
        ? 'bg-line text-ink-3'
        : 'bg-warn-soft text-warn'
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{status}</span>
}

function BomDetailCard({ bomId, onClose }: { bomId: string; onClose: () => void }) {
  const detail = useBom(bomId)
  const approve = useApproveBom(bomId)
  const bom = detail.data

  return (
    <div className="mt-5">
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] uppercase tracking-[0.06em] text-ink-3">BOM detail</div>
          <button type="button" onClick={onClose} className="text-[12px] text-ink-3">
            Close
          </button>
        </div>
        {detail.isPending ? <div className="mt-2 text-[13px] text-ink-3">Loading…</div> : null}
        {bom ? (
          <>
            <div className="mt-1 flex items-baseline justify-between gap-3">
              <div className="text-[15px] font-semibold">{bom.name}</div>
              <StatusBadge status={bom.status} />
            </div>
            {designerLinkForBom(bom) ? (
              <Link to={designerLinkForBom(bom)!} className="mt-1 inline-block text-[12px] font-medium text-accent">
                Open in designer →
              </Link>
            ) : null}
            <ul className="mt-3 divide-y divide-line">
              {bom.lines.map((line) => (
                <li key={line.id} className="flex items-center gap-2.5 py-2 text-[13px]">
                  <span className="flex-1 capitalize">{lineLabel(line)}</span>
                  <span className="num font-semibold tabular-nums">×{Number(line.quantity).toFixed(0)}</span>
                </li>
              ))}
              {bom.lines.length === 0 ? <li className="py-2 text-[12px] text-ink-3">No lines.</li> : null}
            </ul>
            {bom.status === 'draft' ? (
              <div className="mt-3">
                <MobileButton variant="primary" disabled={approve.isPending} onClick={() => approve.mutate()}>
                  {approve.isPending ? 'Approving…' : 'Approve BOM'}
                </MobileButton>
                {approve.isError ? <Banner tone="error" title={approve.error.message} className="mt-2" /> : null}
              </div>
            ) : null}
          </>
        ) : null}
      </Card>
    </div>
  )
}

/** For a scaffold_design BOM, rebuild the designer URL from the spec stored in
 *  source_ref ({ spec, scaffold_system_id }). Null for other BOM sources. */
function designerLinkForBom(bom: { source: string; source_ref: string | null }): string | null {
  if (bom.source !== 'scaffold_design' || !bom.source_ref) return null
  try {
    const parsed = JSON.parse(bom.source_ref) as { spec?: unknown }
    if (parsed.spec && typeof parsed.spec === 'object') {
      return `/scaffold-designer?spec=${encodeURIComponent(JSON.stringify(parsed.spec))}`
    }
  } catch {
    // source_ref wasn't the design envelope; no link
  }
  return null
}

function lineLabel(line: BomLine): string {
  const role = typeof line.attrs?.role === 'string' ? line.attrs.role.replace('_', ' ') : null
  const lengthMm = typeof line.attrs?.demand_length_mm === 'number' ? line.attrs.demand_length_mm : null
  if (role && lengthMm) return `${role} · ${(lengthMm / MM_PER_FOOT).toFixed(1)} ft`
  if (role) return role
  return line.notes ?? line.catalog_part_id.slice(0, 8)
}
