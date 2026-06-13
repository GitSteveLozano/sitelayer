/**
 * Rentals · Service log — `rent-service`. Maintenance / service history for
 * the rental yard (or a single asset when `:assetId` is present). Mirrors
 * Steve's v2 brutalist `V2RentService`: square borders, mono micro-labels,
 * a two-up KPI strip, a "LOG SERVICE" primary action that opens an inline
 * form, and a full-bleed list of past service entries.
 *
 * DURABLE: entries are inventory_service_tickets rows via the real API
 * (`/api/inventory/service-tickets`, routes/inventory-service-tickets.ts) —
 * the same backend the desktop owner rentals screens use. `service_type` and
 * `cost_cents` (migration 019) make the design's headline SPENT·YTD KPI a
 * real sum over this year's recorded costs, never a fabricated figure.
 * (This file previously held entries in component state behind a stale TODO
 * claiming "no API yet" — audit M10 #9.)
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useInventoryItems, type InventoryItem } from '@/lib/api/rentals'
import { useOpenServiceTicket, useServiceTickets, type ServiceTicket } from '@/lib/api/inventory-service-tickets'
import {
  MBody,
  MButton,
  MI,
  MInput,
  MKpi,
  MKpiRow,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MSelect,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'
import { formatMoney } from './format.js'

export function MobileRentalsService() {
  const navigate = useNavigate()
  // `:assetId` is optional — the screen doubles as a yard-wide log and a
  // per-asset log depending on the mounted route.
  const { assetId } = useParams<{ assetId?: string }>()
  const { data, isLoading, isError } = useInventoryItems()

  // Durable service tickets, scoped to the asset when one is in the route.
  const ticketsQuery = useServiceTickets(assetId ? { itemId: assetId } : {})
  const tickets = useMemo<ServiceTicket[]>(() => ticketsQuery.data?.service_tickets ?? [], [ticketsQuery.data])

  const openTicket = useOpenServiceTicket()
  const [showForm, setShowForm] = useState(false)
  const [formType, setFormType] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [formCost, setFormCost] = useState('')
  // Yard-wide mode has no :assetId — the form needs an explicit asset pick.
  const [formItemId, setFormItemId] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const items = useMemo<InventoryItem[]>(
    () => (data?.inventoryItems ?? []).filter((i) => !i.deleted_at),
    [data?.inventoryItems],
  )
  const asset: InventoryItem | undefined = useMemo(() => {
    if (!assetId) return undefined
    return items.find((i) => i.id === assetId)
  }, [items, assetId])
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])

  const openCount = tickets.filter((t) => t.status !== 'done').length

  // Real maintenance spend this calendar year — the design's "SPENT · YTD"
  // headline KPI, summed from recorded ticket costs (cost_cents, migration
  // 019). Tickets without a recorded cost contribute nothing.
  const spentYtd = useMemo(() => {
    const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime()
    return (
      tickets.reduce((sum, t) => {
        const openedAt = new Date(t.opened_at).getTime()
        if (Number.isNaN(openedAt) || openedAt < yearStart) return sum
        return sum + (t.cost_cents ?? 0)
      }, 0) / 100
    )
  }, [tickets])

  const targetItemId = assetId ?? formItemId

  const submit = async () => {
    if (!formType.trim() || !targetItemId || openTicket.isPending) return
    setFormError(null)
    const dollars = formCost.trim() === '' ? null : Number(formCost)
    if (dollars != null && (!Number.isFinite(dollars) || dollars < 0)) {
      setFormError('Cost must be a non-negative number.')
      return
    }
    try {
      await openTicket.mutateAsync({
        inventory_item_id: targetItemId,
        service_type: formType.trim(),
        notes: formNotes.trim() || null,
        cost_cents: dollars == null ? null : Math.round(dollars * 100),
      })
      setFormType('')
      setFormNotes('')
      setFormCost('')
      setFormItemId('')
      setShowForm(false)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save the service entry.')
    }
  }

  const loading = isLoading || ticketsQuery.isLoading

  return (
    <>
      <MTopBar
        back
        eyebrow={asset ? asset.code : 'Inventory'}
        title="Service log"
        sub={asset ? asset.description : 'Maintenance history'}
        onBack={() => navigate(-1)}
      />
      <MBody>
        {/* KPI strip — two-up OPEN count + SPENT · YTD (Steve v2 msg__75). */}
        <MKpiRow cols={2}>
          <MKpi label="Open" value={String(openCount)} metaTone={openCount > 0 ? 'red' : undefined} />
          <MKpi label="Spent · YTD" value={formatMoney(spentYtd)} />
        </MKpiRow>

        <div style={{ padding: '4px 16px 8px' }}>
          <MButton variant="primary" onClick={() => setShowForm((s) => !s)} style={{ width: '100%' }}>
            <MI.Plus size={16} /> Log service
          </MButton>
        </div>

        {showForm ? (
          <div
            style={{
              margin: '0 16px 12px',
              border: '1px solid var(--m-line)',
              background: 'var(--m-card)',
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {!assetId ? (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="m-kpi-eyebrow">Asset</span>
                <MSelect value={formItemId} onChange={(e) => setFormItemId(e.currentTarget.value)}>
                  <option value="">Pick an asset…</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.code} · {i.description}
                    </option>
                  ))}
                </MSelect>
              </label>
            ) : null}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="m-kpi-eyebrow">Type</span>
              <MInput
                type="text"
                placeholder="e.g. Oil change, nozzle replaced"
                value={formType}
                onChange={(e) => setFormType(e.currentTarget.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="m-kpi-eyebrow">Notes</span>
              <MTextarea
                rows={3}
                placeholder="What was done"
                value={formNotes}
                onChange={(e) => setFormNotes(e.currentTarget.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="m-kpi-eyebrow">Cost</span>
              <MInput
                type="number"
                inputMode="decimal"
                min="0"
                placeholder="e.g. 120"
                value={formCost}
                onChange={(e) => setFormCost(e.currentTarget.value)}
              />
            </label>
            {formError ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{formError}</div> : null}
            <div style={{ display: 'flex', gap: 8 }}>
              <MButton
                variant="primary"
                onClick={() => void submit()}
                disabled={!formType.trim() || !targetItemId || openTicket.isPending}
                style={{ flex: 1 }}
              >
                {openTicket.isPending ? 'Saving…' : 'Save entry'}
              </MButton>
              <MButton variant="ghost" onClick={() => setShowForm(false)} disabled={openTicket.isPending}>
                Cancel
              </MButton>
            </div>
          </div>
        ) : null}

        <MSectionH>History{openCount > 0 ? ` · ${openCount} open` : ''}</MSectionH>

        {loading ? (
          <MSkeletonList count={3} />
        ) : isError || ticketsQuery.isError ? (
          <div style={{ padding: 24, color: 'var(--m-red)', fontSize: 13 }}>Could not load the service log.</div>
        ) : tickets.length === 0 ? (
          <MEmptyState
            title="No service logged"
            body="Maintenance, inspections, and repairs will appear here once logged. Tap Log service to add the first entry."
            primaryLabel="Log service"
            onPrimary={() => setShowForm(true)}
          />
        ) : (
          <div style={{ paddingBottom: 40 }}>
            <MListInset>
              {tickets.map((t) => {
                const open = t.status !== 'done'
                const item = itemById.get(t.inventory_item_id)
                const headline = t.service_type?.trim() || 'Service'
                const supporting = [
                  // Yard-wide mode shows which asset the ticket is against.
                  !assetId && item ? item.code : null,
                  t.notes || null,
                ]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <MListRow
                    key={t.id}
                    leading={fmtDate(t.opened_at)}
                    leadingTone={open ? 'red' : 'green'}
                    headline={headline}
                    supporting={supporting || undefined}
                    trailing={
                      t.cost_cents != null && t.cost_cents > 0 ? (
                        <span className="num" style={{ fontWeight: 700, fontSize: 13 }}>
                          {formatMoney(t.cost_cents / 100)}
                        </span>
                      ) : undefined
                    }
                    badge={
                      <MPill tone={open ? 'red' : 'green'} dot>
                        {t.status === 'in_service' ? 'in service' : t.status}
                      </MPill>
                    }
                  />
                )
              })}
            </MListInset>
          </div>
        )}
      </MBody>
    </>
  )
}

/** Compact mono date for the leading column (e.g. "5/24") from an ISO timestamp. */
function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.valueOf())) return iso.slice(5, 10)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
