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
import { MChip, MChipRow, MPill, MShell, MTopBar } from '../../components/m/index.js'
import type { MTone } from '../../components/m/list.js'
import { useAuditEvents, useProjects, type AuditEvent } from '../../lib/api/index.js'

const MONO = 'var(--m-num)'
const TIGHT = 'var(--m-font-display)'

// ---------------------------------------------------------------------------
// Category chips (ALL / TIME / MONEY / FIELD / BRIEFS) — mirrors the
// V2ActivityLog filter row. Each audit event is bucketed by its entity_type.
// ---------------------------------------------------------------------------
type Category = 'all' | 'time' | 'money' | 'field' | 'briefs'

const CATEGORIES: ReadonlyArray<{ id: Category; label: string }> = [
  { id: 'all', label: 'ALL' },
  { id: 'time', label: 'TIME' },
  { id: 'money', label: 'MONEY' },
  { id: 'field', label: 'FIELD' },
  { id: 'briefs', label: 'BRIEFS' },
]

function categoryFor(event: AuditEvent): Exclude<Category, 'all'> | null {
  const e = `${event.entity_type} ${event.action}`.toLowerCase()
  if (/labor|clock|time|payroll|schedule|crew/.test(e)) return 'time'
  if (/invoice|estimate|billing|payment|material_bill|rental|payroll|damage/.test(e)) return 'money'
  if (/field|issue|blocker|guardrail|takeoff|measurement|daily_log|inspection|stop_work/.test(e)) return 'field'
  if (/brief|message|broadcast|notification|log/.test(e)) return 'briefs'
  return null
}

// ---------------------------------------------------------------------------
// Role chip per row. The audit ledger DOES carry the actor's company role
// (audit_events.actor_role, exposed on AuditEvent), so we tag straight off it
// when present. Older rows (and some system-context writes) left it null; for
// those we fall back to inferring the role from the entity/action surface
// (owner-money/invoice ≈ OWNER, field flags ≈ CREW, briefs/schedule ≈ FOREMAN).
// System actors (no actor_user_id) stay untagged.
// ---------------------------------------------------------------------------
type RoleTag = { label: string; tone: MTone | undefined }

// Company roles → display label + tone. `admin`/`office` read as OWNER-side
// (green), `foreman` as accent, everyone else (member/crew/bookkeeper) plain.
function roleTagForRole(role: string): RoleTag {
  const r = role.toLowerCase()
  if (r === 'admin' || r === 'office' || r === 'owner') return { label: 'OWNER', tone: 'green' }
  if (r === 'foreman') return { label: 'FOREMAN', tone: 'accent' }
  if (r === 'bookkeeper') return { label: 'BOOKKEEPER', tone: 'blue' }
  return { label: r.toUpperCase(), tone: undefined }
}

function roleTagFor(event: AuditEvent): RoleTag | null {
  if (!event.actor_user_id) return null
  // Prefer the real recorded role; only guess from the entity surface when
  // the row didn't capture one.
  if (event.actor_role) return roleTagForRole(event.actor_role)
  const e = `${event.entity_type} ${event.action}`.toLowerCase()
  if (/invoice|estimate|billing|payment|approve|company|integration/.test(e)) return { label: 'OWNER', tone: 'green' }
  if (/field|issue|blocker|clock|measurement|takeoff/.test(e)) return { label: 'CREW', tone: undefined }
  if (/brief|message|schedule|daily_log|crew/.test(e)) return { label: 'FOREMAN', tone: 'accent' }
  return null
}

// Map an audit action to a tone color. Creates read green, destructive
// actions read red, the rest stay neutral ink.
function toneFor(action: string): string {
  const a = action.toLowerCase()
  if (a === 'delete' || a === 'void' || a === 'reject' || a === 'fail' || a.includes('declin')) return 'var(--m-red)'
  if (a === 'create' || a === 'approve' || a === 'post' || a.includes('succeed') || a === 'submit')
    return 'var(--m-green)'
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

// Absolute clock time for the left timeline column (msg__81 shows "9:14",
// "9:12", …). Falls back to empty on an unparseable timestamp.
function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
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
  const [category, setCategory] = useState<Category>('all')

  const events = useAuditEvents({ limit: 200 })
  const projects = useProjects({ limit: 50 })

  const rows = events.data?.events ?? []
  const filtered = useMemo(() => {
    let out = projectId ? rows.filter((e) => e.entity_id === projectId) : rows
    if (category !== 'all') out = out.filter((e) => categoryFor(e) === category)
    return out
  }, [rows, projectId, category])

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

  // When scoped to a single project, frame the header the way msg__81 does:
  // the project name as eyebrow + "ACTIVITY · TODAY" headline. Unscoped, the
  // standalone screen stays the all-roles company timeline.
  const scopedProject = projectId ? projectRows.find((p) => p.id === projectId) : null

  return (
    <MShell>
      <MTopBar
        back
        title={scopedProject ? 'ACTIVITY · TODAY' : 'Activity'}
        eyebrow={scopedProject ? scopedProject.name.toUpperCase() : 'ALL ROLES'}
        onBack={() => navigate(-1)}
      />

      {/* Category chips — ALL / TIME / MONEY / FIELD / BRIEFS. */}
      <MChipRow>
        {CATEGORIES.map((c) => (
          <MChip key={c.id} active={category === c.id} onClick={() => setCategory(c.id)}>
            {c.label}
          </MChip>
        ))}
      </MChipRow>

      {/* Per-project scope (kept from the existing wiring). */}
      {projectRows.length > 0 ? (
        <MChipRow>
          <MChip outline active={projectId === null} onClick={() => setProjectId(null)}>
            ALL PROJECTS
          </MChip>
          {projectRows.map((p) => (
            <MChip key={p.id} outline active={projectId === p.id} onClick={() => setProjectId(p.id)}>
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
          <EmptyState filtered={projectId !== null || category !== 'all'} />
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
  const roleTag = roleTagFor(event)
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
      {/* Left timeline column — absolute clock time (msg__81). */}
      <span
        style={{
          flexShrink: 0,
          width: 44,
          paddingTop: 2,
          textAlign: 'right',
          fontFamily: MONO,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.02em',
          color: 'var(--m-ink-3)',
          fontVariantNumeric: 'tabular-nums',
        }}
        title={relativeTime(event.created_at)}
      >
        {clockTime(event.created_at)}
      </span>

      {/* Colored left-edge bar, tone keyed off the action. */}
      <span style={{ width: 4, alignSelf: 'stretch', background: tone, flexShrink: 0 }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 800, color: 'var(--m-ink)' }}>
            {actorLabel(event)}
          </span>
          {roleTag ? <MPill tone={roleTag.tone}>{roleTag.label}</MPill> : null}
        </div>
        <div
          style={{
            marginTop: 5,
            fontFamily: TIGHT,
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '-0.01em',
            color: 'var(--m-ink)',
            lineHeight: 1.2,
            minWidth: 0,
          }}
        >
          {humanize(event)}
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
