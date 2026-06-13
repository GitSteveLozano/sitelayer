import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { MButton, MI, MPill } from '@/components/m'
import { Attribution } from '@/components/ai'
import { MErrorState } from '@/components/m-states'
import {
  useDeleteMeasurement,
  useProject,
  useProjectMeasurements,
  useServiceItems,
  useTakeoffTags,
  type TakeoffMeasurement,
} from '@/lib/api'
import { readElevation } from '@/lib/takeoff/elevation'
import { useTakeoffCanvasPath } from '@/lib/takeoff/canvas-route'
import { TakeoffTagSheet } from './takeoff-tag-sheet'
import { EstimateLineAssembly } from './estimate-line-assembly'

/**
 * `prj-takeoff-detail` — Sitemap §5 panel 2 ("Measurement detail").
 *
 * Single-measurement view: thumbnail (or geometry summary), header
 * with code + qty + unit, multi-condition tags list, metadata, and
 * Edit / Delete actions. Reached from the to-list rows.
 *
 * Editing routes to the consolidated est-canvas takeoff editor
 * (deep-link-to-measurement pre-selection is a planned est-canvas
 * enhancement; see docs/TAKEOFF_CANVAS_CONSOLIDATION_PLAN.md). Delete
 * confirms via the `.m-sheet` confirm (useMConfirm below) then sends
 * DELETE /api/takeoff/measurements/:id with the row's expected_version
 * for optimistic concurrency.
 */
