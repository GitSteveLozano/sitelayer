/**
 * Rentals dashboard — `rent-util`. A small tabbed KPI dashboard for the
 * owner/dispatcher persona:
 *
 *   - Utilization — high-idle items, dollars/day idle, redeploy stripe
 *     (the original monetization view).
 *   - Availability — current on-rent vs in-stock per item.
 *   - Forecast — projected on-rent / idle demand over the next 6 weeks.
 *
 * All three tabs share the single /api/inventory/utilization query
 * (Forecast adds a per-item /forecast call when a chip is selected), so
 * switching tabs never refetches the headline data.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBody, MButton, MChip, MChipRow, MListInset, MListRow, MTopBar } from '../../components/m/index.js'
import { MAiStripe } from '../../components/m/ai.js'
import { MBanner, MSkeletonList } from '../../components/m-states/index.js'
import { useInventoryUtilization } from '@/lib/api'
import { selectAvailabilityRows, selectAvailabilitySummary } from '@/lib/api/inventory-availability'
import { RentalsAvailabilitySection } from './rentals-availability-section.js'
import { RentalsForecastSection } from './rentals-forecast-section.js'
import { formatMoney, formatMoneyCompact } from './format.js'

type Tab = 'utilization' | 'availability' | 'forecast'

export function MobileRentalsUtilization({ companySlug: _companySlug }: { companySlug: string }) {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('utilization')
  const util = useInventoryUtilization()

  if (util.isLoading) {
    return (
      <>
        <MTopBar back title="Rentals" onBack={() => navigate('/rentals')} />
        <MBody>
          <MSkeletonList count={5} />
        </MBody>
      </>
    )
  }

  if (util.isError || !util.data) {
    return (
      <>
        <MTopBar back title="Rentals" onBack={() => navigate('/rentals')} />
        <MBody>
          <div style={{ padding: '12px 16px' }}>
            <MBanner
              tone="error"
              title="Couldn't load inventory"
              body="The utilization rollup didn't come back. Pull to retry."
            />
          </div>
        </MBody>
      </>
    )
  }

  const { items, totals } = util.data
  const availabilityRows = selectAvailabilityRows(items)
  const availabilitySummary = selectAvailabilitySummary(availabilityRows, totals)

  return (
    <>
      <MTopBar back title="Rentals" onBack={() => navigate('/rentals')} />
      <MBody>
        <div style={{ padding: '8px 16px 0' }}>
          <MChipRow>
            <MChip active={tab === 'utilization'} onClick={() => setTab('utilization')}>
              Utilization
            </MChip>
            <MChip active={tab === 'availability'} onClick={() => setTab('availability')}>
              Availability
            </MChip>
            <MChip active={tab === 'forecast'} onClick={() => setTab('forecast')}>
              Forecast
            </MChip>
          </MChipRow>
        </div>

        {tab === 'utilization' ? (
          <UtilizationTab
            utilizationPct={totals.utilization_pct}
            availabilityRows={availabilityRows}
            onDispatch={() => navigate('/rentals/dispatch')}
          />
        ) : null}

        {tab === 'availability' ? (
          <RentalsAvailabilitySection rows={availabilityRows} summary={availabilitySummary} />
        ) : null}

        {tab === 'forecast' ? <RentalsForecastSection items={availabilityRows} /> : null}
      </MBody>
    </>
  )
}

/**
 * The original monetization view, now reading the real utilization
 * rollup instead of a client-side guess. "Idle" items are the ones with
 * units in stock (available_quantity > 0) — those are leaving money on
 * the table.
 */
