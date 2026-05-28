/**
 * Owner desktop activity log — the comms "what changed" ledger (Desktop v2).
 *
 * Reuses the same admin-only audit-events ledger (`useAuditEvents` →
 * GET /api/audit-events) that the mobile `MobileActivityLog` surfaces. No
 * new API. Where the mobile screen is a vertical day-grouped timeline, the
 * desktop composition is a dense DataTable (When · Actor · Action · Entity ·
 * Detail) with an optional project/entity filter chip row. Newest-first,
 * day-grouped via subheader rows inside the table.
 *
 * Built from the `components/d` + `components/m` primitives + `var(--m-*)`
 * tokens only; no new global CSS.
 */
import { useMemo, useState } from 'react'
import { useAuditEvents, useProjects, type AuditEvent } from '@/lib/api'
import { DataTable, DEyebrow, DH1, type DColumn } from '@/components/d'
import { MChip, MChipRow, MPill, type MTone } from '@/components/m'

const MONO = 'var(--m-num)'
const TIGHT = 'var(--m-font-display)'

// Destructive actions read as a bad pill, creates/approvals as good, the
// rest neutral.
function actionTone(action: string): MTone | undefined {
  const a = action.toLowerCase()
  if (a === 'delete' || a === 'void' || a === 'reject' || a === 'fail' || a.includes('declin')) return 'red'
  if (a === 'create' || a === 'approve' || a === 'post' || a.includes('succeed') || a === 'submit') return 'green'
  return undefined
}

// "rental_billing_run" + "approve" → "Approved rental billing run".
function humanizeAction(event: AuditEvent): string {
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
  return verb.charAt(0).toUpperCase() + verb.slice(1)
}

function humanizeEntity(entityType: string): string {
  const noun = entityType.replace(/_/g, ' ')
  return noun.charAt(0).toUpperCase() + noun.slice(1)
}

function actorLabel(event: AuditEvent): string {
  if (!event.actor_user_id) return 'SYSTEM'
  const id = event.actor_user_id
  return id.length > 14 ? `…${id.slice(-10)}` : id.toUpperCase()
}

function entityDetail(event: AuditEvent): string {
  if (!event.entity_id) return '—'
  const id = event.entity_id
  return id.length > 12 ? `…${id.slice(-8)}` : id
}

function whenLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d
    .toLocaleString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    .toUpperCase()
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

// Each row carries the event plus the day label (rendered only on the first
// row of a day, so the table reads as day-grouped without a custom row API).
type ActivityRow = { id: string; event: AuditEvent; dayLabel: string | null }

export function OwnerActivity() {
  const [projectId, setProjectId] = useState<string | null>(null)

  const events = useAuditEvents({ limit: 200 })
  const projects = useProjects({ limit: 50 })

  const raw = events.data?.events ?? []
  const filtered = useMemo(
    () => (projectId ? raw.filter((e) => e.entity_id === projectId) : raw),
    [raw, projectId],
  )

  // Hook returns rows newest-first; keep that order and stamp a day label on
  // the first row of each day so the table reads as day-grouped.
  const rows = useMemo<ActivityRow[]>(() => {
    let lastDay: string | null = null
    return filtered.map((e) => {
      const key = dayKey(e.created_at)
      const dayLabel = key !== lastDay ? key : null
      lastDay = key
      return { id: e.id, event: e, dayLabel }
    })
  }, [filtered])

  const projectRows = projects.data?.projects ?? []

  const columns: Array<DColumn<ActivityRow>> = [
    {
      key: 'when',
      header: 'When',
      render: (r) => (
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
          {r.dayLabel ? (
            <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--m-ink-2)' }}>
              {r.dayLabel}
            </span>
          ) : null}
          <span style={{ fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: 'var(--m-ink-3)' }}>
            {whenLabel(r.event.created_at)}
          </span>
        </span>
      ),
    },
    {
      key: 'actor',
      header: 'Actor',
      render: (r) => (
        <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--m-ink-2)' }}>{actorLabel(r.event)}</span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (r) => (
        <span className="d-table-cell-strong" style={{ fontFamily: TIGHT }}>
          {humanizeAction(r.event)}
        </span>
      ),
    },
    {
      key: 'entity',
      header: 'Entity',
      render: (r) => (
        <MPill tone={actionTone(r.event.action)} dot>
          {humanizeEntity(r.event.entity_type)}
        </MPill>
      ),
    },
    {
      key: 'detail',
      header: 'Detail',
      render: (r) => (
        <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--m-ink-3)' }}>{entityDetail(r.event)}</span>
      ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Comms · Activity</DEyebrow>
          <DH1>Activity</DH1>
        </div>

        {projectRows.length > 0 ? (
          <MChipRow>
            <MChip active={projectId === null} onClick={() => setProjectId(null)}>
              All
            </MChip>
            {projectRows.map((p) => (
              <MChip key={p.id} active={projectId === p.id} onClick={() => setProjectId(p.id)}>
                {p.name}
              </MChip>
            ))}
          </MChipRow>
        ) : null}

        <DataTable<ActivityRow>
          title="Audit ledger"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty={
            events.isPending
              ? 'Loading…'
              : projectId
                ? 'No events for this project.'
                : 'No activity yet. State-changing actions will appear here.'
          }
        />
      </div>
    </div>
  )
}
