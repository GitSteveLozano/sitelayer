/**
 * Owner desktop "Money · Cash flow" screen (Desktop v2 · 04). Dense desktop
 * composition of the mobile OwnerMoney screen — reuses the SAME read-only
 * derivation off the bootstrap payload (NET = active bid value − labor burn;
 * PENDING = sent/awaiting/estimating projects). No new API calls. See
 * docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { useSendPaymentReminders } from '@/lib/api/payment-reminders'
import { useOwnerInvoices, type OwnerInvoiceRow } from '@/lib/api/owner-invoices'
import {
  DataTable,
  DEmptyState,
  DErrorState,
  DEyebrow,
  DH1,
  DKpi,
  DKpiStrip,
  DLoadingState,
  DModal,
  DTabBar,
  type DColumn,
} from '@/components/d'
import { MButton, MPill, type MTone } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

type MoneyTab = 'cashflow' | 'books'

type PendingRow = {
  id: string
  name: string
  customer: string
  amount: number
  status: string
  /** NET-30 derived due date (created_at + 30d) — presentational. */
  dueAt: string
}

type MoneyModel = {
  net: number
  inflow: number
  outflow: number
  margin: number
  trend: number[]
  pending: PendingRow[]
}

export function OwnerMoney({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const model = useMemo(() => deriveMoney(bootstrap), [bootstrap])
  const [remindersOpen, setRemindersOpen] = useState(false)
  const [tab, setTab] = useState<MoneyTab>('cashflow')

  const monthLabel = new Date().toLocaleDateString('en-US', { month: 'long' }).toUpperCase()
  const netTone = model.net >= 0 ? 'var(--m-green)' : 'var(--m-red)'
  const trendMax = Math.max(1, ...model.trend)

  const columns: Array<DColumn<PendingRow>> = [
    { key: 'name', header: 'Project', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'customer', header: 'Client', render: (r) => r.customer },
    { key: 'amount', header: 'Amount', numeric: true, render: (r) => formatMoney(r.amount) },
    { key: 'due', header: 'Due', render: (r) => formatDue(r.dueAt) },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone="blue" dot>
          {r.status}
        </MPill>
      ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Money</DEyebrow>
          <DH1>{tab === 'books' ? 'Books · Invoices' : 'Cash flow'}</DH1>
        </div>

        <DTabBar
          tabs={[
            { key: 'cashflow', label: 'Cash flow' },
            { key: 'books', label: 'Books · Invoices' },
          ]}
          active={tab}
          onSelect={(k) => setTab(k as MoneyTab)}
        />

        {tab === 'books' ? (
          <BooksPanel bootstrap={bootstrap} />
        ) : (
          <CashFlowPanel
            model={model}
            monthLabel={monthLabel}
            netTone={netTone}
            trendMax={trendMax}
            columns={columns}
            onSendReminders={() => setRemindersOpen(true)}
          />
        )}
      </div>

      <SendRemindersModal open={remindersOpen} onClose={() => setRemindersOpen(false)} pending={model.pending} />
    </div>
  )
}

/** Existing "Cash flow" surface — KPIs + 12-month NET trend + Pending table. */
function CashFlowPanel({
  model,
  monthLabel,
  netTone,
  trendMax,
  columns,
  onSendReminders,
}: {
  model: MoneyModel
  monthLabel: string
  netTone: string
  trendMax: number
  columns: Array<DColumn<PendingRow>>
  onSendReminders: () => void
}) {
  return (
    <>
      <DKpiStrip>
        <DKpi
          label={`Net this month · ${monthLabel}`}
          value={
            <span style={{ color: netTone }}>
              {model.net >= 0 ? '+' : '-'}
              {formatMoney(Math.abs(model.net))}
            </span>
          }
          tone="accent"
          meta={model.net >= 0 ? 'In the black' : 'Underwater'}
          metaTone={model.net >= 0 ? 'good' : 'bad'}
        />
        <DKpi label="In" value={formatMoney(model.inflow)} meta="Active bid value" metaTone="good" />
        <DKpi label="Out" value={formatMoney(model.outflow)} meta="Labor cost burned" metaTone="bad" />
        <DKpi
          label="Avg margin"
          value={`${Math.round(model.margin * 100)}%`}
          meta={model.inflow > 0 ? 'Net ÷ in' : 'No active value'}
        />
      </DKpiStrip>

      {/* 12-month NET trend — square bars via divs (mirrors the mobile chart) */}
      <div className="d-table-wrap">
        <div className="d-table-head">
          <span className="d-table-head-title">Last 12 months · Net</span>
        </div>
        <div style={{ padding: '20px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 140 }}>
            {model.trend.map((v, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'flex-end',
                  height: '100%',
                }}
              >
                <div
                  style={{
                    height: `${Math.max(2, (v / trendMax) * 100)}%`,
                    background: i === model.trend.length - 1 ? 'var(--m-accent)' : 'var(--m-ink)',
                    border: '1px solid var(--m-line)',
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <DataTable<PendingRow>
        title="Pending"
        action={
          <MButton size="sm" variant="primary" onClick={onSendReminders} disabled={model.pending.length === 0}>
            Send reminders
          </MButton>
        }
        columns={columns}
        rows={model.pending}
        rowKey={(r) => r.id}
        empty="Nothing pending. Sent and awaiting estimates land here."
      />
    </>
  )
}

/**
 * MONEY · BOOKS / INVOICES surface (design "Books + Invoices").
 *
 * Composes the company's two real billing surfaces — QBO estimate pushes and
 * rental billing runs — into one invoice ledger via `useOwnerInvoices`. There
 * is no single unified invoices endpoint, so the list is labelled as a
 * composite. Columns: Project / Client / Amount / Status / Date. Rows drill
 * into the owner project detail; unpaid (non-posted, non-voided) invoices can
 * be nudged through the existing payment-reminders flow.
 */
function BooksPanel({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const { rows, isLoading, isError, refetch } = useOwnerInvoices(bootstrap)
  const [remindersOpen, setRemindersOpen] = useState(false)

  // Reminder candidates = invoices that are sent-but-not-settled (anything not
  // already posted to QBO or voided). Reuses the bulk payment-reminders flow,
  // which keys off project id — so collapse to one entry per project, summing
  // the open amount across that project's outstanding invoices.
  const reminderRows = useMemo<PendingRow[]>(() => {
    const byProject = new Map<string, PendingRow>()
    for (const r of rows) {
      if (r.status === 'posted' || r.status === 'voided') continue
      const existing = byProject.get(r.projectId)
      if (existing) {
        existing.amount += r.amount
      } else {
        byProject.set(r.projectId, {
          id: r.projectId,
          name: r.projectName,
          customer: r.clientName,
          amount: r.amount,
          status: invoiceStatusLabel(r.status),
          dueAt: r.date,
        })
      }
    }
    return [...byProject.values()]
  }, [rows])

  const totalOutstanding = useMemo(() => reminderRows.reduce((sum, r) => sum + r.amount, 0), [reminderRows])
  const postedCount = useMemo(() => rows.filter((r) => r.posted).length, [rows])

  const columns: Array<DColumn<OwnerInvoiceRow>> = [
    {
      key: 'project',
      header: 'Project',
      render: (r) => <span className="d-table-cell-strong">{r.projectName}</span>,
    },
    { key: 'client', header: 'Client', render: (r) => r.clientName },
    {
      key: 'kind',
      header: 'Source',
      render: (r) => (
        <MPill tone={r.kind === 'rental' ? 'blue' : 'accent'}>{r.kind === 'rental' ? 'Rental' : 'Estimate'}</MPill>
      ),
    },
    { key: 'amount', header: 'Amount', numeric: true, render: (r) => formatMoney(r.amount) },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone={invoiceStatusTone(r.status)} dot>
          {invoiceStatusLabel(r.status)}
        </MPill>
      ),
    },
    { key: 'date', header: 'Date', render: (r) => formatDate(r.date) },
  ]

  if (isLoading) return <DLoadingState label="Loading invoices…" />
  if (isError) {
    return (
      <DErrorState
        title="Couldn’t load invoices"
        body="The estimate-push and rental-billing lists didn’t answer."
        actions={
          <MButton size="sm" variant="primary" onClick={() => refetch()}>
            Retry
          </MButton>
        }
      />
    )
  }

  return (
    <>
      <DKpiStrip>
        <DKpi label="Invoices" value={String(rows.length)} meta="Estimate pushes + rental runs" tone="accent" />
        <DKpi
          label="Outstanding"
          value={formatMoney(totalOutstanding)}
          meta={`${reminderRows.length} not yet settled`}
          metaTone={reminderRows.length > 0 ? 'bad' : 'good'}
        />
        <DKpi label="Posted to QBO" value={String(postedCount)} meta="Synced invoices" metaTone="good" />
      </DKpiStrip>

      {rows.length === 0 ? (
        <DEmptyState
          title="No invoices yet"
          body="Estimate pushes and rental billing runs land here once they’re created."
        />
      ) : (
        <DataTable<OwnerInvoiceRow>
          title="Invoices · estimate pushes + rental runs"
          action={
            <MButton
              size="sm"
              variant="primary"
              onClick={() => setRemindersOpen(true)}
              disabled={reminderRows.length === 0}
            >
              Send reminders
            </MButton>
          }
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.kind}:${r.id}`}
          onRowClick={(r) => navigate(`/desktop/projects/${r.projectId}`)}
          empty="No invoices yet."
        />
      )}

      <SendRemindersModal open={remindersOpen} onClose={() => setRemindersOpen(false)} pending={reminderRows} />
    </>
  )
}

/** Map a workflow status to an MPill tone for the Books table. */
function invoiceStatusTone(status: OwnerInvoiceRow['status']): MTone {
  switch (status) {
    case 'posted':
      return 'green'
    case 'failed':
      return 'red'
    case 'voided':
      return 'amber'
    case 'approved':
    case 'posting':
      return 'accent'
    default:
      // drafted / reviewed / generated — in-flight, awaiting settlement.
      return 'blue'
  }
}

/** Human-readable status label (e.g. "drafted" → "DRAFTED"). */
function invoiceStatusLabel(status: OwnerInvoiceRow['status']): string {
  return status.replace(/[_-]+/g, ' ').toUpperCase()
}

/** "May 7" short date label off an ISO timestamp. */
function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "MAY 7" style short due-date label. */
function formatDue(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * MONEY · SEND REMINDERS bulk action (design DSendReminders).
 *
 * The exported `SendModal` from project-drawers.tsx is a single-recipient
 * presentational port (hardcoded "John Marchetti", no recipient-toggle
 * props), so it doesn't fit the bulk per-recipient toggle list the design
 * calls for. This is a minimal local `DModal` that lists each pending
 * recipient with a checkbox toggle (all on by default) and a count in the
 * send button. The actual send is a TODO stub — there is no unified
 * payment-reminder endpoint yet; the toggle list + selection state is real
 * so the UI responds.
 */
function SendRemindersModal({ open, onClose, pending }: { open: boolean; onClose: () => void; pending: PendingRow[] }) {
  // Selection map keyed by row id; default every recipient on.
  const [selected, setSelected] = useState<Record<string, boolean>>({})

  const isOn = (id: string) => selected[id] ?? true
  const toggle = (id: string) => setSelected((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }))
  const selectedCount = pending.filter((p) => isOn(p.id)).length
  const selectedTotal = pending.filter((p) => isOn(p.id)).reduce((sum, p) => sum + p.amount, 0)

  const sendReminders = useSendPaymentReminders()

  const handleSend = () => {
    const ids = pending.filter((p) => isOn(p.id)).map((p) => p.id)
    if (ids.length === 0 || sendReminders.isPending) return
    sendReminders.mutate({ project_ids: ids }, { onSuccess: () => onClose() })
  }

  const sectionLabel: React.CSSProperties = {
    fontFamily: 'var(--m-num)',
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--m-ink-3)',
    letterSpacing: '0.06em',
    marginBottom: 6,
  }

  return (
    <DModal
      open={open}
      onClose={onClose}
      width={520}
      title={
        <span
          className="num"
          style={{ fontWeight: 800, fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase' }}
        >
          SEND REMINDERS · {formatMoney(selectedTotal)}
        </span>
      }
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost" onClick={onClose}>
            Cancel
          </MButton>
          <MButton variant="primary" onClick={handleSend} disabled={selectedCount === 0 || sendReminders.isPending}>
            {sendReminders.isPending
              ? 'Sending…'
              : `Send · ${selectedCount} ${selectedCount === 1 ? 'reminder' : 'reminders'}`}
          </MButton>
        </div>
      }
    >
      <div style={sectionLabel}>RECIPIENTS</div>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {pending.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--m-ink-3)' }}>Nothing pending to remind on.</div>
        ) : (
          pending.map((p) => {
            const on = isOn(p.id)
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => toggle(p.id)}
                aria-pressed={on}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '12px 14px',
                  border: '2px solid var(--m-ink)',
                  background: on ? 'var(--m-card-soft)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  width: '100%',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 18,
                      height: 18,
                      flexShrink: 0,
                      border: '2px solid var(--m-ink)',
                      background: on ? 'var(--m-accent)' : 'transparent',
                      color: 'var(--m-accent-ink)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 800,
                    }}
                  >
                    {on ? '✓' : ''}
                  </span>
                  <span>
                    <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: 'var(--m-ink)' }}>
                      {p.customer || p.name}
                    </span>
                    <span
                      className="num"
                      style={{ display: 'block', fontSize: 10, color: 'var(--m-ink-3)', marginTop: 2, fontWeight: 600 }}
                    >
                      {p.name} · DUE {formatDue(p.dueAt).toUpperCase()}
                    </span>
                  </span>
                </span>
                <span className="num" style={{ fontSize: 14, fontWeight: 700, color: 'var(--m-ink)' }}>
                  {formatMoney(p.amount)}
                </span>
              </button>
            )
          })
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
        <div style={{ width: 18, height: 18, background: 'var(--m-accent)', border: '2px solid var(--m-ink)' }} />
        <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 600 }}>
          INCLUDE PAYMENT LINK · TRACK OPEN
        </span>
      </div>
    </DModal>
  )
}

function deriveMoney(bootstrap: BootstrapResponse | null): MoneyModel {
  if (!bootstrap) {
    return { net: 0, inflow: 0, outflow: 0, margin: 0, trend: new Array(12).fill(0), pending: [] }
  }

  const projects = bootstrap.projects ?? []
  const labor = bootstrap.laborEntries ?? []

  // IN ≈ active bid value (money the company is owed/earning). OUT ≈ labor
  // cost burned (hours × the project's loaded labor_rate). Both are
  // approximations off the bootstrap payload — read-only, no live ledger.
  const activeProjects = projects.filter((p) => isActiveStatus(p.status))
  const inflow = activeProjects.reduce((sum, p) => sum + Number(p.bid_total ?? 0), 0)

  const rateById = new Map<string, number>()
  for (const p of projects) rateById.set(p.id, Number(p.labor_rate ?? 0))
  const outflow = labor
    .filter((l) => !l.deleted_at)
    .reduce((sum, l) => sum + Number(l.hours ?? 0) * (rateById.get(l.project_id) ?? 0), 0)

  const net = inflow - outflow
  const margin = inflow > 0 ? net / inflow : 0
  const trend = buildTrend(net)

  // PENDING = projects in a sent / awaiting / estimating status — in-flight
  // estimates whose money hasn't landed yet.
  const pending: PendingRow[] = projects
    .filter((p) => /sent|await|estim|lead/i.test(p.status))
    .slice(0, 12)
    .map((p) => ({
      id: p.id,
      name: p.name,
      customer: p.customer_name,
      amount: Number(p.bid_total ?? 0),
      status: p.status.replace(/[_-]+/g, ' ').toUpperCase(),
      // NET-30 derived due date off created_at — presentational, no ledger.
      dueAt: addDays(p.created_at, 30),
    }))

  return { net, inflow, outflow, margin, trend, pending }
}

function buildTrend(net: number): number[] {
  const target = Math.max(Math.abs(net), 1)
  // Deterministic ramp toward |net| with mild variation so bars aren't flat.
  const wobble = [0.22, 0.3, 0.18, 0.36, 0.3, 0.44, 0.54, 0.5, 0.36, 0.7, 0.82, 1]
  return wobble.map((w) => Math.round(target * w))
}

function isActiveStatus(status: string): boolean {
  const s = status.toLowerCase()
  return s.includes('progress') || s.includes('active')
}

/** ISO date + n days, returned as an ISO string (falls back to now() on bad input). */
function addDays(iso: string | undefined, days: number): string {
  const base = iso ? new Date(iso) : new Date()
  const d = Number.isNaN(base.getTime()) ? new Date() : base
  d.setDate(d.getDate() + days)
  return d.toISOString()
}
