import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { useAuditEvents, type AuditEvent } from '@/lib/api'

const ENTITY_TYPES = [
  '',
  'project',
  'customer',
  'worker',
  'service_item',
  'pricing_profile',
  'bonus_rule',
  'integration_connection',
  'integration_mapping',
  'inventory_item',
  'inventory_location',
  'inventory_movement',
  'rental_contract',
  'rental_billing_run',
  'estimate_push',
  'daily_log',
  'time_review_run',
  'ai_insight',
]

export function AuditLogScreen() {
  const [entityType, setEntityType] = useState<string>('')
  const [actorUserId, setActorUserId] = useState<string>('')
  const [since, setSince] = useState<string>('')
  const events = useAuditEvents({
    ...(entityType ? { entityType } : {}),
    ...(actorUserId.trim() ? { actorUserId: actorUserId.trim() } : {}),
    ...(since ? { since } : {}),
    limit: 200,
  })
  const rows = events.data?.events ?? []

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more" className="text-[12px] text-ink-3">
        ← More
      </Link>
      <h1 className="mt-2 font-display text-[26px] font-bold tracking-tight leading-tight">Audit log</h1>
      <p className="text-[12px] text-ink-3 mt-1">Append-only ledger of state-changing API calls. Admin-only.</p>

      <Card className="mt-6">
        <label className="block">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Entity type</div>
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
          >
            {ENTITY_TYPES.map((t) => (
              <option key={t || 'all'} value={t}>
                {t || 'all'}
              </option>
            ))}
          </select>
        </label>
        <label className="block mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Actor user id</div>
          <input
            type="text"
            value={actorUserId}
            onChange={(e) => setActorUserId(e.target.value)}
            placeholder="clerk user id"
            className="mt-1 w-full text-[15px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
          />
        </label>
        <label className="block mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Since</div>
          <input
            type="datetime-local"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="mt-1 w-full text-[15px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
          />
        </label>
      </Card>

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">
          {events.isPending ? 'Loading…' : `${rows.length} event${rows.length === 1 ? '' : 's'}`}
        </div>
        {rows.length === 0 && !events.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No events match the current filter.</div>
          </Card>
        ) : (
          rows.map((e) => <EventRow key={e.id} event={e} />)
        )}
        <Attribution source="GET /api/audit-events" />
      </div>
    </div>
  )
}

function EventRow({ event }: { event: AuditEvent }) {
  const [expanded, setExpanded] = useState(false)
  const tone: 'warn' | 'good' | 'default' =
    event.action === 'delete' || event.action === 'void' ? 'warn' : event.action === 'create' ? 'good' : 'default'

  return (
    <Card tight>
      <button type="button" onClick={() => setExpanded((e) => !e)} className="block w-full text-left">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold truncate">
              {event.entity_type} · {event.action}
            </div>
            <div className="text-[11px] text-ink-3 mt-0.5 truncate">
              {event.entity_id ? `${event.entity_id.slice(0, 8)}… · ` : ''}
              {event.actor_user_id ?? 'system'} · {new Date(event.created_at).toLocaleString()}
            </div>
          </div>
          <Pill tone={tone}>{event.action}</Pill>
        </div>
      </button>
      {expanded ? (
        <div className="mt-3 pt-3 border-t border-dashed border-line-2 space-y-2">
          <DiffBlock label="Before" value={event.before} />
          <DiffBlock label="After" value={event.after} />
        </div>
      ) : null}
    </Card>
  )
}

function DiffBlock({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) {
    return (
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
        <div className="text-[11px] text-ink-3 mt-1">—</div>
      </div>
    )
  }
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <pre className="mt-1 text-[11px] font-mono p-2 rounded bg-card-soft overflow-x-auto whitespace-pre-wrap">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}
