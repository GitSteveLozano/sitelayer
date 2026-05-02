import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Card, MobileButton } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { EmptyState } from '@/components/shell/EmptyState'
import { SkeletonRows } from '@/components/shell/LoadingSkeleton'
import { useProjectMeasurements, useServiceItems, type MeasurementGeometry, type TakeoffMeasurement } from '@/lib/api'
import { readElevation, type ElevationTag } from './takeoff-canvas'

/**
 * `prj-takeoff-summary` — Sitemap §5 panel 4 ("Summary · sizes").
 *
 * Aggregates all measurements on a project into per service-item
 * totals with quantity bars showing relative magnitude. Mono numerics
 * + tabular nums so columns line up; `tone="accent"` bar fills as the
 * proportion of the largest line.
 *
 * Each row links into the canvas with the item pre-selected so the
 * estimator can jump from "we have 1,420 sf of EPS" to seeing the
 * polygons that produced that number.
 */
export function TakeoffSummaryScreen() {
  const { id: projectId } = useParams<{ id: string }>()
  const measurements = useProjectMeasurements(projectId)
  const serviceItems = useServiceItems()
  const [groupBy, setGroupBy] = useState<'item' | 'elevation'>('item')

  const items = serviceItems.data?.serviceItems ?? []
  const itemByCode = useMemo(() => new Map(items.map((i) => [i.code, i])), [items])

  type Group = {
    code: string
    name: string
    unit: string
    totalQty: number
    measurementCount: number
    /** First photo-measure thumbnail in this group, if any. */
    thumbnail: string | null
  }

  const groups = useMemo<Group[]>(() => {
    const rows = measurements.data?.measurements ?? []
    const m = new Map<string, Group>()
    if (groupBy === 'item') {
      for (const r of rows) {
        const code = r.service_item_code
        const item = itemByCode.get(code)
        const qty = quantityFor(r)
        const existing = m.get(code) ?? {
          code,
          name: item?.name ?? code,
          unit: r.unit,
          totalQty: 0,
          measurementCount: 0,
          thumbnail: null,
        }
        existing.totalQty += qty
        existing.measurementCount += 1
        if (!existing.thumbnail && r.image_thumbnail) existing.thumbnail = r.image_thumbnail
        m.set(code, existing)
      }
    } else {
      // Group by elevation tag (first-class column since migration
      // 042). Measurements with neither an `elevation` value nor a
      // legacy notes-prefix land under "untagged" so they're surfaced.
      for (const r of rows) {
        const tag: ElevationTag = readElevation(r)
        const code = tag === 'none' ? 'untagged' : tag
        const qty = quantityFor(r)
        const existing = m.get(code) ?? {
          code,
          name: code === 'untagged' ? 'Untagged' : prettyElevation(code as ElevationTag),
          unit: r.unit,
          totalQty: 0,
          measurementCount: 0,
          thumbnail: null,
        }
        existing.totalQty += qty
        existing.measurementCount += 1
        if (!existing.thumbnail && r.image_thumbnail) existing.thumbnail = r.image_thumbnail
        // Mixed-unit rollups happen when a single elevation has both
        // sqft polygons and lf lineal — we surface the dominant unit
        // (first row's unit "wins") rather than switching to a vague
        // 'mixed' label that obscures the metric.
        m.set(code, existing)
      }
    }
    return Array.from(m.values()).sort((a, b) => b.totalQty - a.totalQty)
  }, [measurements.data, itemByCode, groupBy])

  const grandTotal = groups.reduce((sum, g) => sum + g.totalQty, 0)
  const maxQty = groups.reduce((max, g) => Math.max(max, g.totalQty), 0)

  if (!projectId) {
    return (
      <div className="px-5 pt-8">
        <Link to="/projects" className="text-accent text-[13px] font-medium">
          ← back
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <Link to={`/projects/${projectId}?tab=takeoff`} className="text-[12px] text-ink-3">
          ← Takeoff hub
        </Link>
        <h1 className="mt-2 font-display text-[22px] font-bold tracking-tight leading-tight">Takeoff summary</h1>
        <div className="text-[13px] text-ink-2 mt-1">
          {grandTotal > 0 ? (
            <>
              <span className="font-mono tabular-nums font-semibold">{grandTotal.toFixed(0)}</span> total quantity
              across {groups.length}{' '}
              {groupBy === 'item'
                ? groups.length === 1
                  ? 'item'
                  : 'items'
                : groups.length === 1
                  ? 'elevation'
                  : 'elevations'}
            </>
          ) : (
            'No measurements saved yet.'
          )}
        </div>
      </div>

      <div className="px-4 pb-2 flex gap-1.5">
        {(['item', 'elevation'] as const).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setGroupBy(g)}
            className={
              groupBy === g
                ? 'shrink-0 px-3.5 py-1.5 rounded-full text-[13px] font-medium bg-accent text-white'
                : 'shrink-0 px-3.5 py-1.5 rounded-full text-[13px] font-medium bg-card-soft text-ink-2 border border-line'
            }
          >
            {g === 'item' ? 'By item' : 'By elevation'}
          </button>
        ))}
      </div>

      <div className="px-4 pb-8 space-y-2">
        {measurements.isPending ? (
          <SkeletonRows count={4} className="px-0" />
        ) : groups.length === 0 ? (
          <EmptyState
            title="No measurements yet"
            body="Open the canvas to draw polygons or lineal runs — items roll up here automatically."
            primaryAction={
              <Link
                to={`/projects/${projectId}/takeoff-canvas`}
                className="w-full h-[50px] rounded-[14px] bg-accent text-white text-[16px] font-semibold inline-flex items-center justify-center"
              >
                Open canvas
              </Link>
            }
          />
        ) : (
          <>
            {groups.map((g) => (
              <SummaryRow key={g.code} group={g} maxQty={maxQty} projectId={projectId} />
            ))}
            <Attribution source="Live from /api/projects/:id/takeoff/measurements + /api/service-items" />
            <div className="pt-2">
              <Link to={`/projects/${projectId}/takeoff-canvas`} className="block">
                <MobileButton variant="primary">Add measurement</MobileButton>
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SummaryRow({
  group,
  maxQty,
  projectId,
}: {
  group: {
    code: string
    name: string
    unit: string
    totalQty: number
    measurementCount: number
    thumbnail: string | null
  }
  maxQty: number
  projectId: string
}) {
  const ratio = maxQty > 0 ? group.totalQty / maxQty : 0
  return (
    <Link to={`/projects/${projectId}/takeoff-canvas?item=${encodeURIComponent(group.code)}`} className="block">
      <Card>
        <div className="flex items-baseline justify-between gap-3 mb-1.5">
          <div className="min-w-0 flex items-baseline gap-2">
            {group.thumbnail ? (
              <img
                src={group.thumbnail}
                alt=""
                className="w-9 h-9 rounded-md object-cover shrink-0 border border-line"
                aria-hidden="true"
              />
            ) : null}
            <div className="min-w-0">
              <div className="text-[13px] font-semibold truncate">{group.code}</div>
              <div className="text-[11px] text-ink-3 mt-0.5 truncate">
                {group.name} · {group.measurementCount} {group.measurementCount === 1 ? 'measurement' : 'measurements'}
              </div>
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="font-mono tabular-nums text-[18px] font-semibold tracking-[-0.01em] leading-none">
              {group.totalQty.toFixed(2)}
            </div>
            <div className="text-[11px] text-ink-3 mt-0.5">{group.unit}</div>
          </div>
        </div>
        <div className="h-1.5 bg-card-soft rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-[width] duration-300"
            style={{ width: `${Math.max(2, ratio * 100)}%` }}
            aria-hidden="true"
          />
        </div>
      </Card>
    </Link>
  )
}

/**
 * Take a measurement's saved quantity if present, otherwise compute
 * from geometry. Polygon area is the shoelace sum on board-space
 * coords, lineal is sum of segment lengths, count is point count,
 * volume is L×W×H.
 */
function quantityFor(m: TakeoffMeasurement): number {
  const direct = Number(m.quantity)
  if (Number.isFinite(direct) && direct > 0) return direct
  const geo = m.geometry as MeasurementGeometry
  if (!geo || typeof geo !== 'object') return 0
  if (geo.kind === 'polygon' && geo.points && geo.points.length >= 3) {
    let sum = 0
    for (let i = 0; i < geo.points.length; i++) {
      const a = geo.points[i]
      const b = geo.points[(i + 1) % geo.points.length]
      if (!a || !b) continue
      sum += a.x * b.y - b.x * a.y
    }
    return Math.abs(sum) / 2
  }
  if (geo.kind === 'lineal' && geo.points && geo.points.length >= 2) {
    let total = 0
    for (let i = 1; i < geo.points.length; i++) {
      const a = geo.points[i - 1]
      const b = geo.points[i]
      if (!a || !b) continue
      total += Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2)
    }
    return total
  }
  if (geo.kind === 'count' && geo.points) {
    return geo.points.length
  }
  if (geo.kind === 'volume' && geo.length != null && geo.width != null && geo.height != null) {
    return geo.length * geo.width * geo.height
  }
  return 0
}

function prettyElevation(t: ElevationTag): string {
  if (t === 'east') return 'East elevation'
  if (t === 'south') return 'South elevation'
  if (t === 'west') return 'West elevation'
  if (t === 'north') return 'North elevation'
  if (t === 'roof') return 'Roof'
  if (t === 'other') return 'Other'
  return 'Untagged'
}
