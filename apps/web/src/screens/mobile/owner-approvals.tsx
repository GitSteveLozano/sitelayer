/**
 * Owner approvals — `owner-approvals` (mobile, v2 brutalist).
 *
 * The owner's approve / reply / deny inbox. Each pending item that needs an
 * owner decision is a hard-bordered card with a from/when meta line, a kind
 * headline, a detail line, and a three-way action bar (APPROVE / REPLY /
 * DENY). Urgent items get the red left rail. A footer states the escalation
 * contract: unattended items page the owner's phone.
 *
 * Wiring: the inbox unions two REAL company-wide pending rails —
 *   - Guardrails (`useActiveGuardrails`): triggered/snoozed margin / schedule
 *     / safety monitors. APPROVE clears (re-arms) the guardrail, REPLY snoozes
 *     it ~24h, DENY mutes it. Same hooks that power the admin-home attention
 *     card + recovery-plan.
 *   - Work requests (`useWorkRequests`): open field material / equipment /
 *     issue requests. APPROVE appends `resolution.accepted`, DENY opens an
 *     inline reason composer and appends `work_item.status_changed` →
 *     `wont_do` with the owner's note as `message` (the note is what the
 *     foreman's denied-feedback screen at /foreman/denied/:id quotes, and
 *     the server enqueues the foreman notification off this transition),
 *     REPLY opens the work-request thread.
 * Built from the `components/m/` primitives + `var(--m-*)` tokens only.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBanner, MBody, MPill, MTextarea, MTopBar } from '../../components/m/index.js'
import type { MTone } from '../../components/m/list.js'
import { MSkeletonList } from '../../components/m-states/index.js'
import { useActiveGuardrails, useGuardrailAction, type Guardrail } from '../../lib/api/guardrails.js'
import { useAppendWorkRequestEvent, useWorkRequests, type ContextWorkItem } from '../../lib/api/work-requests.js'

const TIGHT = 'var(--m-font-display)'
const MONO = 'var(--m-num)'

/** Guardrail type → card tone + the "over limit" idiom of the design. */
const GUARDRAIL_TONE: Record<Guardrail['type'], MTone> = {
  margin: 'amber',
  schedule: 'blue',
  safety: 'red',
}
const GUARDRAIL_KIND: Record<Guardrail['type'], string> = {
  margin: 'MARGIN · OVER LIMIT',
  schedule: 'SCHEDULE · AT RISK',
  safety: 'SAFETY',
}

/** Work-request statuses that still need an owner decision. */
const OPEN_WORK_STATUSES = new Set<ContextWorkItem['status']>([
  'new',
  'triaged',
  'human_assigned',
  'review_ready',
  'review_stale',
  'proposal_expired',
  'reopened',
])

type ApprovalItem =
  | {
      key: string
      source: 'guardrail'
      from: string
      kind: string
      kindTone: MTone
      amount: string
      detail: string
      when: string
      urgent: boolean
      guardrail: Guardrail
    }
  | {
      key: string
      source: 'work-request'
      from: string
      kind: string
      kindTone: MTone
      amount: string
      detail: string
      when: string
      urgent: boolean
      workItem: ContextWorkItem
    }