export function TakeoffDetailScreen() {
  const params = useParams<{ id: string; measurementId: string }>()
  const projectId = params.id
  const canvasPath = useTakeoffCanvasPath()
  const measurementId = params.measurementId
  const navigate = useNavigate()
  const project = useProject(projectId)
  const measurements = useProjectMeasurements(projectId)
  const tags = useTakeoffTags(measurementId)
  const items = useServiceItems()
  const deleteMutation = useDeleteMeasurement()
  const [error, setError] = useState<string | null>(null)
  const [confirm, askConfirm] = useMConfirm()
  const [tagSheetOpen, setTagSheetOpen] = useState(false)

  const measurement: TakeoffMeasurement | undefined = useMemo(
    () => (measurements.data?.measurements ?? []).find((m) => m.id === measurementId),
    [measurements.data, measurementId],
  )

  if (!projectId || !measurementId) {
    return (
      <div className="px-5 pt-8">
        <MErrorState title="Bad URL" body="Missing project or measurement id." code="SLR_400 · BAD URL" />
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
          ← Measurements
        </Link>
        <MErrorState
          title="Measurement not found"
          body="It may have been deleted on another device."
          code="SLR_404 · NOT FOUND"
        />
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
          ← Measurements
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
            className="w-full border-2 border-ink"
          />
        ) : (
          <div className="m-card">
            <div className="m-field-l mb-0">Geometry</div>
            <div className="text-[13px] mt-1">
              {kind ? `${kind} measurement` : 'No geometry recorded'}
              {kind === 'polygon' && hasPoints(measurement) ? ` · ${pointCount(measurement)} vertices` : ''}
              {kind === 'lineal' && hasPoints(measurement) ? ` · ${pointCount(measurement)} segments` : ''}
              {kind === 'count' && hasPoints(measurement) ? ` · ${pointCount(measurement)} markers` : ''}
            </div>
          </div>
        )}

        <div className="m-card">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="m-field-l mb-0">Quantity</div>
              <div className="font-mono tabular-nums text-[28px] font-bold tracking-tight leading-none mt-1">
                {Number.isFinite(qty) ? qty.toFixed(2) : '0.00'}
                <span className="text-[14px] text-ink-3 ml-1.5">{measurement.unit}</span>
              </div>
            </div>
            {elevation !== 'none' ? <MPill>{elevation}</MPill> : null}
          </div>
          {measurement.notes ? (
            <div className="text-[12px] text-ink-2 mt-3 leading-relaxed">{measurement.notes}</div>
          ) : null}
          <div className="m-quiet text-[11px] mt-3">
            Saved {formatTimestamp(measurement.created_at)} · v{measurement.version}
          </div>
        </div>

        <div className="m-card">
          <div className="flex items-center justify-between mb-2">
            <div className="m-field-l mb-0">Multi-condition tags</div>
            <button
              type="button"
              onClick={() => setTagSheetOpen(true)}
              className="text-[12px] font-semibold text-accent"
            >
              {tagsRows.length === 0 ? '+ Add condition' : 'Edit'}
            </button>
          </div>
          {tagsRows.length === 0 ? (
            <div className="text-[12px] text-ink-3 leading-snug">
              One physical surface can carry several billable lines (EPS + basecoat + finish coat + air barrier). Add a
              condition to attach a service item with its own quantity and rate.
            </div>
          ) : (
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
          )}
          <div className="mt-2 pt-2 border-t border-dashed border-line-2">
            <Attribution source="GET /api/takeoff/measurements/:id/tags" />
          </div>
        </div>

        {/* Assembly drill-down — exposes materials + waste + labor for the
            measurement's primary service item. Renders nothing when the
            item has no assembly configured. */}
        <EstimateLineAssembly
          serviceItemCode={measurement.service_item_code}
          lineLabel={`${Number.isFinite(qty) ? qty.toFixed(2) : '0.00'} ${measurement.unit}`}
        />

        {error ? <div className="text-[12px] text-bad">{error}</div> : null}

        <div className="grid grid-cols-2 gap-2 pt-2">
          <MButton variant="primary" onClick={() => navigate(canvasPath(projectId ?? ''))}>
            Edit on canvas
          </MButton>
          <MButton
            variant="ghost"
            onClick={onDelete}
            disabled={deleteMutation.isPending}
            style={{ color: 'var(--m-red)', borderColor: 'var(--m-red)' }}
          >
            {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
          </MButton>
        </div>
      </div>

      <TakeoffTagSheet
        open={tagSheetOpen}
        onClose={() => setTagSheetOpen(false)}
        measurementId={measurement.id}
        defaultQuantity={Number.isFinite(qty) ? qty : undefined}
        defaultUnit={measurement.unit}
      />

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

/**
 * Bottom sheet in the `.m-sheet` idiom (styles/m.css — square corners, 2px
 * ink top rule, hard offset shadow, no grabber/blur). Same pattern as the
 * AssignmentSheet swap in screens/mobile/schedule.tsx (e9b7c7f3); replaces
 * the retired wave-2 kit Sheet. ESC and backdrop-tap dismiss.
 */
function MSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'rgba(15, 14, 12, 0.5)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="m-sheet" style={{ maxWidth: 720 }}>
        <div className="m-sheet-header">
          <div className="m-sheet-title">{title}</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 4,
              color: 'var(--m-ink)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <MI.X size={20} />
          </button>
        </div>
        <div className="m-sheet-body" style={{ padding: '16px 20px 0' }}>
          {children}
        </div>
      </div>
    </div>
  )
}

/**
 * `.m-sheet` replacement for the legacy `useConfirmSheet` hook — same
 * `[node, ask]` API, resolves the promise with the user's choice.
 */
function useMConfirm() {
  const [state, setState] = useState<{
    title: string
    body: string
    confirmLabel: string
    resolve: (ok: boolean) => void
  } | null>(null)

  const settle = (ok: boolean) => {
    state?.resolve(ok)
    setState(null)
  }

  const node =
    state !== null ? (
      <MSheet title={state.title} onClose={() => settle(false)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 16 }}>
          <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.5 }}>{state.body}</div>
          <div className="grid grid-cols-2 gap-2">
            <MButton variant="ghost" onClick={() => settle(false)}>
              Cancel
            </MButton>
            <MButton
              variant="primary"
              onClick={() => settle(true)}
              style={{ background: 'var(--m-red)', borderColor: 'var(--m-red)', color: '#fff' }}
            >
              {state.confirmLabel}
            </MButton>
          </div>
        </div>
      </MSheet>
    ) : null

  const ask = (props: { title: string; body: string; confirmLabel: string }): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      setState({ ...props, resolve })
    })

  return [node, ask] as const
}
