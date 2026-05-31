/**
 * Pending-approvals summary — the count + urgency rollup that drives the
 * owner dashboard "Pending approvals" KPI tile and the sidebar "Approvals"
 * nav badge (Desktop v2 · 01 · DASHBOARD).
 *
 * Unions the two cheap, always-enabled approval rails:
 *   - Guardrails (`useActiveGuardrails`): triggered / snoozed monitors.
 *   - Work requests (`useWorkRequests`): open field material / equipment /
 *     issue requests still awaiting an owner decision.
 *
 * The owner-approvals queue additionally fans change orders out per project
 * via `useQueries`; that fan-out is too heavy for the dashboard glance, so it
 * is intentionally excluded here. The result reuses TanStack Query's cache, so
 * the dashboard tile and the shell nav badge share a single set of fetches.
 */
import { useMemo } from 'react'
import { useActiveGuardrails } from './guardrails'
import { useWorkRequests, type ContextWorkItem } from './work-requests'

/** Work-request statuses that still need an owner decision (mirrors the queue). */
const OPEN_WORK_STATUSES = new Set<ContextWorkItem['status']>([
  'new',
  'triaged',
  'human_assigned',
  'review_ready',
  'review_stale',
  'proposal_expired',
  'reopened',
])

export interface PendingApprovalsSummary {
  /** Total pending items (guardrails + open field requests). */
  count: number
  /** How many of those are urgent (triggered guardrail / high|urgent request). */
  urgentCount: number
  /** A short requester label for the first urgent (else first) item, if any. */
  firstRequester: string | null
  isLoading: boolean
}

export function usePendingApprovalsSummary(projectName?: Map<string, string>): PendingApprovalsSummary {
  const guardrailsQuery = useActiveGuardrails()
  const workRequestsQuery = useWorkRequests({ limit: 75 })

  return useMemo<PendingApprovalsSummary>(() => {
    type Pending = { urgent: boolean; requester: string | null }
    const items: Pending[] = []

    for (const g of guardrailsQuery.data?.guardrails ?? []) {
      items.push({
        urgent: g.status === 'triggered',
        requester: projectName?.get(g.project_id) ?? null,
      })
    }
    for (const w of workRequestsQuery.data?.work_items ?? []) {
      if (!OPEN_WORK_STATUSES.has(w.status)) continue
      items.push({
        urgent: w.severity === 'urgent' || w.severity === 'high',
        requester: w.route ?? null,
      })
    }

    const urgentCount = items.filter((i) => i.urgent).length
    const firstRequester = (items.find((i) => i.urgent) ?? items[0])?.requester ?? null

    return {
      count: items.length,
      urgentCount,
      firstRequester,
      isLoading: guardrailsQuery.isPending || workRequestsQuery.isPending,
    }
  }, [
    guardrailsQuery.data?.guardrails,
    guardrailsQuery.isPending,
    workRequestsQuery.data?.work_items,
    workRequestsQuery.isPending,
    projectName,
  ])
}