export function MobileOwnerApprovals() {
  const navigate = useNavigate()

  // Work-request DENY opens an inline reason composer on the card (the note
  // becomes the denial `message` the foreman sees); guardrail DENY stays an
  // immediate mute.
  const [denyKey, setDenyKey] = useState<string | null>(null)
  const [denyNote, setDenyNote] = useState('')

  const guardrailsQuery = useActiveGuardrails()
  const workRequestsQuery = useWorkRequests({ limit: 75 })
  const { snooze, mute, clear } = useGuardrailAction()
  const workEvent = useAppendWorkRequestEvent()

  const busy = snooze.isPending || mute.isPending || clear.isPending || workEvent.isPending

  const items = useMemo<ApprovalItem[]>(() => {
    const out: ApprovalItem[] = []
    for (const g of guardrailsQuery.data?.guardrails ?? []) {
      out.push({
        key: `guardrail:${g.id}`,
        source: 'guardrail',
        from: g.label.toUpperCase(),
        kind: GUARDRAIL_KIND[g.type],
        kindTone: GUARDRAIL_TONE[g.type],
        amount: `${g.current_value} / ${g.threshold}`,
        detail: g.detail,
        when: relativeWhen(g.triggered_at ?? g.updated_at),
        urgent: g.status === 'triggered',
        guardrail: g,
      })
    }
    for (const w of workRequestsQuery.data?.work_items ?? []) {
      if (!OPEN_WORK_STATUSES.has(w.status)) continue
      out.push({
        key: `work-request:${w.id}`,
        source: 'work-request',
        from: (w.entity_type ?? 'FIELD REQUEST').toUpperCase(),
        kind: w.title.toUpperCase(),
        kindTone: 'accent',
        amount: w.severity ? w.severity.toUpperCase() : '—',
        detail: w.summary ?? w.route ?? 'Field request awaiting your call.',
        when: relativeWhen(w.created_at),
        urgent: w.severity === 'urgent' || w.severity === 'high',
        workItem: w,
      })
    }
    return out
  }, [guardrailsQuery.data?.guardrails, workRequestsQuery.data?.work_items])

  const loading = guardrailsQuery.isPending || workRequestsQuery.isPending
  const error = guardrailsQuery.error || workRequestsQuery.error

  const onApprove = (item: ApprovalItem) => {
    if (item.source === 'guardrail') {
      // APPROVE a guardrail = re-arm (clear) the monitor.
      clear.mutate(item.guardrail.id)
    } else {
      workEvent.mutate({ id: item.workItem.id, input: { event_type: 'resolution.accepted' } })
    }
  }
  const onDeny = (item: ApprovalItem) => {
    if (item.source === 'guardrail') {
      // DENY a guardrail = mute it (acknowledged, stop paging).
      mute.mutate({ id: item.guardrail.id, mutedReason: 'Denied from approvals inbox' })
    } else {
      // Open the inline reason composer — the actual wont_do event is sent
      // from onConfirmDeny so the owner's words travel with the denial.
      setDenyKey(item.key)
      setDenyNote('')
    }
  }
  const onConfirmDeny = (item: ApprovalItem) => {
    if (item.source !== 'work-request') return
    const note = denyNote.trim()
    workEvent.mutate(
      {
        id: item.workItem.id,
        input: {
          event_type: 'work_item.status_changed',
          status: 'wont_do',
          lane: 'done',
          ...(note ? { message: note } : {}),
        },
      },
      { onSuccess: () => setDenyKey(null) },
    )
  }
  const onCancelDeny = () => setDenyKey(null)
  const onReply = (item: ApprovalItem) => {
    if (item.source === 'guardrail') {
      // REPLY = snooze ~24h so it stops paging while you follow up.
      const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      snooze.mutate({ id: item.guardrail.id, snoozedUntil })
    } else {
      // Open the work-request thread to compose a real reply.
      navigate(`/work/${item.workItem.id}`)
    }
  }

  return (
    <>
      <MTopBar
        back
        title={loading ? 'Approvals' : `${items.length} pending`}
        eyebrow="APPROVALS"
        onBack={() => navigate(-1)}
      />
      <MBody>
        {error ? (
          <div style={{ padding: '14px 16px' }}>
            <MBanner
              tone="error"
              title="Couldn't load approvals"
              body={error instanceof Error ? error.message : 'The pending queue failed to load. Pull back and retry.'}
            />
          </div>
        ) : loading ? (
          <MSkeletonList count={3} />
        ) : items.length === 0 ? (
          <EmptyState />
        ) : (
          <div style={{ padding: '14px 16px' }}>
            {items.map((it) => (
              <ApprovalCard
                key={it.key}
                item={it}
                busy={busy}
                denyOpen={denyKey === it.key}
                denyNote={denyNote}
                onDenyNoteChange={setDenyNote}
                onConfirmDeny={onConfirmDeny}
                onCancelDeny={onCancelDeny}
                onApprove={onApprove}
                onDeny={onDeny}
                onReply={onReply}
              />
            ))}
          </div>
        )}
      </MBody>

      {/* Escalation contract — dark footer bar, mono micro-copy. */}
      <div
        style={{
          padding: '12px 20px',
          background: 'var(--m-ink)',
          color: 'var(--m-ink-4)',
          fontFamily: MONO,
          fontSize: 11,
          fontWeight: 600,
          textAlign: 'center',
          borderTop: '2px solid var(--m-ink)',
        }}
      >
        AUTO-ESCALATES TO PHONE IF UNATTENDED 30M
      </div>
    </>
  )
}

