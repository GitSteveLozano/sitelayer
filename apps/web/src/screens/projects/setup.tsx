import { useEffect, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { MButton, MPill } from '@/components/m'
import { Attribution } from '@/components/ai'
import { useProjectSetup } from '@/machines/project-setup'

/**
 * `prj-geofence` + project setup — single screen that edits the
 * geofence policy, daily budget, and base project metadata for an
 * existing project.
 *
 * Geofence editor is form-based for Phase 2E: lat / lng / radius
 * inputs + a static OpenStreetMap preview centered on the configured
 * point. Phase 5 polish swaps in a Leaflet drag-circle widget; the
 * data shape stays identical (site_lat / site_lng / site_radius_m).
 *
 * Daily budget + auto-clock policy editors round out the design's
 * project-setup intent (the burden card on fm-today + the
 * auto_clock_in_enabled gate from 1A).
 *
 * Form state, dirty tracking, and the 409 retry path live in
 * `useProjectSetup` (XState). This component is a thin renderer over
 * the machine's snapshot.
 */
export function ProjectSetupScreen() {
  const params = useParams<{ id: string }>()
  const id = params.id ?? null
  const navigate = useNavigate()
  const setup = useProjectSetup(id)
  const { project, form, error, isLoading, isMissing, isSubmitting, isClean, outOfSync } = setup

  // Track whether the user kicked off a save during this mount so we
  // only navigate to the detail screen on the submit→clean transition,
  // not on the initial post-LOAD clean tick.
  const saveInFlightRef = useRef(false)
  useEffect(() => {
    if (isSubmitting) saveInFlightRef.current = true
  }, [isSubmitting])
  useEffect(() => {
    if (saveInFlightRef.current && isClean && project) {
      saveInFlightRef.current = false
      navigate(`/projects/${project.id}`)
    }
  }, [isClean, project, navigate])

  if (isLoading) {
    return <div className="px-5 pt-8 text-[13px] text-ink-3">Loading project…</div>
  }
  if (isMissing || !project) {
    return (
      <div className="px-5 pt-8">
        <h1 className="font-display text-[24px] font-bold tracking-tight">Project not found</h1>
        <p className="mt-2">
          <Link to="/projects" className="text-accent text-[13px] font-medium">
            ← back to projects
          </Link>
        </p>
      </div>
    )
  }

  const onSave = () => {
    setup.submit()
  }

  const hasGeofence = form.siteLat && form.siteLng

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <Link to={`/projects/${project.id}`} className="text-[13px] text-accent font-medium">
          ← back
        </Link>
        <h1 className="mt-2 font-display text-[26px] font-bold tracking-tight">Project setup</h1>
        <div className="text-[12px] text-ink-3 mt-1">{project.name}</div>
      </div>

      <div className="px-4 pb-12 space-y-3">
        <div className="m-card">
          <div className="text-[13px] font-semibold mb-2">Basics</div>
          <Field label="Project name" required>
            <input
              value={form.name}
              onChange={(e) => setup.edit('name', e.target.value)}
              className="w-full p-2.5 rounded border border-line-2 bg-card text-[14px] focus:outline-none focus:border-accent"
            />
          </Field>
          <Field label="Status">
            <MPill tone={project.status === 'active' ? 'green' : 'amber'}>{project.status}</MPill>
          </Field>
        </div>

        <div className="m-card">
          <div className="text-[13px] font-semibold mb-2">Geofence</div>
          <div className="text-[11px] text-ink-3 mb-3">
            Workers entering this radius auto-clock in (when enabled). Drag the geofence on a map comes in Phase 5; for
            now drop the lat/lng from the project address.
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Lat">
              <input
                value={form.siteLat}
                onChange={(e) => setup.edit('siteLat', e.target.value)}
                inputMode="decimal"
                placeholder="49.8951"
                className="w-full p-2.5 rounded border border-line-2 bg-card text-[14px] num focus:outline-none focus:border-accent"
              />
            </Field>
            <Field label="Lng">
              <input
                value={form.siteLng}
                onChange={(e) => setup.edit('siteLng', e.target.value)}
                inputMode="decimal"
                placeholder="-97.1384"
                className="w-full p-2.5 rounded border border-line-2 bg-card text-[14px] num focus:outline-none focus:border-accent"
              />
            </Field>
          </div>
          <Field label={`Radius · ${form.siteRadius}m`}>
            <input
              type="range"
              min={50}
              max={300}
              step={10}
              value={form.siteRadius}
              onChange={(e) => setup.edit('siteRadius', Number(e.target.value))}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-[11px] text-ink-3 mt-0.5">
              <span>50m</span>
              <span>300m</span>
            </div>
          </Field>
          {hasGeofence ? (
            <MapPreview lat={Number(form.siteLat)} lng={Number(form.siteLng)} radius={form.siteRadius} />
          ) : null}
        </div>

        <div className="m-card">
          <div className="text-[13px] font-semibold mb-2">Auto clock-in policy</div>
          <Field label="Mode">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setup.edit('autoEnabled', true)}
                className={`flex-1 px-3 py-2 rounded border text-[13px] ${
                  form.autoEnabled ? 'bg-accent text-white border-transparent' : 'bg-card-soft text-ink-2 border-line'
                }`}
              >
                Auto on entry
              </button>
              <button
                type="button"
                onClick={() => setup.edit('autoEnabled', false)}
                className={`flex-1 px-3 py-2 rounded border text-[13px] ${
                  !form.autoEnabled ? 'bg-accent text-white border-transparent' : 'bg-card-soft text-ink-2 border-line'
                }`}
              >
                Reminder only
              </button>
            </div>
          </Field>
          <Field label={`Auto clock-out grace · ${form.graceSec}s`}>
            <input
              type="range"
              min={0}
              max={1800}
              step={30}
              value={form.graceSec}
              onChange={(e) => setup.edit('graceSec', Number(e.target.value))}
              disabled={!form.autoEnabled}
              className="w-full accent-accent disabled:opacity-50"
            />
          </Field>
          <Field label={`Correction window · ${form.correctionSec}s`}>
            <input
              type="range"
              min={0}
              max={600}
              step={30}
              value={form.correctionSec}
              onChange={(e) => setup.edit('correctionSec', Number(e.target.value))}
              disabled={!form.autoEnabled}
              className="w-full accent-accent disabled:opacity-50"
            />
            <div className="text-[11px] text-ink-3 mt-0.5">
              The "wait, that wasn't me" window on wk-clockin (per-event correctible_until).
            </div>
          </Field>
        </div>

        <div className="m-card">
          <div className="text-[13px] font-semibold mb-2">Daily budget</div>
          <div className="text-[11px] text-ink-3 mb-2">
            Sets the denominator for fm-today-v2's "% under plan". 0 = no plan tracking.
          </div>
          <Field label="Daily budget ($)">
            <input
              value={form.budgetDollars}
              onChange={(e) => setup.edit('budgetDollars', e.target.value)}
              inputMode="decimal"
              placeholder="2400"
              className="w-full p-2.5 rounded border border-line-2 bg-card text-[14px] num focus:outline-none focus:border-accent"
            />
          </Field>
        </div>

        <Attribution source="Saved via PATCH /api/projects/:id (version-checked)" />

        {outOfSync ? (
          <div className="text-[13px] text-warn px-1">
            Project changed on the server — form reloaded. Re-apply your edits and save again.
          </div>
        ) : null}
        {error && !outOfSync ? <div className="text-[13px] text-bad px-1">{error}</div> : null}

        <div className="flex gap-2 pt-2">
          <MButton variant="ghost" onClick={() => navigate(`/projects/${project.id}`)}>
            Cancel
          </MButton>
          <MButton variant="primary" onClick={onSave} disabled={isSubmitting}>
            {isSubmitting ? 'Saving…' : 'Save'}
          </MButton>
        </div>
      </div>
    </div>
  )
}

