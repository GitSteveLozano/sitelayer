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
import {
  MBody,
  MButton,
  MChip,
  MChipRow,
  MI,
  MKpi,
  MKpiRow,
  MListInset,
  MListRow,
  MSectionH,
  MTopBar,
} from '../../components/m/index.js'
import { MAiStripe } from '../../components/m/ai.js'
import { MBanner, MSkeletonList } from '../../components/m-states/index.js'
import { useInventoryUtilization } from '@/lib/api'
import { selectAvailabilityRows, selectAvailabilitySummary } from '@/lib/api/inventory-availability'
import { RentalsAvailabilitySection } from './rentals-availability-section.js'
import { RentalsForecastSection } from './rentals-forecast-section.js'
import { formatMoney } from './format.js'

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
            idleDailyValue={totals.total_idle_revenue_per_day_cents / 100}
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
  idleDailyValue,
  availabilityRows,
  onDispatch,
}: {
  utilizationPct: number
  idleDailyValue: number
  availabilityRows: ReturnType<typeof selectAvailabilityRows>
  onDispatch: () => void
}) {
  const idle = availabilityRows.filter((r) => r.available_quantity > 0)

  return (
    <>
      <div style={{ padding: '12px 16px 0' }}>
        <MKpiRow cols={2}>
          <MKpi
            label="Utilization"
            value={`${utilizationPct}%`}
            meta="of fleet deployed"
            metaTone={utilizationPct >= 70 ? 'green' : utilizationPct >= 40 ? 'amber' : 'red'}
          />
          <MKpi
            label="Idle revenue"
            value={formatMoney(idleDailyValue)}
            unit="/day"
            meta="leaving on the table"
            metaTone={idleDailyValue > 0 ? 'amber' : 'green'}
          />
        </MKpiRow>
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
      <MSectionH>Idle equipment</MSectionH>
      <MListInset>
        {idle.length === 0 ? (
          <MListRow headline="Everything's deployed" supporting="Nice — full fleet utilization." />
        ) : (
          idle
            .slice(0, 8)
            .map((r) => (
              <MListRow
                key={r.inventory_item_id}
                leading={<MI.Truck size={18} />}
                leadingTone="amber"
                headline={r.description}
                supporting={`${r.code} · ${r.available_quantity} ${r.unit || 'ea'} idle`}
                trailing={<span className="num">{formatMoney(r.idle_revenue_per_day)}/day</span>}
                chev
              />
            ))
        )}
      </MListInset>
    </>
  )
}