function ApprovalCard({
  item,
  busy,
  denyOpen,
  denyNote,
  onDenyNoteChange,
  onConfirmDeny,
  onCancelDeny,
  onApprove,
  onDeny,
  onReply,
}: {
  item: ApprovalItem
  busy: boolean
  denyOpen: boolean
  denyNote: string
  onDenyNoteChange: (note: string) => void
  onConfirmDeny: (item: ApprovalItem) => void
  onCancelDeny: () => void
  onApprove: (item: ApprovalItem) => void
  onDeny: (item: ApprovalItem) => void
  onReply: (item: ApprovalItem) => void
}) {
  return (
    <div
      style={{
        background: 'var(--m-sand)',
        border: '2px solid var(--m-ink)',
        borderLeft: item.urgent ? '6px solid var(--m-red)' : '6px solid var(--m-ink)',
        marginBottom: 12,
      }}
    >
      <div style={{ padding: '14px 16px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 10,
              color: 'var(--m-ink-3)',
              fontWeight: 700,
              letterSpacing: '0.06em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.from}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--m-ink-3)', fontWeight: 600, flexShrink: 0 }}>
            {item.when}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 8, gap: 8 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <MPill tone={item.kindTone}>{item.kind}</MPill>
          </span>
          <span style={{ fontFamily: TIGHT, fontWeight: 800, fontSize: 22, color: 'var(--m-ink)', flexShrink: 0 }}>
            {item.amount}
          </span>
        </div>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: 'var(--m-ink-2)',
            marginTop: 6,
            fontWeight: 600,
            letterSpacing: '0.02em',
          }}
        >
          {item.detail}
        </div>
      </div>

      {/* Deny composer — the owner's note travels as the denial `message`
          and is what the foreman's /foreman/denied/:id screen quotes. */}
      {denyOpen ? (
        <div style={{ borderTop: '2px solid var(--m-ink)', padding: '12px 16px 14px' }}>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.06em',
              color: 'var(--m-ink-3)',
              marginBottom: 8,
            }}
          >
            WHY NOT — THE FOREMAN SEES THIS
          </div>
          <MTextarea
            value={denyNote}
            onChange={(e) => onDenyNoteChange(e.currentTarget.value)}
            placeholder="Why this won't go ahead, and what to do instead…"
            style={{ width: '100%', minHeight: 72 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => onConfirmDeny(item)}
              style={{
                flex: 2,
                padding: '12px 0',
                background: 'var(--m-red)',
                color: '#fff',
                border: '2px solid var(--m-ink)',
                fontFamily: 'var(--m-font)',
                fontWeight: 700,
                fontSize: 14,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? 'DENYING…' : 'CONFIRM DENY'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onCancelDeny}
              style={{
                flex: 1,
                padding: '12px 0',
                background: 'transparent',
                color: 'var(--m-ink-3)',
                border: '2px solid var(--m-ink)',
                fontFamily: 'var(--m-font)',
                fontWeight: 700,
                fontSize: 14,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
              }}
            >
              CANCEL
            </button>
          </div>
        </div>
      ) : null}

      {/* Three-way action bar — APPROVE weighted 2×, REPLY + DENY 1× each. */}
      <div style={{ borderTop: '2px solid var(--m-ink)', display: denyOpen ? 'none' : 'flex' }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => onApprove(item)}
          style={{
            flex: 2,
            padding: '14px 0',
            background: 'var(--m-accent)',
            color: 'var(--m-accent-ink)',
            border: 'none',
            borderRight: '2px solid var(--m-ink)',
            fontFamily: 'var(--m-font)',
            fontWeight: 700,
            fontSize: 14,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          APPROVE
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onReply(item)}
          style={{
            flex: 1,
            padding: '14px 0',
            background: 'transparent',
            color: 'var(--m-ink-3)',
            border: 'none',
            borderRight: '2px solid var(--m-ink)',
            fontFamily: 'var(--m-font)',
            fontWeight: 700,
            fontSize: 14,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          REPLY
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDeny(item)}
          style={{
            flex: 1,
            padding: '14px 0',
            background: 'transparent',
            color: 'var(--m-red)',
            border: 'none',
            fontFamily: 'var(--m-font)',
            fontWeight: 700,
            fontSize: 14,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          DENY
        </button>
      </div>
    </div>
  )
}

function EmptyState() {
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
      <div style={{ marginTop: 16, fontFamily: TIGHT, fontSize: 18, fontWeight: 700 }}>All caught up</div>
      <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 11, fontWeight: 600, color: 'var(--m-ink-3)' }}>
        GUARDRAILS AND FIELD REQUESTS LAND HERE FOR APPROVE / DENY.
      </div>
    </div>
  )
}

/** Compact relative timestamp ("12M", "2H", "5D") for the card meta line. */
function relativeWhen(iso: string | null): string {
  if (!iso) return '—'
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return '—'
  const secs = Math.max(0, (Date.now() - ts) / 1000)
  if (secs < 60) return 'NOW'
  if (secs < 3600) return `${Math.floor(secs / 60)}M`
  if (secs < 86_400) return `${Math.floor(secs / 3600)}H`
  return `${Math.floor(secs / 86_400)}D`
}
