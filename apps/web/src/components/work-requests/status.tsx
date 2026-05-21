import { MPill } from '../m/index.js'
import type { WorkItemSeverity, WorkItemStatus } from '@/lib/api'
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
