/**
 * Rentals catalog — `rent-cat`. Inventory grid filtered by status, with
 * the "Scan tag" FAB. Each item card shows code, description, category,
 * status, daily rate.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CompanyRole } from '@sitelayer/domain'
import {
  fetchInventoryUtilizationSummary,
  listInventoryItems,
  type InventoryItem,
  type InventoryUtilizationSummary,
} from '@/lib/api'
import {
  MBody,
  MChip,
  MChipRow,
  MFab,
  MI,
  MInput,
  MKpi,
  MKpiRow,
  MListPlain,
  MListRow,
  MPill,
  MQuickAction,
  MQuickActionGrid,
  MSectionH,
  MStat,
  MStatStrip,
  MTopBar,
} from '../../components/m/index.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'
import { WorkRequestAction } from '../../components/work-requests/WorkRequestAction.js'
import { WorkRequestEntityStatus } from '../../components/work-requests/WorkRequestEntityStatus.js'
import { formatMoney } from './format.js'

type Filter = 'all' | 'out' | 'available' | 'service'

export function MobileRentals({ companySlug, companyRole }: { companySlug: string; companyRole: CompanyRole }) {
  const navigate = useNavigate()
  const [items, setItems] = useState<readonly InventoryItem[] | null>(null)
  const [utilization, setUtilization] = useState<InventoryUtilizationSummary | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showTopUtilized, setShowTopUtilized] = useState(false)

  useEffect(() => {
    let cancelled = false
    listInventoryItems(companySlug)
      .then((r) => {
        if (cancelled) return
        setItems(r.inventoryItems)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    // Fire the utilization rollup in parallel — its empty-state and the
    // catalog's empty-state can resolve independently, and the card stays
    // hidden until both numbers land.
    fetchInventoryUtilizationSummary(companySlug)
      .then((u) => {
        if (cancelled) return
        setUtilization(u)
      })
      .catch(() => {
        // Soft-fail: don't blow up the catalog if the rollup endpoint
        // is unavailable. The card simply won't render.
        if (cancelled) return
        setUtilization(null)
      })
    return () => {
      cancelled = true
    }
  }, [companySlug])

  // Without a /api/dispatch state join, "out" vs "available" comes from
  // the placeholder `active` flag. Tune once dispatch state is wired in.
  const counts = useMemo(() => {
    const arr = items?.filter((i) => !i.deleted_at) ?? []
    return {
      all: arr.length,
      out: arr.filter((i) => !i.active).length,
      available: arr.filter((i) => i.active).length,
      service: 0,
    }
  }, [items])

  const visible = useMemo(() => {
    const arr = items?.filter((i) => !i.deleted_at) ?? []
    const filtered =
      filter === 'all'
        ? arr
        : filter === 'out'
          ? arr.filter((i) => !i.active)
          : filter === 'available'
            ? arr.filter((i) => i.active)
            : []
    if (!query.trim()) return filtered
    const q = query.toLowerCase()
    return filtered.filter((i) => i.code.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
  }, [items, filter, query])

  // Items that are currently dispatched (active=false in our placeholder
  // model) earn their default rental rate per day. Once true dispatch
  // state lands, replace with the dispatched-item sum.
  const dailyRevenue = visible.filter((i) => !i.active).reduce((s, i) => s + Number(i.default_rental_rate ?? 0), 0)
  const utilizationPct = counts.all > 0 ? Math.round((counts.out / counts.all) * 100) : 0

  return (
    <>
      <MTopBar title="Rentals" sub={`My equipment · ${counts.all} active`} />
      <MBody>
        <div style={{ padding: '12px 16px 4px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'var(--m-card-soft)',
              borderRadius: 12,
              padding: '0 12px',
              height: 42,
            }}
          >
            <MI.Search size={18} style={{ color: 'var(--m-ink-3)' }} />
            {/* Outline governed by the global :focus-visible rule in m.css. */}
            <MInput
              type="search"
              placeholder="Search by tag or name"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                height: 'auto',
                padding: 0,
                fontSize: 15,
              }}
            />
          </div>
        </div>
        <MChipRow>
          <MChip active={filter === 'all'} onClick={() => setFilter('all')} count={counts.all}>
            All
          </MChip>
          <MChip active={filter === 'out'} onClick={() => setFilter('out')} count={counts.out}>
            Out
          </MChip>
          <MChip active={filter === 'available'} onClick={() => setFilter('available')} count={counts.available}>
            Available
          </MChip>
          <MChip outline onClick={() => setFilter('service')}>
            Service
          </MChip>
        </MChipRow>
        <MStatStrip>
          <MStat label="Out" value={String(counts.out)} />
          <MStat label="Daily revenue" value={formatMoney(dailyRevenue)} />
          <MStat label="Util" value={`${utilizationPct}%`} />
        </MStatStrip>
        <WorkRequestEntityStatus entityType="rental_catalog" entityId={companySlug} />
        <WorkRequestAction
          companyRole={companyRole}
          defaultTitle="Rental issue"
          category="rentals"
          route="/rentals"
          client={{
            source: 'rentals_mobile',
            page: {
              path: '/rentals',
              route: '/rentals',
              filter,
              query: query.trim() || null,
            },
            entity: {
              entity_type: 'rental_catalog',
              entity_id: companySlug,
            },
            state: {
              counts,
              visible_count: visible.length,
              daily_revenue: dailyRevenue,
              utilization_percent: utilizationPct,
            },
          }}
        />
        <UtilizationCard
          utilization={utilization}
          showTopUtilized={showTopUtilized}
          onToggleTopUtilized={() => setShowTopUtilized((s) => !s)}
        />
        <MSectionH>Rental yard</MSectionH>
        <MQuickActionGrid>
          <MQuickAction Icon={MI.Truck} label="Dispatch" onClick={() => navigate('/rentals/dispatch')} />
          <MQuickAction Icon={MI.Check} label="Return" onClick={() => navigate('/rentals/return')} />
          <MQuickAction Icon={MI.Camera} label="Scan" onClick={() => navigate('/rentals/scan')} />
          <MQuickAction Icon={MI.FileText} label="Portal" onClick={() => navigate('/rentals/portal')} />
          <MQuickAction Icon={MI.Layers} label="Billing runs" onClick={() => navigate('/rentals/billing')} />
          {/* Inbound portal rental requests awaiting owner approve/decline
              (RentalRequestsQueueScreen, route /rentals/requests). Without this
              entry the queue is only reachable from a notification deep-link —
              admin/office reach it here directly. */}
          {companyRole === 'admin' || companyRole === 'office' ? (
            <MQuickAction Icon={MI.Bell} label="Requests" onClick={() => navigate('/rentals/requests')} />
          ) : null}
        </MQuickActionGrid>
        <MSectionH>Assets</MSectionH>
        {error ? (
          <div style={{ padding: 24, color: 'var(--m-red)', fontSize: 13 }}>{error}</div>
        ) : items === null ? (
          <MSkeletonList count={4} />
        ) : visible.length === 0 ? (
          <MEmptyState
            title="No equipment"
            body="Add your first item to start tracking dispatch and utilization."
            primaryLabel="New item"
            onPrimary={() => navigate('/inventory')}
          />
        ) : (
          <div style={{ paddingBottom: 80 }}>
            <MListPlain>
              {visible.map((item) => (
                <ItemCard key={item.id} item={item} />
              ))}
            </MListPlain>
          </div>
        )}
        <MFab extended ariaLabel="Scan tag" onClick={() => navigate('/rentals/scan')}>
          <MI.Camera size={18} />
          Scan tag
        </MFab>
      </MBody>
    </>
  )
}

