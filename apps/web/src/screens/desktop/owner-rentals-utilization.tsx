/**
 * Owner desktop rentals — utilization + service (Desktop v2).
 * A KPI strip (fleet avg util / idle revenue/day / out-for-service), then
 * a 2-column split: per-asset utilization table (underutilized rows
 * flagged red) on the left, a service log card on the right.
 *
 * Utilization + idle-revenue come from the real `useInventoryUtilization`
 * rollup (GET /api/inventory/utilization): per-item on-rent vs available
 * balances and the fleet deployment headline. The service log lists real
 * inventory_service_tickets (GET /api/inventory/service-tickets): the
 * first-class maintenance lifecycle (open → in_service → done). "+ LOG"
 * opens a ticket against a stocked asset; per-row controls advance a ticket
 * to in-service / done. See owner-dashboard.tsx for the d-content +
 * '@/components/d' patterns.
 */
import { useMemo, useState } from 'react'
import { useInventoryItems, useInventoryUtilization } from '@/lib/api/rentals'
import {
  useOpenServiceTicket,
  usePatchServiceTicket,
  useServiceTickets,
  type ServiceTicketStatus,
} from '@/lib/api/inventory-service-tickets'
import { selectAvailabilityRows } from '@/lib/api/inventory-availability'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, DModal, type DColumn } from '@/components/d'
import { MButton, MPill, MSelect, MTextarea } from '@/components/m'
import { formatMoney, shortDate } from '../mobile/format.js'

// Underutilized threshold — rows below this get flagged red.
const UNDERUTILIZED_PCT = 50

type AssetRow = {
  id: string
  asset: string
  utilizationPct: number
  // Real idle revenue/day from the rollup (available units × default rate).
  // There is no per-item billed-revenue endpoint (see GAP LIST).
  idleRevenuePerDay: number
  underutilized: boolean
}

type ServiceEntry = {
  id: string
  date: string
  item: string
  status: ServiceTicketStatus
}

const SERVICE_STATUS_TONE: Record<ServiceTicketStatus, 'amber' | 'blue' | 'green'> = {
  open: 'amber',
  in_service: 'blue',
  done: 'green',
}

const SERVICE_STATUS_LABEL: Record<ServiceTicketStatus, string> = {
  open: 'open',
  in_service: 'in service',
  done: 'done',
}

