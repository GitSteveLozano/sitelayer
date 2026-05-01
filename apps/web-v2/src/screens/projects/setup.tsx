import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { request } from '@/lib/api/client'
import { useQueryClient } from '@tanstack/react-query'
import { projectQueryKeys, useProject } from '@/lib/api/projects'

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
 */
export function ProjectSetupScreen() {
  const params = useParams<{ id: string }>()
  const id = params.id ?? null
  const navigate = useNavigate()
  const qc = useQueryClient()
  const project = useProject(id)
  const data = project.data?.project

  const [name, setName] = useState('')
  const [siteLat, setSiteLat] = useState('')
  const [siteLng, setSiteLng] = useState('')
  const [siteRadius, setSiteRadius] = useState(100)
  const [autoEnabled, setAutoEnabled] = useState(true)
  const [graceSec, setGraceSec] = useState(300)
  const [correctionSec, setCorrectionSec] = useState(120)
  const [budgetDollars, setBudgetDollars] = useState('')
  const [hydrated, setHydrated] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (hydrated || !data) return
    setName(data.name)
    setSiteLat(data.site_lat ?? '')
    setSiteLng(data.site_lng ?? '')
    setSiteRadius(data.site_radius_m ?? 100)
    setAutoEnabled(data.auto_clock_in_enabled)
    setGraceSec(data.auto_clock_out_grace_seconds)
    setCorrectionSec(data.auto_clock_correction_window_seconds)
    setBudgetDollars(((data.daily_budget_cents ?? 0) / 100).toString())
    setHydrated(true)
  }, [data, hydrated])

  if (project.isPending) {
    return <div className="px-5 pt-8 text-[13px] text-ink-3">Loading project…</div>
  }
  if (!data) {
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

  const onSave = async () => {
    setError(null)
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    const lat = siteLat ? Number(siteLat) : null
    const lng = siteLng ? Number(siteLng) : null
    if ((lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90)) ||
        (lng !== null && (!Number.isFinite(lng) || Math.abs(lng) > 180))) {
      setError('Lat / lng out of range')
      return
    }
    const budget = Number(budgetDollars)
    if (!Number.isFinite(budget) || budget < 0) {
      setError('Daily budget must be a non-negative number')
      return
    }
    setSaving(true)
    try {
      await request(`/api/projects/${encodeURIComponent(data.id)}`, {
        method: 'PATCH',
        json: {
          expected_version: data.version,
          name: name.trim(),
          site_lat: lat,
          site_lng: lng,
          site_radius_m: siteRadius,
          auto_clock_in_enabled: autoEnabled,
          auto_clock_out_grace_seconds: graceSec,
          auto_clock_correction_window_seconds: correctionSec,
          daily_budget_cents: Math.round(budget * 100),
        },
      })
      void qc.invalidateQueries({ queryKey: projectQueryKeys.all() })
      navigate(`/projects/${data.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const hasGeofence = siteLat && siteLng

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <Link to={`/projects/${data.id}`} className="text-[13px] text-accent font-medium">
          ← back
        </Link>
        <h1 className="mt-2 font-display text-[26px] font-bold tracking-tight">Project setup</h1>
        <div className="text-[12px] text-ink-3 mt-1">{data.name}</div>
      </div>

      <div className="px-4 pb-12 space-y-3">
        <Card>
          <div className="text-[13px] font-semibold mb-2">Basics</div>
          <Field label="Project name" required>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full p-2.5 rounded border border-line-2 bg-card text-[14px] focus:outline-none focus:border-accent"
            />
          </Field>
          <Field label="Status">
            <Pill tone={data.status === 'active' ? 'good' : 'warn'}>{data.status}</Pill>
          </Field>
        </Card>

        <Card>
          <div className="text-[13px] font-semibold mb-2">Geofence</div>
          <div className="text-[11px] text-ink-3 mb-3">
            Workers entering this radius auto-clock in (when enabled). Drag the geofence on a map
            comes in Phase 5; for now drop the lat/lng from the project address.
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Lat">
              <input
                value={siteLat}
                onChange={(e) => setSiteLat(e.target.value)}
                inputMode="decimal"
                placeholder="49.8951"
                className="w-full p-2.5 rounded border border-line-2 bg-card text-[14px] num focus:outline-none focus:border-accent"
              />
            </Field>
            <Field label="Lng">
              <input
                value={siteLng}
                onChange={(e) => setSiteLng(e.target.value)}
                inputMode="decimal"
                placeholder="-97.1384"
                className="w-full p-2.5 rounded border border-line-2 bg-card text-[14px] num focus:outline-none focus:border-accent"
              />
            </Field>
          </div>
          <Field label={`Radius · ${siteRadius}m`}>
            <input
              type="range"
              min={50}
              max={300}
              step={10}
              value={siteRadius}
              onChange={(e) => setSiteRadius(Number(e.target.value))}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-[11px] text-ink-3 mt-0.5">
              <span>50m</span>
              <span>300m</span>
            </div>
          </Field>
          {hasGeofence ? <MapPreview lat={Number(siteLat)} lng={Number(siteLng)} radius={siteRadius} /> : null}
        </Card>

        <Card>
          <div className="text-[13px] font-semibold mb-2">Auto clock-in policy</div>
          <Field label="Mode">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAutoEnabled(true)}
                className={`flex-1 px-3 py-2 rounded border text-[13px] ${
                  autoEnabled ? 'bg-accent text-white border-transparent' : 'bg-card-soft text-ink-2 border-line'
                }`}
              >
                Auto on entry
              </button>
              <button
                type="button"
                onClick={() => setAutoEnabled(false)}
                className={`flex-1 px-3 py-2 rounded border text-[13px] ${
                  !autoEnabled ? 'bg-accent text-white border-transparent' : 'bg-card-soft text-ink-2 border-line'
                }`}
              >
                Reminder only
              </button>
            </div>
          </Field>
          <Field label={`Auto clock-out grace · ${graceSec}s`}>
            <input
              type="range"
              min={0}
              max={1800}
              step={30}
              value={graceSec}
              onChange={(e) => setGraceSec(Number(e.target.value))}
              disabled={!autoEnabled}
              className="w-full accent-accent disabled:opacity-50"
            />
          </Field>
          <Field label={`Correction window · ${correctionSec}s`}>
            <input
              type="range"
              min={0}
              max={600}
              step={30}
              value={correctionSec}
              onChange={(e) => setCorrectionSec(Number(e.target.value))}
              disabled={!autoEnabled}
              className="w-full accent-accent disabled:opacity-50"
            />
            <div className="text-[11px] text-ink-3 mt-0.5">
              The "wait, that wasn't me" window on wk-clockin (per-event correctible_until).
            </div>
          </Field>
        </Card>

        <Card>
          <div className="text-[13px] font-semibold mb-2">Daily budget</div>
          <div className="text-[11px] text-ink-3 mb-2">
            Sets the denominator for fm-today-v2's "% under plan". 0 = no plan tracking.
          </div>
          <Field label="Daily budget ($)">
            <input
              value={budgetDollars}
              onChange={(e) => setBudgetDollars(e.target.value)}
              inputMode="decimal"
              placeholder="2400"
              className="w-full p-2.5 rounded border border-line-2 bg-card text-[14px] num focus:outline-none focus:border-accent"
            />
          </Field>
        </Card>

        <Attribution source="Saved via PATCH /api/projects/:id (version-checked)" />

        {error ? <div className="text-[13px] text-bad px-1">{error}</div> : null}

        <div className="flex gap-2 pt-2">
          <MobileButton variant="ghost" onClick={() => navigate(`/projects/${data.id}`)}>
            Cancel
          </MobileButton>
          <MobileButton variant="primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </MobileButton>
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
          r={Math.min(48, Math.max(8, radius * 48 / 300))}
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