function ItemCard({ item }: { item: InventoryItem }) {
  const out = !item.active
  // Square monogram from the asset code prefix (e.g. "SCF-001" → "SCF").
  const monogram = (item.code.split(/[-\s]/)[0] || item.code).slice(0, 3).toUpperCase()
  return (
    <MListRow
      leading={monogram}
      leadingTone={out ? 'accent' : undefined}
      headline={item.description}
      supporting={`${item.code} · ${item.category} · $${item.default_rental_rate}/${item.unit || 'day'}`}
      badge={
        <MPill tone={out ? 'amber' : 'green'} dot>
          {out ? 'out' : 'in'}
        </MPill>
      }
    />
  )
}

/**
 * Deployment rollup card — answers the owner's "% of equipment currently
 * deployed" question at a glance. Sits above the dispatch / return action
 * grid so it is the first thing an admin / office user sees.
 *
 * Empty state ("Add inventory to track utilization.") fires when the
 * tenant has no inventory_items at all. While the rollup is still loading
 * the card renders nothing (the catalog skeleton already covers visual
 * stand-in needs).
 */
function UtilizationCard({
  utilization,
  showTopUtilized,
  onToggleTopUtilized,
}: {
  utilization: InventoryUtilizationSummary | null
  showTopUtilized: boolean
  onToggleTopUtilized: () => void
}) {
  if (utilization === null) return null

  const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
  const deployed = fmtQty(utilization.on_rent_count)
  const total = fmtQty(utilization.total_quantity_owned)
  const pct = Number.isInteger(utilization.utilization_pct)
    ? utilization.utilization_pct
    : Math.round(utilization.utilization_pct * 10) / 10
  const isEmpty = utilization.total_items === 0

  return (
    <div
      style={{
        margin: '12px 16px 4px',
        background: 'var(--m-card)',
        border: '1px solid var(--m-line)',
        borderRadius: 12,
        padding: '14px 14px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <MPill tone="accent" dot>
          Utilization
        </MPill>
        {!isEmpty && utilization.top_utilized.length > 0 ? (
          <button
            type="button"
            onClick={onToggleTopUtilized}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--m-ink-3)',
              fontSize: 12,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {showTopUtilized ? 'Hide top' : 'Top items'}
          </button>
        ) : null}
      </div>

      {isEmpty ? (
        <div className="m-quiet-sm" style={{ paddingTop: 2 }}>
          Add inventory to track utilization.
        </div>
      ) : (
        <>
          <MKpiRow cols={2}>
            <MKpi label="Total" value={fmtQty(utilization.total_quantity_owned)} />
            <MKpi label="On rent" value={fmtQty(utilization.on_rent_count)} />
            <MKpi label="Available" value={fmtQty(utilization.in_yard_count)} />
            <MKpi label="Service" value={fmtQty(utilization.out_for_service_count)} />
          </MKpiRow>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, paddingTop: 4 }}>
            <span className="num" style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.01em' }}>
              {pct}%
            </span>
            <span className="m-quiet-sm">utilization</span>
          </div>
          <div className="m-quiet-sm">
            {deployed} item{deployed === '1' ? '' : 's'} deployed of {total} total
          </div>
          {showTopUtilized && utilization.top_utilized.length > 0 ? (
            <div
              style={{
                marginTop: 4,
                borderTop: '1px solid var(--m-line)',
                paddingTop: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div className="m-quiet-sm" style={{ fontWeight: 600 }}>
                Top utilized
              </div>
              {utilization.top_utilized.map((row) => (
                <div
                  key={row.inventory_item_id}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}
                >
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.code} · {row.name}
                  </span>
                  <span className="num">{row.utilization_pct}%</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
