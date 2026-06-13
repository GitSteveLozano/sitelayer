import { MBanner, MButton } from '@/components/m'
import { isEstimateStale, type ScopeVsBidResponse } from '@/lib/api'

/**
 * `EstimateStalenessBanner` (H4) — the persistent "Estimate out of date —
 * Recompute" banner shown across the estimate builder / quantities / summary
 * screens.
 *
 * The estimate is derived from the takeoff (measurements + attached
 * assemblies/rates) but only refreshes on an explicit recompute. When a
 * measurement, assembly, or rate is edited after the last recompute the
 * estimate goes silently stale. The server surfaces a derived `is_stale` flag
 * (plus the underlying `recomputed_at` / `source_updated_at` timestamps) on the
 * scope-vs-bid snapshot; `isEstimateStale` reads it (with a client-side
 * timestamp fallback). When stale we render a warn banner with an inline
 * Recompute action so the estimator can refresh in place before sending.
 *
 * Renders nothing when the snapshot is fresh / absent, so it's safe to drop in
 * unconditionally at the top of each screen.
 */
export function EstimateStalenessBanner({
  snapshot,
  onRecompute,
  recomputing = false,
  className = '',
}: {
  snapshot: ScopeVsBidResponse | null | undefined
  onRecompute: () => void
  /** True while a recompute is in flight — disables the action + relabels it. */
  recomputing?: boolean
  className?: string
}) {
  if (!isEstimateStale(snapshot)) return null
  const banner = (
    <MBanner
      tone="warn"
      title="Estimate out of date"
      body="A measurement, assembly, or rate changed after this estimate was last computed. Recompute from the takeoff before sending."
      action={
        <MButton variant="ghost" size="sm" disabled={recomputing} onClick={onRecompute}>
          {recomputing ? 'Recomputing…' : 'Recompute'}
        </MButton>
      }
    />
  )
  // `.m-banner` carries its own 10/16 margins; the className hook lets
  // callers position the banner in their layout (same contract as before).
  return className ? <div className={className}>{banner}</div> : banner
}
