import { useBlueprintPages, type BlueprintPage } from '@/lib/api'

/**
 * `prj-page-strip` — bottom strip of blueprint-page thumbnails.
 *
 * Real construction plans are 30–200 pages. The canvas needs a fast
 * way to switch between sheets and surface where measurements live.
 * This strip renders one chip per `blueprint_pages` row (mocked
 * thumbnail rectangle, page number, calibration state, measurement
 * count). Tapping switches the active page.
 *
 * The page row carries `measurement_count` so the badge can render
 * without joining `takeoff_measurements` per scroll.
 */
export interface PageStripProps {
  blueprintId: string | null | undefined
  activePageId: string | null
  onSelectPage: (page: BlueprintPage) => void
}

export function PageStrip({ blueprintId, activePageId, onSelectPage }: PageStripProps) {
  const pages = useBlueprintPages(blueprintId)
  const rows = pages.data?.pages ?? []
  if (!blueprintId) return null
  if (pages.isPending) {
    return <div className="px-4 py-2 text-[11px] text-ink-3">Loading pages…</div>
  }
  if (rows.length <= 1) {
    // Single-page blueprint world — strip would just be noise. The
    // caller already shows the document name in the header, so we
    // return null instead of a one-chip strip.
    return null
  }
  return (
    <div className="px-4 pb-2">
      <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
        {rows.map((page) => {
          const active = page.id === activePageId
          const calibrated = isCalibrated(page)
          return (
            <button
              key={page.id}
              type="button"
              onClick={() => onSelectPage(page)}
              className={`shrink-0 w-[88px] rounded-md border text-left ${
                active ? 'border-accent bg-accent/5' : 'border-line bg-card-soft'
              }`}
            >
              <div className="aspect-[4/5] bg-bg rounded-t-md border-b border-line flex items-center justify-center">
                <svg viewBox="0 0 40 50" className="w-full h-full text-line">
                  <rect x={4} y={4} width={32} height={42} fill="none" stroke="currentColor" strokeWidth={0.6} />
                  <line x1={4} y1={18} x2={36} y2={18} stroke="currentColor" strokeWidth={0.4} />
                  <line x1={20} y1={4} x2={20} y2={46} stroke="currentColor" strokeWidth={0.4} />
                </svg>
              </div>
              <div className="px-1.5 py-1 flex items-center justify-between gap-1">
                <span className="text-[10px] font-mono tabular-nums font-semibold">p.{page.page_number}</span>
                <span
                  className={`text-[9px] font-medium ${
                    calibrated ? 'text-good' : 'text-warn'
                  }`}
                  aria-label={calibrated ? 'Calibrated' : 'Uncalibrated'}
                >
                  {calibrated ? 'cal' : 'uncal'}
                </span>
              </div>
              <div className="px-1.5 pb-1.5 flex items-center justify-between text-[10px]">
                <span
                  className={`font-mono tabular-nums ${
                    page.measurement_count > 0 ? 'text-ink font-semibold' : 'text-ink-3'
                  }`}
                >
                  {page.measurement_count} m
                </span>
                {active ? <span className="text-accent text-[10px] font-semibold">·</span> : null}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function isCalibrated(page: BlueprintPage): boolean {
  return Boolean(
    page.calibration_world_distance &&
      page.calibration_x1 &&
      page.calibration_y1 &&
      page.calibration_x2 &&
      page.calibration_y2,
  )
}
