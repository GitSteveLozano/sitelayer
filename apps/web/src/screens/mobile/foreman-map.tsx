/**
 * Crew-on-site map — `fm-map`. The dedicated standalone version of the
 * "Map" view-mode that also lives inside `foreman-crew.tsx`. Reached from
 * the Crew screen's "Map" toggle (which navigates to `/map`).
 *
 * Header reads "Crew on site" with a sub of `<primary site> · N of M in
 * fence`; the body is a stylized full-site/geofence map (SVG) — a gridded
 * canvas surface, square dashed geofence rings per active site, and worker
 * pins colored by clock status, plus a live roster. There are no
 * map-provider keys in this environment, so the map is SVG/CSS
 * stylization; no Mapbox/Google dependency is introduced.
 *
 * In-fence vs off-map status is derived from bootstrap labor counts as a
 * proxy until the /api/clock/timeline geofence call is wired (same proxy
 * foreman-crew uses for its status dots).
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import {
  MAvatar,
  MBody,
  MI,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTopBar,
  avatarToneFor,
  initialsFor,
} from '../../components/m/index.js'
import { todayIso } from './format.js'

export function ForemanMap({
  bootstrap,
  companySlug: _companySlug,
}: {
  bootstrap: BootstrapResponse | null
  companySlug: string
}) {
  const navigate = useNavigate()
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const workers = useMemo(() => bootstrap?.workers ?? [], [bootstrap?.workers])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])
  const today = todayIso()

  // Mirror the site-selection ForemanCrewMap uses so the header sub-line
  // ("Hillcrest · 3 of 4 in fence") matches the geofence ring the body
  // draws first. The primary site is the first active project (falling
  // back to the first project overall when none are flagged active).
  const activeProjects = useMemo(() => projects.filter((p) => /progress|active/i.test(p.status)), [projects])
  const mappedProjects = activeProjects.length > 0 ? activeProjects : projects.slice(0, 3)
  const primarySite = mappedProjects[0] ?? null

  // Workers with any logged time today on the primary site count as
  // "in fence"; the rest of the site's expected crew are the denominator.
  const todayLabor = useMemo(
    () => labor.filter((l) => l.occurred_on === today && !l.deleted_at && l.worker_id),
    [labor, today],
  )
  const inFenceCount = primarySite
    ? new Set(todayLabor.filter((l) => l.project_id === primarySite.id).map((l) => l.worker_id)).size
    : 0
  const onSiteTotal = new Set(todayLabor.map((l) => l.worker_id)).size

  const siteName = primarySite ? primarySite.name.split(/\s+/).slice(0, 2).join(' ') : null
  const sub = primarySite
    ? `${siteName} · ${inFenceCount} of ${Math.max(inFenceCount, onSiteTotal)} in fence`
    : `${mappedProjects.length} site${mappedProjects.length === 1 ? '' : 's'}`

  // Derive worker pins from today's labor (same proxy ForemanCrewMap uses);
  // fall back to the first few workers when nothing is clocked in so the
  // canvas is never empty. Positions are deterministic from index/site.
  const fences = mappedProjects.slice(0, 3)
  const fenceBoxes = [
    { x: 40, y: 50 },
    { x: 190, y: 170 },
    { x: 60, y: 270 },
  ]
  const workersById = new Map(workers.map((w) => [w.id, w]))
  const livePins = todayLabor
    .map((entry, index) => {
      const worker = entry.worker_id ? workersById.get(entry.worker_id) : null
      if (!worker) return null
      const fenceIndex = Math.max(
        0,
        fences.findIndex((p) => p.id === entry.project_id),
      )
      return {
        id: `${entry.id}-${worker.id}`,
        worker,
        projectId: entry.project_id,
        hours: Number(entry.hours ?? 0),
        fenceIndex,
        slot: index,
      }
    })
    .filter((pin): pin is NonNullable<typeof pin> => Boolean(pin))

  const pins =
    livePins.length > 0
      ? livePins
      : workers.slice(0, 4).map((worker, index) => ({
          id: `offline-${worker.id}`,
          worker,
          projectId: fences[index % Math.max(1, fences.length)]?.id ?? null,
          hours: 0,
          fenceIndex: index % Math.max(1, fences.length),
          slot: index,
        }))

  const inFence = pins.filter((p) => p.hours > 0).length
  const needsCheck = pins.filter((p) => p.hours === 0).length

  return (
    <>
      <MTopBar
        back
        onBack={() => navigate('/crew')}
        title="Crew on site"
        sub={sub}
        actionIcon={<MI.Search size={20} />}
        actionLabel="Filter"
      />
      <MBody>
        {/* Square, hard-bordered map frame — gridded ink-2 canvas surface
         * with dashed geofence rings and yellow (accent) crew pins. */}
        <div
          style={{
            position: 'relative',
            aspectRatio: '320 / 380',
            width: '100%',
            background: 'var(--m-ink-2)',
            border: '2px solid var(--m-line)',
            overflow: 'hidden',
          }}
        >
          <svg viewBox="0 0 320 380" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
            <defs>
              <pattern id="fm-map-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" stroke="var(--m-line-2)" strokeWidth="0.5" fill="none" opacity="0.45" />
              </pattern>
            </defs>
            <rect width="320" height="380" fill="url(#fm-map-grid)" />
            {/* Stylized roads */}
            <path d="M0 130 L320 110" stroke="var(--m-line-2)" strokeWidth="12" opacity="0.18" />
            <path d="M0 280 L320 260" stroke="var(--m-line-2)" strokeWidth="10" opacity="0.18" />
            <path d="M120 0 L100 380" stroke="var(--m-line-2)" strokeWidth="10" opacity="0.18" />
            <path d="M250 0 L240 380" stroke="var(--m-line-2)" strokeWidth="8" opacity="0.18" />

            {/* Geofence rings + label per active site (square, dashed) */}
            {fences.map((project, i) => {
              const box = fenceBoxes[i] ?? fenceBoxes[0]!
              const label = project.name.split(/\s+/).slice(0, 2).join(' ').toUpperCase()
              return (
                <g key={project.id}>
                  <rect
                    x={box.x}
                    y={box.y}
                    width={80}
                    height={80}
                    fill="none"
                    stroke="var(--m-accent)"
                    strokeWidth={2.5}
                    strokeDasharray="6 3"
                  />
                  <text
                    x={box.x + 4}
                    y={box.y - 4}
                    fontFamily="'JetBrains Mono', ui-monospace, monospace"
                    fontSize={9}
                    fontWeight={700}
                    fill="var(--m-accent)"
                  >
                    {label}
                  </text>
                </g>
              )
            })}

            {/* Worker pins — yellow squares inside the fence box for the
             * site they're clocked into; gray when off-clock. */}
            {pins.map((pin) => {
              const box = fenceBoxes[pin.fenceIndex] ?? fenceBoxes[0]!
              const px = box.x + 12 + ((pin.slot * 17) % 48)
              const py = box.y + 18 + ((pin.slot * 23) % 44)
              const onSite = pin.hours > 0
              return (
                <g
                  key={pin.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${pin.worker.name} ${onSite ? 'in fence' : 'off clock'}`}
                  style={{ cursor: pin.projectId ? 'pointer' : 'default' }}
                  onClick={() => pin.projectId && navigate(`/projects/${pin.projectId}`)}
                >
                  <rect
                    x={px}
                    y={py}
                    width={20}
                    height={20}
                    fill={onSite ? 'var(--m-accent)' : 'var(--m-ink-4)'}
                    stroke="var(--m-line)"
                    strokeWidth={2}
                  />
                  <text
                    x={px + 10}
                    y={py + 14}
                    fontFamily="'JetBrains Mono', ui-monospace, monospace"
                    fontSize={9}
                    fontWeight={800}
                    textAnchor="middle"
                    fill="var(--m-accent-ink)"
                  >
                    {initialsFor(pin.worker.name)}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>

        {/* Mono legend — hard-bordered swatches */}
        <div
          style={{
            display: 'flex',
            gap: 14,
            flexWrap: 'wrap',
            padding: '10px 16px',
            borderBottom: '2px solid var(--m-line)',
          }}
        >
          <LegendItem swatch="var(--m-accent)" label="IN FENCE" count={inFence} />
          <LegendItem swatch="var(--m-ink-4)" label="OFF MAP" count={needsCheck} />
          <LegendItem swatch="transparent" label={`${fences.length} SITES`} />
        </div>

        {/* Live roster */}
        <MSectionH>Roster · live</MSectionH>
        <MListInset>
          {pins.slice(0, 5).map((pin) => (
            <MListRow
              key={pin.id}
              leading={
                <MAvatar initials={initialsFor(pin.worker.name)} tone={avatarToneFor(pin.worker.id)} size="sm" />
              }
              headline={pin.worker.name}
              supporting={fences.find((p) => p.id === pin.projectId)?.name ?? pin.worker.role ?? 'Crew'}
              trailing={
                pin.hours > 0 ? (
                  <MPill tone="green" dot>
                    in fence
                  </MPill>
                ) : (
                  <MPill tone="amber" dot>
                    check
                  </MPill>
                )
              }
            />
          ))}
        </MListInset>
      </MBody>
    </>
  )
}

function LegendItem({ swatch, label, count }: { swatch: string; label: string; count?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          width: 10,
          height: 10,
          background: swatch,
          border: '1.5px solid var(--m-line)',
        }}
      />
      <span
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.04em',
          color: 'var(--m-ink)',
          textTransform: 'uppercase',
        }}
      >
        {label}
        {typeof count === 'number' ? ` · ${count}` : ''}
      </span>
    </div>
  )
}
