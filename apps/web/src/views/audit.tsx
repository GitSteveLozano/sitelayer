import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AuditEventRow, SessionResponse } from '../api.js'
import { listAuditEventsApi } from '../api.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Select } from '../components/ui/select.js'

type AuditViewProps = {
  companySlug: string
  session: SessionResponse | null
  publicMetadataRole?: string | null
}

const ENTITY_TYPE_OPTIONS: string[] = [
  'project',
  'customer',
  'worker',
  'labor_entry',
  'blueprint_document',
  'measurement',
  'schedule',
  'material_bill',
  'pricing_profile',
  'bonus_rule',
  'integration_mapping',
  'integration_connection',
  'company',
  'company_membership',
  'service_item',
]

const DEFAULT_LIMIT = 200
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

function formatSinceDefault(): string {
  const d = new Date(Date.now() - SEVEN_DAYS_MS)
  return d.toISOString().slice(0, 10)
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2)
  } catch {
    return String(value)
  }
}

function changedKeys(before: Record<string, unknown> | null, after: Record<string, unknown> | null): Set<string> {
  const keys = new Set<string>()
  const b = before ?? {}
  const a = after ?? {}
  for (const key of Object.keys(b)) {
    if (!(key in a) || JSON.stringify(b[key]) !== JSON.stringify(a[key])) keys.add(key)
  }
  for (const key of Object.keys(a)) {
    if (!(key in b) || JSON.stringify(b[key]) !== JSON.stringify(a[key])) keys.add(key)
  }
  return keys
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toISOString().replace('T', ' ').replace('Z', 'Z')
}

function isAdmin(session: SessionResponse | null, publicMetadataRole: string | null | undefined): boolean {
  if (publicMetadataRole === 'admin') return true
  const role = session?.user.role
  return role === 'admin' || role === 'owner'
}

