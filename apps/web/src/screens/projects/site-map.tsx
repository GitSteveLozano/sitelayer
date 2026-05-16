import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { useClockTimeline, useProject } from '@/lib/api'
import { useScaffoldTags, type ScaffoldTag } from '@/lib/api/scaffold-tags'

/**
 * Project site map.
 *
 * Renders an SVG projection of the project geofence with scaffold-tag
 * positions coloured by inspection status, plus recent clock-in points
 * (rough live-presence proxy). No external map dep — a tile basemap can
 * layer behind this <svg> later if a customer asks. The unprojected
 * tag list still renders below so you can act on tags that have no
 * lat/lng yet.
 */
export function ProjectSiteMapScreen() {
  const { projectId } = useParams<{ projectId: string }>()
  const project = useProject(projectId ?? null)
  const tags = useScaffoldTags(projectId ?? '')
  // Today's clock events; filter to this project on the client (the
  // timeline endpoint is worker/date scoped, not project scoped).
  const today = new Date().toISOString().slice(0, 10)
  const timeline = useClockTimeline({ date: today })

  const rows = tags.data?.tags ?? []
  const counts = useMemo(() => {
    const byStatus = { active: 0, tagged_out: 0, dismantled: 0 }
    const byInspection = { pass: 0, fail: 0, tagged_out: 0, none: 0 }
    for (const t of rows) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
      if (t.last_inspection_status) {
        byInspection[t.last_inspection_status] += 1
      } else {
        byInspection.none += 1
      }
    }
    return { byStatus, byInspection }
  }, [rows])

  const p = project.data?.project
  const centerLat = p?.site_lat ? Number(p.site_lat) : null
  const centerLng = p?.site_lng ? Number(p.site_lng) : null
  const radiusM = p?.site_radius_m ?? 150

  // Recent clock events with coordinates — keep the latest event per worker
  // and filter to this project.
  const livePoints = useMemo(() => {
    const byWorker = new Map<string, { worker_id: string; lat: number; lng: number; occurred_at: string; inside: boolean | null }>()
    for (const ev of timeline.data?.events ?? []) {
      if (ev.event_type !== 'in') continue
      if (ev.voided_at) continue
      if (!ev.lat || !ev.lng) continue
      if (projectId && ev.project_id && ev.project_id !== projectId) continue
      const id = ev.worker_id ?? ev.clerk_user_id ?? ev.id
      const cur = byWorker.get(id)
      if (!cur || ev.occurred_at > cur.occurred_at) {
        byWorker.set(id, {
          worker_id: id,
          lat: Number(ev.lat),
          lng: Number(ev.lng),
          occurred_at: ev.occurred_at,
          inside: ev.inside_geofence,
        })
      }
    }
    return [...byWorker.values()]
  }, [timeline.data, projectId])

  const tagsWithCoords = rows.filter((t) => t.lat != null && t.lng != null)
  const hasMappable = centerLat != null && centerLng != null
  // Visualization extent: max of geofence radius and farthest tag/crew point.
  const extentM = useMemo(() => {
    if (!hasMappable) return radiusM
    let max = radiusM
    const project = (latStr: string | number | null, lngStr: string | number | null) => {
      if (latStr == null || lngStr == null) return
      const lat = Number(latStr)
      const lng = Number(lngStr)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
      const dx = metersBetween(centerLat!, centerLng!, centerLat!, lng)
      const dy = metersBetween(centerLat!, centerLng!, lat, centerLng!)
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > max) max = d
    }
    for (const t of tagsWithCoords) project(t.lat, t.lng)
    for (const c of livePoints) project(c.lat, c.lng)
    return Math.max(max * 1.2, radiusM)
  }, [centerLat, centerLng, radiusM, tagsWithCoords, livePoints, hasMappable])

  return (
    <div className="px-5 pt-6 pb-12 max-w-3xl">
      <Link to={`/projects/${projectId ?? ''}`} className="text-[12px] text-ink-3">
        ← Project
      </Link>
      <h1 className="mt-2 font-display text-[24px] font-bold tracking-tight leading-tight">Site map</h1>
      <p className="text-[12px] text-ink-3 mt-1">
        Geofence, scaffold-tag inspection status, and recent crew clock-ins. SVG projection — drop a tile
        basemap behind it when a customer asks.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card tight>
          <div className="text-[11px] text-ink-3">Active</div>
          <div className="font-display text-[22px] font-semibold">{counts.byStatus.active}</div>
        </Card>
        <Card tight>
          <div className="text-[11px] text-ink-3">Tagged out</div>
          <div className="font-display text-[22px] font-semibold">{counts.byStatus.tagged_out}</div>
        </Card>
        <Card tight>
          <div className="text-[11px] text-ink-3">Last pass</div>
          <div className="font-display text-[22px] font-semibold">{counts.byInspection.pass}</div>
        </Card>
        <Card tight>
          <div className="text-[11px] text-ink-3">Last fail</div>
          <div className="font-display text-[22px] font-semibold">{counts.byInspection.fail}</div>
        </Card>
      </div>

      {hasMappable ? (
        <Card>
          <SiteMapSvg
            centerLat={centerLat!}
            centerLng={centerLng!}
            radiusM={radiusM}
            extentM={extentM}
            tags={tagsWithCoords}
            crew={livePoints}
          />
          <Legend />
        </Card>
      ) : (
        <Card tight>
          <div className="text-[12px] text-ink-3">
            This project has no geofence configured. Set <span className="font-mono">site_lat</span> and{' '}
            <span className="font-mono">site_lng</span> in project settings to plot tags on a site map.
          </div>
        </Card>
      )}

      <h2 className="mt-6 text-[14px] font-semibold">Tags</h2>
      <div className="mt-2 space-y-1">
        {tags.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : rows.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">
              No scaffolds tagged on this project yet. Print a QR sticker and add one from the foreman
              inspection screen.
            </div>
          </Card>
        ) : (
          rows.map((t) => <TagRow key={t.id} tag={t} />)
        )}
      </div>
    </div>
  )
}