interface FieldProps {
  label: string
  required?: boolean
  children: React.ReactNode
}
function Field({ label, required, children }: FieldProps) {
  return (
    <div className="mt-3 first:mt-0">
      <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1">
        {label}
        {required ? <span className="text-bad ml-0.5">*</span> : null}
      </label>
      {children}
    </div>
  )
}

interface MapPreviewProps {
  lat: number
  lng: number
  radius: number
}
function MapPreview({ lat, lng, radius }: MapPreviewProps) {
  // Static OSM tile preview, no extra deps. The radius is rendered as
  // a non-interactive SVG circle overlay so the user can sanity-check
  // the size against the satellite reference. Drag-to-edit lands in a
  // future polish.
  const z = 17
  const tile = latLngToTile(lat, lng, z)
  // The "tile.scale" SVG embeds an OSM Static Map URL through the
  // staticmap.openstreetmap.de service via an HTML iframe — but to
  // avoid X-Frame restrictions and external deps in the PWA, we
  // render an inline SVG with grid lines + the geofence circle. The
  // foreman uses lat/lng inputs to position; the preview verifies
  // shape, not satellite imagery.
  // Real map preview lands when Leaflet is added (Phase 5 polish).
  return (
    <div className="mt-3 relative aspect-[2/1] rounded-md overflow-hidden border border-line bg-card-soft">
      <svg viewBox="0 0 200 100" className="absolute inset-0 w-full h-full">
        <defs>
          <pattern id="g" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e8e3db" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="200" height="100" fill="url(#g)" />
        <circle cx="100" cy="50" r="3" fill="#d9904a" />
        <circle
          cx="100"
          cy="50"
          r={Math.min(48, Math.max(8, (radius * 48) / 300))}
          fill="rgba(217,144,74,0.18)"
          stroke="#d9904a"
          strokeWidth="1"
          strokeDasharray="2,2"
        />
      </svg>
      <div className="absolute bottom-1.5 left-2 text-[9px] text-ink-3 num">
        {lat.toFixed(5)}, {lng.toFixed(5)} · z={z} · tile {tile.x},{tile.y}
      </div>
    </div>
  )
}

function latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom)
  const x = Math.floor(((lng + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return { x, y }
}
