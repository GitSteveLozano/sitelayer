import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Card, MobileButton, Pill, useConfirmSheet } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { ErrorState } from '@/components/shell/ErrorState'
import {
  useDeleteMeasurement,
  useProject,
  useProjectMeasurements,
  useServiceItems,
  useTakeoffTags,
  type TakeoffMeasurement,
} from '@/lib/api'
import { readElevation } from './takeoff-canvas'

/**
 * `prj-takeoff-detail` — Sitemap §5 panel 2 ("Measurement detail").
 *
 * Single-measurement view: thumbnail (or geometry summary), header
 * with code + qty + unit, multi-condition tags list, metadata, and
 * Edit / Delete actions. Reached from the to-list rows.
 *
 * Editing routes to the canvas with this measurement pre-selected
 * (canvas keys off `?selected=<id>` already). Delete confirms via
 * ConfirmSheet then sends DELETE /api/takeoff/measurements/:id with
 * the row's expected_version for optimistic concurrency.
 */
export function TakeoffDetailScreen() {
  const params = useParams<{ id: string; measurementId: string }>()
  const projectId = params.id
  const measurementId = params.measurementId
  const navigate = useNavigate()
  const project = useProject(projectId)
  const measurements = useProjectMeasurements(projectId)
  const tags = useTakeoffTags(measurementId)
  const items = useServiceItems()
  const deleteMutation = useDeleteMeasurement()
  const [error, setError] = useState<string | null>(null)
  const [confirm, askConfirm] = useConfirmSheet()

  const measurement: TakeoffMeasurement | undefined = useMemo(
    () => (measurements.data?.measurements ?? []).find((m) => m.id === measurementId),
    [measurements.data, measurementId],
  )

  if (!projectId || !measurementId) {
    return (
      <div className="px-5 pt-8">
        <ErrorState title="Bad URL" body="Missing project or measurement id." />
      </div>
    )
  }
  if (measurements.isPending || project.isPending) {
    return (
      <div className="px-5 pt-8">
        <div className="text-[13px] text-ink-3">Loading measurement…</div>
      </div>
    )
  }
  if (!measurement) {
    return (
      <div className="px-5 pt-8">
        <Link to={`/projects/${projectId}?tab=takeoff`} className="text-accent text-[13px] font-medium">
          ← Takeoff
        </Link>
        <ErrorState title="Measurement not found" body="It may have been deleted on another device." />
      </div>
    )
  }

  const item = items.data?.serviceItems.find((s) => s.code === measurement.service_item_code)
  const elevation = readElevation(measurement)
  const qty = Number(measurement.quantity)
  const kind = measurement.geometry && 'kind' in measurement.geometry ? measurement.geometry.kind : null
  const tagsRows = tags.data?.tags ?? []

  const onDelete = async () => {
    const ok = await askConfirm({
      title: 'Delete this measurement?',
      body: 'This removes the polygon and any tags attached to it. Cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    setError(null)
    try {
      await deleteMutation.mutateAsync({ id: measurement.id, expected_version: measurement.version })
      navigate(`/projects/${projectId}?tab=takeoff`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <Link to={`/projects/${projectId}?tab=takeoff`} className="text-[12px] text-ink-3">
          ← Takeoff
        </Link>
        <h1 className="mt-2 font-display text-[22px] font-bold tracking-tight leading-tight">
          {measurement.service_item_code}
        </h1>
        <div className="text-[13px] text-ink-2 mt-1">{item?.name ?? 'Unmapped service item'}</div>
      </div>

      <div className="px-4 pb-8 space-y-3">
        {measurement.image_thumbnail ? (
          <img
            src={measurement.image_thumbnail}
            alt={`${measurement.service_item_code} measurement`}
            className="w-full rounded-lg border border-line"
          />
        ) : (
          <Card>
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Geometry</div>
            <div className="text-[13px] mt-1">
              {kind ? `${kind} measurement` : 'No geometry recorded'}
              {kind === 'polygon' && hasPoints(measurement) ? ` · ${pointCount(measurement)} vertices` : ''}
              {kind === 'lineal' && hasPoints(measurement) ? ` · ${pointCount(measurement)} segments` : ''}
              {kind === 'count' && hasPoints(measurement) ? ` · ${pointCount(measurement)} markers` : ''}
            </div>
          </Card>
        )}

        <Card>
          <div className="flex items-baseline justify-between">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Quantity</div>
              <div className="font-mono tabular-nums text-[28px] font-bold tracking-tight leading-none mt-1">
                {Number.isFinite(qty) ? qty.toFixed(2) : '0.00'}
                <span className="text-[14px] text-ink-3 ml-1.5">{measurement.unit}</span>
              </div>
            </div>
            {elevation !== 'none' ? <Pill tone="default">{elevation}</Pill> : null}
          </div>
          {measurement.notes ? (
            <div className="text-[12px] text-ink-2 mt-3 leading-relaxed">{measurement.notes}</div>
          ) : null}
          <div className="text-[11px] text-ink-3 mt-3">
            Saved {formatTimestamp(measurement.created_at)} · v{measurement.version}
          </div>
        </Card>

        {tagsRows.length > 0 ? (
          <Card>
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-2">
              Multi-condition tags
            </div>
            <ul className="divide-y divide-line">
              {tagsRows.map((t) => (
                <li key={t.id} className="py-2 first:pt-0 last:pb-0 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium truncate">{t.service_item_code}</div>
                    {t.notes ? <div className="text-[11px] text-ink-3 truncate">{t.notes}</div> : null}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono tabular-nums text-[13px] font-semibold">
                      {Number(t.quantity).toFixed(2)}
                      <span className="text-[10px] text-ink-3 ml-1">{t.unit}</span>
                    </div>
                    {Number(t.rate) > 0 ? (
                      <div className="font-mono tabular-nums text-[10px] text-ink-3 mt-0.5">
                        ${Number(t.rate).toFixed(2)}/{t.unit}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-2 pt-2 border-t border-dashed border-line-2">
              <Attribution source="GET /api/takeoff/measurements/:id/tags" />
            </div>
          </Card>
        ) : null}

        {error ? <div className="text-[12px] text-bad">{error}</div> : null}

        <div className="grid grid-cols-2 gap-2 pt-2">
          <Link
            to={`/projects/${projectId}/takeoff-canvas?selected=${encodeURIComponent(measurement.id)}`}
            className="block"
          >
            <MobileButton variant="primary">Edit on canvas</MobileButton>
          </Link>
          <MobileButton variant="ghost" onClick={onDelete} disabled={deleteMutation.isPending}>
            {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
          </MobileButton>
        </div>
      </div>

      {confirm}
    </div>
  )
}

function hasPoints(m: TakeoffMeasurement): boolean {
  return Boolean(m.geometry && 'points' in m.geometry && Array.isArray(m.geometry.points))
}

function pointCount(m: TakeoffMeasurement): number {
  if (!hasPoints(m)) return 0
  const pts = (m.geometry as { points?: unknown[] }).points
  return Array.isArray(pts) ? pts.length : 0
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  return (
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  )
}