function TagRow({ tag }: { tag: ScaffoldTag }) {
  const tone =
    tag.status === 'tagged_out'
      ? ('bad' as const)
      : tag.last_inspection_status === 'fail'
        ? ('warn' as const)
        : tag.last_inspection_status === 'pass'
          ? ('good' as const)
          : ('default' as const)
  return (
    <Link to={`/scaffold-inspections/${encodeURIComponent(tag.qr_token)}`} className="block">
      <Card tight>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold truncate">{tag.label}</div>
            <div className="text-[11px] text-ink-3 mt-0.5">
              {tag.structure_type}
              {tag.height_m ? <> · {tag.height_m} m</> : null}
              {tag.last_inspection_at ? (
                <> · checked {new Date(tag.last_inspection_at).toLocaleDateString()}</>
              ) : (
                <> · never inspected</>
              )}
            </div>
          </div>
          <Pill tone={tone}>{tag.last_inspection_status ?? tag.status}</Pill>
        </div>
      </Card>
    </Link>
  )
}

// ---------------------------------------------------------------------------
// SVG site-map projection
// ---------------------------------------------------------------------------

const SVG_SIZE = 320

function SiteMapSvg(props: {
  centerLat: number
  centerLng: number
  radiusM: number
  extentM: number
  tags: ReadonlyArray<ScaffoldTag>
  crew: ReadonlyArray<{ worker_id: string; lat: number; lng: number; occurred_at: string; inside: boolean | null }>
}) {
  const { centerLat, centerLng, radiusM, extentM, tags, crew } = props
  const scale = (SVG_SIZE / 2) / extentM
  const project = (lat: number, lng: number): [number, number] => {
    const dx = metersEastward(centerLat, centerLng, lng) * scale
    const dy = metersNorthward(centerLat, lat) * scale
    return [SVG_SIZE / 2 + dx, SVG_SIZE / 2 - dy]
  }
  const radiusPx = radiusM * scale

  return (
    <svg
      viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
      className="w-full h-auto max-h-[420px] mt-1"
      role="img"
      aria-label="Project site map"
    >
      <rect x={0} y={0} width={SVG_SIZE} height={SVG_SIZE} fill="rgba(0,0,0,0.04)" rx={6} />
      {/* Geofence */}
      <circle
        cx={SVG_SIZE / 2}
        cy={SVG_SIZE / 2}
        r={radiusPx}
        fill="rgba(34,197,94,0.08)"
        stroke="rgb(34,197,94)"
        strokeDasharray="4 3"
        strokeWidth={1}
      />
      <text x={SVG_SIZE / 2} y={SVG_SIZE / 2 - radiusPx - 4} textAnchor="middle" fontSize={10} fill="rgb(34,197,94)">
        geofence
      </text>
      {/* Crew dots */}
      {crew.map((c) => {
        const [x, y] = project(c.lat, c.lng)
        return (
          <g key={c.worker_id}>
            <circle cx={x} cy={y} r={6} fill="rgba(56,189,248,0.25)" />
            <circle cx={x} cy={y} r={3} fill="rgb(2,132,199)" />
          </g>
        )
      })}
      {/* Tag dots */}
      {tags.map((t) => {
        const lat = Number(t.lat)
        const lng = Number(t.lng)
        const [x, y] = project(lat, lng)
        const fill =
          t.status === 'tagged_out'
            ? '#dc2626'
            : t.last_inspection_status === 'fail'
              ? '#f59e0b'
              : t.last_inspection_status === 'pass'
                ? '#16a34a'
                : '#64748b'
        return (
          <g key={t.id}>
            <circle cx={x} cy={y} r={5} fill={fill} stroke="white" strokeWidth={1} />
            <title>
              {t.label} · {t.last_inspection_status ?? t.status}
            </title>
          </g>
        )
      })}
      {/* Centerpoint */}
      <circle cx={SVG_SIZE / 2} cy={SVG_SIZE / 2} r={2} fill="rgb(15,23,42)" />
    </svg>
  )
}

function Legend() {
  return (
    <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-ink-3">
      <LegendDot color="#16a34a" label="pass" />
      <LegendDot color="#f59e0b" label="fail" />
      <LegendDot color="#dc2626" label="tagged out" />
      <LegendDot color="#64748b" label="never inspected" />
      <LegendDot color="rgb(2,132,199)" label="recent clock-in" />
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span style={{ background: color }} className="inline-block w-2.5 h-2.5 rounded-full" />
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Tiny geographic helpers. Equirectangular projection at the project's
// center latitude — good enough for jobsite-scale (< few km) plots.
// ---------------------------------------------------------------------------

const EARTH_R_M = 6_371_000

function metersBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const meanLat = ((lat1 + lat2) / 2) * Math.PI / 180
  const x = dLng * Math.cos(meanLat)
  const y = dLat
  return Math.sqrt(x * x + y * y) * EARTH_R_M
}

function metersEastward(centerLat: number, centerLng: number, lng: number): number {
  const dLng = ((lng - centerLng) * Math.PI) / 180
  return dLng * Math.cos((centerLat * Math.PI) / 180) * EARTH_R_M
}

function metersNorthward(centerLat: number, lat: number): number {
  const dLat = ((lat - centerLat) * Math.PI) / 180
  return dLat * EARTH_R_M
}
