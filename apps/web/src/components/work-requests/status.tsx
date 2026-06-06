import { MPill } from '../m/index.js'
import type { ContextWorkItem, WorkItemSeverity, WorkItemStatus } from '@/lib/api'
import type { MTone } from '../m/index.js'

const STATUS_LABEL: Record<WorkItemStatus, string> = {
  new: 'New',
  triaged: 'Triaged',
  agent_running: 'Agent running',
  human_assigned: 'Human assigned',
  review_ready: 'Review ready',
  review_stale: 'Review stale',
  proposal_expired: 'Proposal expired',
  resolved: 'Resolved',
  reopened: 'Reopened',
  wont_do: 'Wont do',
  reversed: 'Reversed',
}

const STATUS_TONE: Partial<Record<WorkItemStatus, MTone>> = {
  agent_running: 'blue',
  human_assigned: 'amber',
  review_ready: 'accent',
  review_stale: 'amber',
  proposal_expired: 'red',
  resolved: 'green',
  reopened: 'amber',
  wont_do: 'red',
  reversed: 'red',
}

const SEVERITY_LABEL: Record<WorkItemSeverity, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
}

const SEVERITY_TONE: Partial<Record<WorkItemSeverity, MTone>> = {
  high: 'amber',
  urgent: 'red',
}

export function workItemStatusLabel(status: WorkItemStatus): string {
  return STATUS_LABEL[status]
}

export function WorkRequestStatusPill({ status }: { status: WorkItemStatus }) {
  return (
    <MPill tone={STATUS_TONE[status]} dot>
      {STATUS_LABEL[status]}
    </MPill>
  )
}

export function WorkRequestSeverityPill({ severity }: { severity: WorkItemSeverity | null }) {
  if (!severity) return null
  return <MPill tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</MPill>
}

/**
 * "Recall until HH:MM UTC" badge derived from the reversibility window
 * shipped in sitelayer migration 093 + mesh migration 261. The mode is
 * computed from the work item's `expires_at` / `reversed_at` columns:
 *
 *   - reversed_at set     -> "Reversed at HH:MM UTC" (red)
 *   - now > expires_at    -> "Recall window closed" (red)
 *   - within last hour    -> "Recall closes in N min" (red)  (urgency hint)
 *   - otherwise           -> "Recall until HH:MM UTC" (blue)
 *
 * Items with no expires_at are skipped (rendered as null) — that should
 * only happen for pre-093 rows that have not been touched yet.
 */
const HOUR_MS = 60 * 60 * 1000

function formatUtcHHMM(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`
}

export type ReversibilityBadgeMode = 'reversed' | 'closed' | 'closing' | 'active'

export function reversibilityBadgeState(
  workItem: Pick<ContextWorkItem, 'expires_at' | 'reversed_at'>,
  now: number = Date.now(),
): { mode: ReversibilityBadgeMode; label: string; tone?: MTone } | null {
  if (workItem.reversed_at) {
    return { mode: 'reversed', label: `Reversed at ${formatUtcHHMM(workItem.reversed_at)}`, tone: 'red' }
  }
  if (!workItem.expires_at) return null
  const expires = Date.parse(workItem.expires_at)
  if (!Number.isFinite(expires)) return null
  const remainingMs = expires - now
  if (remainingMs <= 0) {
    return { mode: 'closed', label: 'Recall window closed', tone: 'red' }
  }
  if (remainingMs <= HOUR_MS) {
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000))
    return { mode: 'closing', label: `Recall closes in ${minutes} min`, tone: 'red' }
  }
  return { mode: 'active', label: `Recall until ${formatUtcHHMM(workItem.expires_at)}`, tone: 'blue' }
}

export function WorkRequestReversibilityBadge({
  workItem,
  now,
}: {
  workItem: Pick<ContextWorkItem, 'expires_at' | 'reversed_at'>
  now?: number
}) {
  const state = reversibilityBadgeState(workItem, now ?? Date.now())
  if (!state) return null
  return (
    <MPill tone={state.tone} dot>
      {state.label}
    </MPill>
  )
}
