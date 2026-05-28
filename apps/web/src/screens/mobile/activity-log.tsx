/**
 * Activity log — `activity-log` (mobile, v2 brutalist).
 *
 * All-roles timeline of state-changing API calls. Reads the existing
 * audit-events ledger (`useAuditEvents` → GET /api/audit-events) — the
 * same admin-only append-only trail surfaced by the settings audit log.
 * No new API.
 *
 * Layout mirrors Steve's `V2ActivityLog`: a vertical timeline where each
 * entry is a square connector dot, a humanized action label (Inter Tight),
 * and a mono actor + relative-timestamp meta line. Entries are grouped by
 * day with mono day dividers. An optional project filter chip row scopes
 * the timeline to a single project's audit rows (matched by entity_id).
 *
 * Built from the `components/m/` primitives + `var(--m-*)` tokens only;
 * no new global CSS.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MChip, MChipRow, MShell, MTopBar } from '../../components/m/index.js'
import { useAuditEvents, useProjects, type AuditEvent } from '../../lib/api/index.js'

const MONO = 'var(--m-num)'
const TIGHT = 'var(--m-font-display)'

// Map an audit action to a tone color. Creates read green, destructive
// actions read red, the rest stay neutral ink.
function toneFor(action: string): string {
  const a = action.toLowerCase()
  if (a === 'delete' || a === 'void' || a === 'reject' || a === 'fail' || a.includes('declin')) return 'var(--m-red)'
  if (a === 'create' || a === 'approve' || a === 'post' || a.includes('succeed') || a === 'submit') return 'var(--m-green)'
  return 'var(--m-ink)'
}

// "rental_billing_run" + "approve" → "APPROVED RENTAL BILLING RUN".
function humanize(event: AuditEvent): string {
  const verbMap: Record<string, string> = {
    create: 'created',
    update: 'updated',
    delete: 'deleted',
    approve: 'approved',
    reject: 'rejected',
    void: 'voided',
    submit: 'submitted',
    post: 'posted',
  }
  const verb = verbMap[event.action.toLowerCase()] ?? event.action.replace(/_/g, ' ')
  const noun = event.entity_type.replace(/_/g, ' ')
  return `${verb} ${noun}`.toUpperCase()
}

function actorLabel(event: AuditEvent): string {
  if (!event.actor_user_id) return 'SYSTEM'
  // Clerk ids are long; show a readable tail.
  const id = event.actor_user_id
  return id.length > 14 ? `…${id.slice(-10)}` : id.toUpperCase()
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  const sec = Math.round(diffMs / 1000)
  if (sec < 60) return 'NOW'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}M AGO`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}H AGO`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}D AGO`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase()
}

function dayKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'UNKNOWN'
  const today = new Date()
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (isSameDay(d, today)) return 'TODAY'
  if (isSameDay(d, yesterday)) return 'YESTERDAY'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
}

export function MobileActivityLog() {
  const navigate = useNavigate()
  const [projectId, setProjectId] = useState<string | null>(null)

  const events = useAuditEvents({ limit: 200 })
  const projects = useProjects({ limit: 50 })

  const rows = events.data?.events ?? []
  const filtered = useMemo(
    () => (projectId ? rows.filter((e) => e.entity_id === projectId) : rows),
    [rows, projectId],
  )

  // Group consecutive entries by day. The hook already returns rows
  // newest-first; we keep that order and emit a divider whenever the day
  // changes.
  const groups = useMemo(() => {
    const out: { day: string; events: AuditEvent[] }[] = []
    for (const e of filtered) {
      const key = dayKey(e.created_at)
      const last = out[out.length - 1]
      if (last && last.day === key) last.events.push(e)
      else out.push({ day: key, events: [e] })
    }
    return out
  }, [filtered])

  const projectRows = projects.data?.projects ?? []

  return (
    <MShell>
      <MTopBar back title="Activity" eyebrow="ALL ROLES" onBack={() => navigate(-1)} />

      {projectRows.length > 0 ? (
        <MChipRow>
          <MChip active={projectId === null} onClick={() => setProjectId(null)}>
            ALL
          </MChip>
          {projectRows.map((p) => (
            <MChip key={p.id} active={projectId === p.id} onClick={() => setProjectId(p.id)}>
              {p.name}
            </MChip>
          ))}
        </MChipRow>
      ) : null}

      <div style={{ flex: 1, overflow: 'auto' }}>
        {events.isPending ? (
          <div style={{ padding: 24, fontFamily: MONO, fontSize: 12, fontWeight: 600, color: 'var(--m-ink-3)' }}>
            LOADING…
          </div>
        ) : groups.length === 0 ? (
          <EmptyState filtered={projectId !== null} />
        ) : (
          groups.map((group) => (
            <section key={group.day}>
              <div
                style={{
                  padding: '10px 20px',
                  borderTop: '2px solid var(--m-ink)',
                  borderBottom: '1px solid var(--m-line-2)',
                  background: 'var(--m-sand-2)',
                  fontFamily: MONO,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  color: 'var(--m-ink-2)',
                }}
              >
                {group.day}
              </div>
              {group.events.map((e) => (
                <ActivityRow key={e.id} event={e} />
              ))}
            </section>
          ))
        )}
      </div>
    </MShell>
  )
}

function ActivityRow({ event }: { event: AuditEvent }) {
  const tone = toneFor(event.action)
  return (
    <div
      style={{
        padding: '14px 20px',
        borderBottom: '1px solid var(--m-line-2)',
        display: 'flex',
        gap: 14,
        alignItems: 'stretch',
      }}
    >
      {/* square dot + connector */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 12, paddingTop: 3 }}>
        <span style={{ width: 12, height: 12, background: tone, border: '1.5px solid var(--m-ink)', flexShrink: 0 }} />
        <span style={{ flex: 1, width: 2, background: 'var(--m-line-2)', marginTop: 4 }} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: TIGHT,
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '-0.01em',
            color: 'var(--m-ink)',
            lineHeight: 1.2,
          }}
        >
          {humanize(event)}
        </div>
        <div
          style={{
            marginTop: 5,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: 8,
            fontFamily: MONO,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.04em',
            color: 'var(--m-ink-3)',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {actorLabel(event)}
          </span>
          <span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{relativeTime(event.created_at)}</span>
        </div>
      </div>
    </div>
  )
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center' }}>
      <div
        style={{
          width: 44,
          height: 44,
          margin: '0 auto',
          border: '2px solid var(--m-ink)',
          background: 'var(--m-sand-2)',
        }}
      />
      <div style={{ marginTop: 16, fontFamily: TIGHT, fontSize: 18, fontWeight: 700 }}>No activity yet</div>
      <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 11, fontWeight: 600, color: 'var(--m-ink-3)' }}>
        {filtered ? 'NO EVENTS FOR THIS PROJECT.' : 'STATE-CHANGING ACTIONS WILL APPEAR HERE.'}
      </div>
    </div>
  )
}