function AuditRow({ event }: { event: AuditEventRow }) {
  const [expanded, setExpanded] = useState(false)
  const changed = useMemo(() => changedKeys(event.before, event.after), [event.before, event.after])

  const copyJson = async () => {
    const payload = JSON.stringify(event, null, 2)
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(payload)
      }
    } catch {
      /* clipboard blocked — silently ignore */
    }
  }

  return (
    <>
      <tr className="auditRow" onClick={() => setExpanded((current) => !current)}>
        <td>{formatTimestamp(event.created_at)}</td>
        <td>
          <span className="muted compact">{event.actor_user_id ?? '—'}</span>
          {event.actor_role ? <span className="badge">{event.actor_role}</span> : null}
        </td>
        <td>{event.entity_type}</td>
        <td>
          <code>{event.entity_id}</code>
        </td>
        <td>{event.action}</td>
        <td>
          {event.request_id ? (
            <code className="muted compact">{event.request_id.slice(0, 8)}</code>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td>
          <Button
            type="button"
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation()
              void copyJson()
            }}
            aria-label={`Copy audit event ${event.id} as JSON`}
          >
            Copy JSON
          </Button>
        </td>
      </tr>
      {expanded ? (
        <tr className="auditDetailRow">
          <td colSpan={7}>
            <div className="auditDetail">
              <div className="auditDetailMeta">
                <span className="muted compact">id: </span>
                <code>{event.id}</code>
                {event.sentry_trace ? (
                  <>
                    <span className="muted compact"> · trace: </span>
                    <code>{event.sentry_trace}</code>
                  </>
                ) : null}
                {changed.size > 0 ? (
                  <div>
                    <span className="muted compact">changed: </span>
                    {Array.from(changed).map((key) => (
                      <span key={key} className="badge">
                        {key}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="grid">
                <article className="panel">
                  <h3>Before</h3>
                  <pre className="auditJson">{prettyJson(event.before)}</pre>
                </article>
                <article className="panel">
                  <h3>After</h3>
                  <pre className="auditJson">{prettyJson(event.after)}</pre>
                </article>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}

export function AuditView({ companySlug, session, publicMetadataRole }: AuditViewProps) {
  const admin = isAdmin(session, publicMetadataRole ?? null)
  const [entityType, setEntityType] = useState<string>('')
  const [entityId, setEntityId] = useState<string>('')
  const [actorUserId, setActorUserId] = useState<string>('')
  const [since, setSince] = useState<string>(() => formatSinceDefault())
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT)
  const [events, setEvents] = useState<AuditEventRow[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState<number>(0)

  const loadEvents = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listAuditEventsApi(
        {
          ...(entityType ? { entityType } : {}),
          ...(entityId ? { entityId } : {}),
          ...(actorUserId ? { actorUserId } : {}),
          ...(since ? { since: `${since}T00:00:00Z` } : {}),
          limit,
        },
        companySlug,
      )
      setEvents(data.events)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'failed to load audit events')
      setEvents([])
    } finally {
      setLoading(false)
    }
  }, [actorUserId, companySlug, entityId, entityType, limit, since])

  useEffect(() => {
    if (!admin) return
    void loadEvents()
  }, [admin, loadEvents, reloadKey])

  if (!admin) {
    return (
      <section className="panel">
        <h2>Audit Log</h2>
        <p className="muted">
          403 — admin role required. Your current role is {session?.user.role ?? 'unknown'}. Ask the account owner to
          grant admin access.
        </p>
      </section>
    )
  }

  return (
    <>
      <section className="hero">
        <p className="eyebrow">Forensic review</p>
        <h1>Audit Log</h1>
        <p className="lede compact">
          Every recorded change to tenant-scoped entities, newest first. Click a row to expand before/after JSON.
        </p>
      </section>

      <section className="panel">
        <h2>Filters</h2>
        <div className="grid">
          <label>
            <span className="muted compact">Entity type</span>
            <Select value={entityType} onChange={(e) => setEntityType(e.target.value)} aria-label="Entity type filter">
              <option value="">All entity types</option>
              {ENTITY_TYPE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </label>
          <label>
            <span className="muted compact">Entity ID</span>
            <Input
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              placeholder="entity id"
              aria-label="Entity id filter"
            />
          </label>
          <label>
            <span className="muted compact">Actor user id</span>
            <Input
              value={actorUserId}
              onChange={(e) => setActorUserId(e.target.value)}
              placeholder="user_..."
              aria-label="Actor user id filter"
            />
          </label>
          <label>
            <span className="muted compact">Since</span>
            <Input
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              aria-label="Since date filter"
            />
          </label>
          <label>
            <span className="muted compact">Limit</span>
            <Input
              type="number"
              min={1}
              max={1000}
              value={limit}
              onChange={(e) => {
                const next = Number(e.target.value)
                setLimit(Number.isFinite(next) && next > 0 ? Math.min(1000, Math.floor(next)) : DEFAULT_LIMIT)
              }}
              aria-label="Result limit"
            />
          </label>
        </div>
        <div className="auditFilterActions">
          <Button type="button" onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
            {loading ? 'Loading…' : 'Apply filters'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setEntityType('')
              setEntityId('')
              setActorUserId('')
              setSince(formatSinceDefault())
              setLimit(DEFAULT_LIMIT)
              setReloadKey((k) => k + 1)
            }}
          >
            Reset
          </Button>
        </div>
      </section>

      <section className="panel">
        <h2>
          Events <span className="muted compact">({events.length})</span>
        </h2>
        {error ? <p className="muted">Error: {error}</p> : null}
        {!loading && !error && events.length === 0 ? (
          <p className="muted">No events matched those filters.</p>
        ) : null}
        {events.length > 0 ? (
          <div className="auditTableWrap">
            <table className="auditTable">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Actor</th>
                  <th>Entity type</th>
                  <th>Entity ID</th>
                  <th>Action</th>
                  <th>Request</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <AuditRow key={event.id} event={event} />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  )
}
