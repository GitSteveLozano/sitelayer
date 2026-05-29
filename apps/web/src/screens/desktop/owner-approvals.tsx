/**
 * Owner desktop approvals queue (Desktop v2 · 05 · APPROVALS QUEUE ·
 * DOwnerApprovals). The cross-entity queue of things that need an owner
 * decision. URGENT items get a red left-border card; each card carries
 * Approve / Deny / Reply.
 *
 * Wiring — unions three REAL pending rails:
 *   - Guardrails (`useActiveGuardrails`): triggered/snoozed margin / schedule
 *     / safety monitors. Approve clears (re-arms), Reply snoozes ~24h, Deny
 *     mutes. Same hooks as the owner-dashboard attention card + recovery-plan.
 *   - Work requests (`useWorkRequests`): open field material / equipment /
 *     issue requests. Approve appends `resolution.accepted`, Deny appends
 *     `work_item.status_changed` → `wont_do`, Reply opens the work thread.
 *   - Change orders (per-project, fanned out across the bootstrap project list
 *     via `useQueries`): COs in `sent` await an owner ACCEPT / REJECT.
 *
 * Every mutation runs through the domain hooks (guardrails / work-requests /
 * change-orders) so success invalidates the right caches and the queue
 * re-renders from fresh server state — no local optimistic-only flips.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import type { BootstrapResponse } from '@/lib/api'
import { DEmptyState, DEyebrow, DH1 } from '@/components/d'
import { MBanner, MButton, MButtonRow, MPill } from '@/components/m'
import type { MTone } from '@/components/m'
import { useActiveGuardrails, useGuardrailAction, type Guardrail } from '@/lib/api/guardrails'
import { useAppendWorkRequestEvent, useWorkRequests, type ContextWorkItem } from '@/lib/api/work-requests'
import {
  changeOrderQueryKeys,
  fetchProjectChangeOrders,
  useAnyProjectChangeOrderEvent,
  type ChangeOrder,
} from '@/lib/api/change-orders'
import { formatMoney } from '../mobile/format.js'

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

type ApprovalRowBase = {
  key: string
  pill: string
  pillTone: MTone | undefined
  item: string
  requestedBy: string
  /** Right-aligned headline: money for COs, threshold/severity otherwise. */
  amountLabel: string
  urgent: boolean
}

type ApprovalRow =
  | (ApprovalRowBase & { kind: 'GUARDRAIL'; guardrail: Guardrail })
  | (ApprovalRowBase & { kind: 'FIELD'; workItem: ContextWorkItem })
  | (ApprovalRowBase & { kind: 'CO'; changeOrder: ChangeOrder })