function UtilizationTab({
  utilizationPct,
  availabilityRows,
  onDispatch,
}: {
  utilizationPct: number
  availabilityRows: ReturnType<typeof selectAvailabilityRows>
  onDispatch: () => void
}) {
  const idle = availabilityRows.filter((r) => r.available_quantity > 0)
  const fleetTone = utilizationPct >= 70 ? 'var(--m-green)' : utilizationPct >= 40 ? 'var(--m-amber)' : 'var(--m-red)'
  // Fleet revenue/day (on-rent units × day rate) drives the headline meta
  // line "$X REVENUE · N ASSETS · 30 DAYS" (msg__74). There is no YTD
  // revenue field, so we project the current on-rent daily run-rate over a
  // 30-day window — the closest cumulative-revenue proxy the data supports.
  const PERIOD_DAYS = 30
  const fleetRevenuePerDay = availabilityRows.reduce((s, r) => s + r.on_rent_revenue_per_day, 0)
  const fleetPeriodRevenue = fleetRevenuePerDay * PERIOD_DAYS
  // Per-asset utilization = on-rent share of total units for the item.
  const assetRows = availabilityRows.map((r) => {
    const total = r.available_quantity + r.on_rent_quantity
    const pct = total > 0 ? Math.round((r.on_rent_quantity / total) * 100) : 0
    const flag = pct < 30
    const periodRevenue = r.on_rent_revenue_per_day * PERIOD_DAYS
    return { row: r, pct, flag, periodRevenue }
  })

  return (
    <>
      {/* FLEET AVG big-number hero — display-font headline + mono meta. */}
      <div style={{ padding: '24px 20px', borderBottom: '2px solid var(--m-ink)' }}>
        <div className="m-kpi-eyebrow">Fleet avg</div>
        <div
          style={{
            fontFamily: 'var(--m-font-display)',
            fontSize: 72,
            fontWeight: 800,
            lineHeight: 1,
            letterSpacing: '-0.02em',
            marginTop: 8,
            color: fleetTone,
          }}
        >
          {utilizationPct}
          <span style={{ color: 'var(--m-ink-4)' }}>%</span>
        </div>
        <div
          className="num"
          style={{ marginTop: 10, color: 'var(--m-ink-3)', fontWeight: 600, letterSpacing: '0.04em' }}
        >
          {formatMoneyCompact(fleetPeriodRevenue).value}
          {formatMoneyCompact(fleetPeriodRevenue).unit} REVENUE · {assetRows.length}{' '}
          {assetRows.length === 1 ? 'ASSET' : 'ASSETS'} · {PERIOD_DAYS} DAYS
        </div>
      </div>

      {idle.length > 0 ? (
        <div style={{ padding: '12px 16px 0' }}>
          <MAiStripe
            eyebrow="Monetize"
            title={`${idle.length} idle ${idle.length === 1 ? 'item' : 'items'} could be earning`}
            attribution={
              <>
                Based on <strong>fleet activity</strong>.
              </>
            }
            action={
              <MButton variant="ghost" size="sm" onClick={onDispatch}>
                Dispatch
              </MButton>
            }
          >
            Open dispatch to assign idle units to an active project.
          </MAiStripe>
        </div>
      ) : null}

      <div className="m-section-bar">
        <span>BY ASSET</span>
        <span>{assetRows.length}</span>
      </div>

      {assetRows.length === 0 ? (
        <MListInset>
          <MListRow headline="No assets yet" supporting="Add inventory to see utilization." />
        </MListInset>
      ) : (
        assetRows.map(({ row: r, pct, flag, periodRevenue }) => (
          <div key={r.inventory_item_id} style={{ padding: '14px 20px', borderBottom: '1px solid var(--m-line-2)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 14 }}>{r.description}</div>
              <div
                className="num"
                style={{ fontSize: 12, fontWeight: 800, color: flag ? 'var(--m-red)' : 'var(--m-ink)' }}
              >
                {pct}%
              </div>
            </div>
            <div className="m-progress" data-state={flag ? 'risk' : undefined} style={{ height: 6, marginTop: 8 }}>
              <div className="m-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            {/* Cumulative revenue beneath the bar (msg__74); the idle-rate
                framing drops to a secondary caption only when underutilized. */}
            <div
              className="num"
              style={{ fontSize: 12, color: 'var(--m-ink)', marginTop: 6, fontWeight: 700, letterSpacing: '0.02em' }}
            >
              {formatMoney(periodRevenue)}
            </div>
            {flag ? (
              <div
                className="num"
                style={{ fontSize: 10, color: 'var(--m-red)', marginTop: 3, fontWeight: 600, letterSpacing: '0.04em' }}
              >
                {r.code} · {formatMoney(r.idle_revenue_per_day)}/DAY IDLE · UNDERUTILIZED
              </div>
            ) : (
              <div
                className="num"
                style={{
                  fontSize: 10,
                  color: 'var(--m-ink-4)',
                  marginTop: 3,
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                }}
              >
                {r.code}
              </div>
            )}
          </div>
        ))
      )}
    </>
  )
}
