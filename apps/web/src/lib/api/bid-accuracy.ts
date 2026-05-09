// Bid-accuracy keystone data layer for the Estimate Builder.
//
// `apps/web/src/lib/api/ai.ts` already exposes a non-scoped `useBidAccuracy()`
// that hits GET /api/ai/bid-accuracy and returns every project in the
// company's cohort. This module adds a project-scoped wrapper used by the
// keystone card on the right rail of the Estimate Builder, plus a typed
// summary suitable for the small reusable card on the project detail
// dashboard (follow-up).
//
// We keep the underlying hook intentionally — re-fetching the same cohort
// payload twice on the same page would double the network cost — and just
// derive the project-scoped slice in-memory. When a richer per-project
// endpoint lands (top-3 comparable jobs by similarity, predicted margin)
// this is the call site that should switch over.

import { useMemo } from 'react'
import {
  useBidAccuracy as useBidAccuracyCohort,
  type AccuracyConfidence,
  type BidAccuracyProject,
  type BidAccuracySummary,
} from './ai'

export interface ProjectBidAccuracyView {
  /** The current project's cohort row, if it exists in the result set. */
  current: BidAccuracyProject | null
  /** Top 3 comparable closed projects, ranked by absolute delta similarity. */
  comparables: BidAccuracyProject[]
  /** Cohort-wide stats (mean delta etc) — survives even when the project itself is mid-flight. */
  summary: BidAccuracySummary | null
  /**
   * Predicted margin pct for the current project. We don't have a true
   * predictive model yet — for now this is mean(closed cohort delta_pct)
   * inverted, so a +12% under-bid cohort yields a -12% predicted margin.
   * When the model lands, this number changes shape but the consumer
   * (BidAccuracyCard) keeps the same prop.
   */
  predicted_margin_pct: number | null
  /** Ordinal confidence — the visible badge on the card. Never numeric. */
  confidence: AccuracyConfidence | null
  /** Source attribution string for the MAttribution line. */
  attribution: string
}

/**
 * Project-scoped view over the cohort bid-accuracy endpoint.
 *
 * Returns `{ data, isPending, isError }` so it composes with TanStack Query
 * patterns elsewhere; the heavy lifting happens in `useMemo` over the
 * underlying cohort response.
 */
export function useBidAccuracy(projectId: string | null | undefined) {
  const cohort = useBidAccuracyCohort()

  const data = useMemo<ProjectBidAccuracyView | null>(() => {
    if (!cohort.data) return null
    const projects = cohort.data.projects
    const summary = cohort.data.summary
    const current = projectId ? (projects.find((p) => p.project_id === projectId) ?? null) : null

    // Top 3 comparable past closed jobs, ranked by smallest |delta_pct|
    // gap to the current project. When the current project isn't in the
    // cohort (brand new), fall back to the most recently closed jobs.
    const closed = projects.filter((p) => p.status === 'completed' || p.status === 'closed')
    const comparables = current
      ? [...closed]
          .filter((p) => p.project_id !== current.project_id)
          .sort((a, b) => Math.abs(a.delta_pct - current.delta_pct) - Math.abs(b.delta_pct - current.delta_pct))
          .slice(0, 3)
      : closed.slice(0, 3)

    // For projects not yet in the cohort we use the cohort mean as a
    // baseline; when the project is in the cohort and closed we use its
    // own delta. Either way the value is intentionally a small integer
    // percentage — the card pretties it.
    const predicted = current ? -current.delta_pct : -summary.mean_closed_delta_pct
    const confidence: AccuracyConfidence | null = current ? current.confidence : closed.length >= 3 ? 'med' : 'low'

    return {
      current,
      comparables,
      summary,
      predicted_margin_pct: Number.isFinite(predicted) ? Number(predicted.toFixed(1)) : null,
      confidence,
      attribution: summary.attribution,
    }
  }, [cohort.data, projectId])

  return {
    data,
    isPending: cohort.isPending,
    isError: cohort.isError,
    error: cohort.error,
    refetch: cohort.refetch,
  }
}

export type { AccuracyConfidence, BidAccuracyProject, BidAccuracySummary }
