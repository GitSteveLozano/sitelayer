/**
 * Owner desktop approvals queue (Desktop v2 · 05 · APPROVALS QUEUE).
 * Read-only-derived view of things that need an owner decision. Today this
 * is derived from bootstrap project status (in-flight estimates awaiting a
 * send/approve decision); time-sheet and change-order approvals will join
 * once a unified cross-entity approve API exists.
 */
import { useMemo } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import { DataTable, DEyebrow, DH1, type DColumn } from '@/components/d'
import { MButton, MButtonRow, MPill } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

type ApprovalKind = 'ESTIMATE' | 'TIME' | 'CO'

type ApprovalRow = {
  id: string
  kind: ApprovalKind
  item: string
  requestedBy: string
  amount: number
}

export function OwnerApprovals({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])

  const rows = useMemo<ApprovalRow[]>(() => {
    // Derive a simple pending list from bootstrap: in-flight estimates
    // (sent / awaiting / estimating) read as ESTIMATE approvals. Keep this
    // read-only-derived — do not invent new API calls.
    return projects
      .filter((p) => /sent|await|estim/i.test(p.status))
      .map((p) => ({
        id: p.id,
        kind: 'ESTIMATE' as const,
        item: p.name,
        requestedBy: p.customer_name || '—',
        amount: Number(p.bid_total ?? 0),
      }))
  }, [projects])

  // TODO: wire to a unified cross-entity approve/deny API once it exists.
  // The approve/deny endpoints are per-workflow today (estimate_push,
  // time_review_run, scaffold_ops_approval, ...) and not yet unified, so
  // these actions are no-ops for now.
  const onApprove = (row: ApprovalRow) => {
    console.log('[owner-approvals] approve (not wired):', row.kind, row.id)
  }
  const onDeny = (row: ApprovalRow) => {
    console.log('[owner-approvals] deny (not wired):', row.kind, row.id)
  }

  const kindTone: Record<ApprovalKind, 'accent' | undefined> = {
    ESTIMATE: 'accent',
    TIME: undefined,
    CO: undefined,
  }

  const columns: Array<DColumn<ApprovalRow>> = [
    {
      key: 'kind',
      header: 'Type',
      render: (r) => <MPill tone={kindTone[r.kind]}>{r.kind}</MPill>,
    },
    { key: 'item', header: 'Item', render: (r) => <span className="d-table-cell-strong">{r.item}</span> },
    { key: 'requestedBy', header: 'Requested by', render: (r) => r.requestedBy },
    { key: 'amount', header: 'Amount', numeric: true, render: (r) => formatMoney(r.amount) },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <MButtonRow>
          <MButton
            size="sm"
            variant="primary"
            onClick={(e) => {
              e.stopPropagation()
              onApprove(r)
            }}
          >
            Approve
          </MButton>
          <MButton
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation()
              onDeny(r)
            }}
          >
            Deny
          </MButton>
        </MButtonRow>
      ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Approvals</DEyebrow>
          <DH1>Approvals</DH1>
        </div>

        <DataTable<ApprovalRow>
          title="Pending approvals"
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.kind}:${r.id}`}
          empty="Nothing needs approval."
        />
      </div>
    </div>
  )
}