export function OwnerApprovals({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])

  const guardrailsQuery = useActiveGuardrails()
  const workRequestsQuery = useWorkRequests({ limit: 75 })
  // Change orders are per-project; fan out across the bootstrap project list
  // and keep the COs awaiting an owner ACCEPT / REJECT (status === 'sent').
  const changeOrderQueries = useQueries({
    queries: projects.map((p) => ({
      queryKey: changeOrderQueryKeys.byProject(p.id),
      queryFn: () => fetchProjectChangeOrders(p.id),
      staleTime: 60_000,
    })),
  })

  const { snooze, mute, clear } = useGuardrailAction()
  const workEvent = useAppendWorkRequestEvent()
  const coEvent = useAnyProjectChangeOrderEvent()
  const busy =
    snooze.isPending || mute.isPending || clear.isPending || workEvent.isPending || coEvent.isPending

  const changeOrdersLoading = changeOrderQueries.some((q) => q.isPending)
  const changeOrdersError = changeOrderQueries.find((q) => q.error)?.error ?? null

  const rows = useMemo<ApprovalRow[]>(() => {
    const out: ApprovalRow[] = []
    for (const g of guardrailsQuery.data?.guardrails ?? []) {
      out.push({
        key: `guardrail:${g.id}`,
        kind: 'GUARDRAIL',
        pill: g.type.toUpperCase(),
        pillTone: g.type === 'safety' ? 'red' : g.type === 'margin' ? 'amber' : 'blue',
        item: g.label,
        requestedBy: projectName.get(g.project_id) ?? 'Project monitor',
        amountLabel: `${g.current_value} / ${g.threshold}`,
        urgent: g.status === 'triggered',
        guardrail: g,
      })
    }
    for (const w of workRequestsQuery.data?.work_items ?? []) {
      if (!OPEN_WORK_STATUSES.has(w.status)) continue
      out.push({
        key: `work-request:${w.id}`,
        kind: 'FIELD',
        pill: (w.entity_type ?? 'FIELD').toUpperCase(),
        pillTone: 'accent',
        item: w.title,
        requestedBy: w.route ?? w.summary ?? 'Field request',
        amountLabel: w.severity ? w.severity.toUpperCase() : '—',
        urgent: w.severity === 'urgent' || w.severity === 'high',
        workItem: w,
      })
    }
    for (const q of changeOrderQueries) {
      for (const co of q.data?.change_orders ?? []) {
        if (co.status !== 'sent') continue
        out.push({
          key: `change-order:${co.id}`,
          kind: 'CO',
          pill: `CO #${co.number}`,
          pillTone: 'accent',
          item: co.description || `Change order #${co.number}`,
          requestedBy: projectName.get(co.project_id) ?? 'Project',
          amountLabel: formatMoney(co.value_delta),
          urgent: co.value_delta >= 5000,
          changeOrder: co,
        })
      }
    }
    return out
  }, [guardrailsQuery.data?.guardrails, workRequestsQuery.data?.work_items, changeOrderQueries, projectName])

  const loading = guardrailsQuery.isPending || workRequestsQuery.isPending || changeOrdersLoading
  const error = guardrailsQuery.error || workRequestsQuery.error || changeOrdersError

  const onApprove = (row: ApprovalRow) => {
    if (row.kind === 'GUARDRAIL') {
      clear.mutate(row.guardrail.id)
    } else if (row.kind === 'FIELD') {
      workEvent.mutate({ id: row.workItem.id, input: { event_type: 'resolution.accepted' } })
    } else {
      coEvent.mutate({ id: row.changeOrder.id, event: 'ACCEPT', stateVersion: row.changeOrder.state_version })
    }
  }
  const onDeny = (row: ApprovalRow) => {
    if (row.kind === 'GUARDRAIL') {
      mute.mutate({ id: row.guardrail.id, mutedReason: 'Denied from approvals queue' })
    } else if (row.kind === 'FIELD') {
      workEvent.mutate({
        id: row.workItem.id,
        input: { event_type: 'work_item.status_changed', status: 'wont_do', lane: 'done' },
      })
    } else {
      coEvent.mutate({ id: row.changeOrder.id, event: 'REJECT', stateVersion: row.changeOrder.state_version })
    }
  }
  const onReply = (row: ApprovalRow) => {
    if (row.kind === 'GUARDRAIL') {
      const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      snooze.mutate({ id: row.guardrail.id, snoozedUntil })
    } else if (row.kind === 'FIELD') {
      navigate(`/work/${row.workItem.id}`)
    } else {
      navigate(`/projects/${row.changeOrder.project_id}/change-orders`)
    }
  }

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Approvals</DEyebrow>
          <DH1>Approvals</DH1>
        </div>

        {error ? (
          <MBanner
            tone="error"
            title="Couldn't load approvals"
            body={error instanceof Error ? error.message : 'The pending queue failed to load. Refresh to retry.'}
          />
        ) : loading ? (
          <div className="d-card" style={{ color: 'var(--m-ink-3)' }}>
            Loading pending approvals…
          </div>
        ) : rows.length === 0 ? (
          <DEmptyState
            title="Nothing needs approval"
            body="Triggered guardrails, field material / equipment requests, and sent change orders awaiting your call land here."
          />
        ) : (
          <div className="d-stack" style={{ gap: 12 }}>
            {rows.map((row) => (
              <div
                key={row.key}
                className="d-card"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 16,
                  flexWrap: 'wrap',
                  borderLeft: row.urgent ? '6px solid var(--m-red)' : undefined,
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <MPill tone={row.pillTone}>{row.pill}</MPill>
                    {row.urgent ? <MPill tone="red">URGENT</MPill> : null}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--m-ink)' }}>{row.item}</div>
                  <div style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>{row.requestedBy}</div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                  <span className="num" style={{ fontSize: 16, fontWeight: 800, color: 'var(--m-ink)' }}>
                    {row.amountLabel}
                  </span>
                  <MButtonRow>
                    <MButton size="sm" variant="primary" disabled={busy} onClick={() => onApprove(row)}>
                      Approve
                    </MButton>
                    <MButton size="sm" variant="ghost" disabled={busy} onClick={() => onDeny(row)}>
                      Deny
                    </MButton>
                    <MButton size="sm" variant="quiet" disabled={busy} onClick={() => onReply(row)}>
                      Reply
                    </MButton>
                  </MButtonRow>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