export function OwnerRentalsUtilization() {
  const utilizationQuery = useInventoryUtilization()
  const itemsQuery = useInventoryItems()
  // The service log is the real inventory_service_tickets ledger — assets
  // with an open / in-progress / completed maintenance lifecycle.
  const serviceTicketsQuery = useServiceTickets()
  const openTicket = useOpenServiceTicket()
  // Per-row status advance. One hook instance drives every row; the target
  // ticket id rides in the mutation variables.
  const patchTicket = usePatchServiceTicket()
  const [logOpen, setLogOpen] = useState(false)
  const [logItemId, setLogItemId] = useState('')
  const [logNotes, setLogNotes] = useState('')

  const { rows, fleetAvgUtil, idleRevenuePerDay } = useMemo(() => {
    const availability = selectAvailabilityRows(utilizationQuery.data?.items ?? [])
    const rows: AssetRow[] = availability.map((r) => ({
      id: r.inventory_item_id,
      asset: r.description,
      utilizationPct: Math.round(r.utilization_pct),
      idleRevenuePerDay: r.idle_revenue_per_day,
      underutilized: r.utilization_pct < UNDERUTILIZED_PCT,
    }))
    // Prefer the API's fleet headline; fall back to a per-item average.
    const fleetPct = utilizationQuery.data?.totals?.utilization_pct
    const fleetAvgUtil =
      typeof fleetPct === 'number'
        ? Math.round(fleetPct)
        : rows.length > 0
          ? Math.round(rows.reduce((sum, r) => sum + r.utilizationPct, 0) / rows.length)
          : 0
    const idleRevenuePerDay = (Number(utilizationQuery.data?.totals?.total_idle_revenue_per_day_cents ?? 0) || 0) / 100
    return { rows, fleetAvgUtil, idleRevenuePerDay }
  }, [utilizationQuery.data?.items, utilizationQuery.data?.totals])

  // Map inventory_item_id → "CODE · description" for service-log labels.
  const itemLabelById = useMemo(() => {
    const map = new Map<string, string>()
    for (const it of itemsQuery.data?.inventoryItems ?? []) {
      map.set(it.id, [it.code, it.description].filter(Boolean).join(' · ') || 'Inventory item')
    }
    return map
  }, [itemsQuery.data?.inventoryItems])

  // Service log straight from inventory_service_tickets (open → in_service →
  // done). Newest-first per the API ordering.
  const serviceLog: ServiceEntry[] = useMemo(
    () =>
      (serviceTicketsQuery.data?.service_tickets ?? []).map((t) => ({
        id: t.id,
        date: shortDate(t.opened_at),
        item: itemLabelById.get(t.inventory_item_id) ?? 'Inventory item',
        status: t.status,
      })),
    [serviceTicketsQuery.data?.service_tickets, itemLabelById],
  )
  // Out-for-service headcount = open + in-service tickets (the active backlog).
  const openServiceCount = serviceLog.filter((e) => e.status !== 'done').length

  // Stocked assets available as "+ LOG" targets.
  const logItemOptions = itemsQuery.data?.inventoryItems ?? []

  const advanceTicket = (ticketId: string, status: ServiceTicketStatus) => {
    patchTicket.mutate({ id: ticketId, status })
  }

  const handleLogSubmit = () => {
    if (!logItemId || openTicket.isPending) return
    openTicket.mutate(
      { inventory_item_id: logItemId, notes: logNotes.trim() || null },
      {
        onSuccess: () => {
          setLogOpen(false)
          setLogItemId('')
          setLogNotes('')
        },
      },
    )
  }

  const columns: Array<DColumn<AssetRow>> = [
    {
      key: 'asset',
      header: 'Asset',
      render: (r) => (
        <span className="d-table-cell-strong" style={r.underutilized ? { color: 'var(--m-red)' } : undefined}>
          {r.asset}
        </span>
      ),
    },
    {
      key: 'utilization',
      header: 'Utilization',
      render: (r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            aria-hidden
            style={{
              flex: 1,
              height: 6,
              background: 'var(--m-line)',
              border: '1px solid var(--m-ink)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${Math.min(100, Math.max(0, r.utilizationPct))}%`,
                height: '100%',
                background: r.underutilized ? 'var(--m-red)' : 'var(--m-accent)',
              }}
            />
          </div>
          <span className="num" style={{ minWidth: 36, textAlign: 'right' }}>
            {r.utilizationPct}%
          </span>
        </div>
      ),
    },
    {
      key: 'idle',
      header: 'Idle/day',
      numeric: true,
      render: (r) => formatMoney(r.idleRevenuePerDay),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Rentals</DEyebrow>
          <DH1>Utilization + service.</DH1>
        </div>

        <DKpiStrip>
          <DKpi
            label="Fleet avg util"
            value={String(fleetAvgUtil)}
            unit="%"
            meta={`${rows.length} ${rows.length === 1 ? 'stocked asset' : 'stocked assets'}`}
          />
          <DKpi label="Idle revenue/day" value={formatMoney(idleRevenuePerDay)} meta="Available units idling" />
          <DKpi
            label="Out for service"
            value={String(openServiceCount)}
            tone={openServiceCount > 0 ? 'accent' : undefined}
            meta={openServiceCount > 0 ? 'Needs work' : 'All clear'}
            metaTone={openServiceCount > 0 ? 'bad' : 'good'}
          />
        </DKpiStrip>

        <div className="d-split">
          <DataTable<AssetRow>
            title="By asset"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            empty="No equipment yet. Assets land here once inventory is added."
          />

          <div className="d-card">
            <div
              className="d-table-head"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <span className="d-table-head-title">Service log</span>
              {/* Opens a real inventory_service_ticket against a stocked asset
                  (POST /api/inventory/service-tickets). Disabled only while a
                  catalog is still loading or has no assets to log against. */}
              <MButton
                size="sm"
                variant="ghost"
                disabled={logItemOptions.length === 0}
                onClick={() => setLogOpen(true)}
              >
                + LOG
              </MButton>
            </div>
            {serviceLog.length === 0 ? (
              <div style={{ color: 'var(--m-ink-3)', fontSize: 14, marginTop: 12 }}>
                {serviceTicketsQuery.isPending
                  ? 'Loading service log…'
                  : 'No service entries yet. Flag an asset for service and it lands here.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                {serviceLog.map((entry) => {
                  const patching = patchTicket.isPending && patchTicket.variables?.id === entry.id
                  return (
                    <div
                      key={entry.id}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
                    >
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>{entry.date}</div>
                        <div style={{ fontWeight: 600 }}>{entry.item}</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {entry.status === 'open' ? (
                          <MButton
                            size="sm"
                            variant="ghost"
                            disabled={patching}
                            onClick={() => advanceTicket(entry.id, 'in_service')}
                          >
                            {patching ? '…' : 'Start'}
                          </MButton>
                        ) : null}
                        {entry.status !== 'done' ? (
                          <MButton
                            size="sm"
                            variant="ghost"
                            disabled={patching}
                            onClick={() => advanceTicket(entry.id, 'done')}
                          >
                            {patching ? '…' : 'Done'}
                          </MButton>
                        ) : null}
                        <MPill tone={SERVICE_STATUS_TONE[entry.status]} dot>
                          {SERVICE_STATUS_LABEL[entry.status]}
                        </MPill>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* + LOG — open a service ticket against a stocked asset. The ticket
          then walks open → in_service → done via the per-row controls. */}
      <DModal
        open={logOpen}
        onClose={() => setLogOpen(false)}
        title="Log service"
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <MButton variant="ghost" onClick={() => setLogOpen(false)}>
              Cancel
            </MButton>
            <MButton variant="primary" disabled={!logItemId || openTicket.isPending} onClick={handleLogSubmit}>
              {openTicket.isPending ? 'Logging…' : 'Open ticket'}
            </MButton>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600 }}>
            Asset
            <MSelect value={logItemId} onChange={(e) => setLogItemId(e.target.value)}>
              <option value="">Select an asset…</option>
              {logItemOptions.map((it) => (
                <option key={it.id} value={it.id}>
                  {[it.code, it.description].filter(Boolean).join(' · ')}
                </option>
              ))}
            </MSelect>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600 }}>
            Notes (optional)
            <MTextarea
              value={logNotes}
              onChange={(e) => setLogNotes(e.target.value)}
              rows={3}
              placeholder="What needs servicing?"
            />
          </label>
        </div>
        {openTicket.isError ? (
          <div style={{ marginTop: 12, fontSize: 13, color: 'var(--m-red)', fontWeight: 600 }}>
            {openTicket.error instanceof Error ? openTicket.error.message : 'Could not open service ticket.'}
          </div>
        ) : null}
      </DModal>
    </div>
  )
}
