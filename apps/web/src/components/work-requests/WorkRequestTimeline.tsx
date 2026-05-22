import { MListInset, MListRow, MSectionH, MPill } from '../m/index.js'
import type { ContextHandoffEvent } from '@/lib/api'

const EVENT_LABEL: Partial<Record<ContextHandoffEvent['event_type'], string>> = {
  'work_item.created': 'Created',
  'work_item.updated': 'Updated',
  'work_item.status_changed': 'Status changed',
  'message.added': 'Message',
  'support_packet.linked': 'Support packet linked',
  'agent.dispatch_requested': 'Agent requested',
  'agent.dispatch_acknowledged': 'Agent acknowledged',
  'agent.dispatch_retried': 'Agent retry',
  'agent.dispatch_cancel_requested': 'Agent cancel requested',
  'agent.message_received': 'Agent message',
  'agent.artifact_attached': 'Artifact attached',
  'agent.proposal_ready': 'Proposal ready',
  'agent.completed': 'Agent completed',
  'human.assigned': 'Human assigned',
  'human.review_requested': 'Review requested',
  'human.reviewed': 'Reviewed',
  'external.github_export_prepared': 'GitHub export prepared',
  'external.github_linked': 'GitHub linked',
  'resolution.accepted': 'Resolved',
  'resolution.reopened': 'Reopened',
  'work_item.reversed': 'Reversed',
}

export function WorkRequestTimeline({ events }: { events: ContextHandoffEvent[] }) {
  return (
    <>
      <MSectionH>Timeline</MSectionH>
      <MListInset>
        {events.map((event) => (
          <MListRow
            key={event.id}
            headline={EVENT_LABEL[event.event_type] ?? event.event_type}
            supporting={eventSupporting(event)}
            trailing={
              <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <span>{formatDateTime(event.recorded_at)}</span>
                <MPill>{event.actor_kind}</MPill>
              </span>
            }
          />
        ))}
      </MListInset>
    </>
  )
}

function eventSupporting(event: ContextHandoffEvent): string {
  const message = text(event.payload.message) ?? text(event.payload.body)
  if (message) return message
  const url = text(event.payload.url)
  if (url) return url
  const status = text(event.payload.status)
  const lane = text(event.payload.lane)
  if (status && lane) return `${status} · ${lane}`
  return event.request_id || event.source_system
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
