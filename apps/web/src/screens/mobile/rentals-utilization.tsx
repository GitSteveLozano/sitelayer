/**
 * Rental utilization — `rent-util`. Compact monetization view: high-idle
 * items, dollars/day idle, AI suggestion stripe to redeploy.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listInventoryItems, type InventoryItemRow } from '../../api-v1-compat.js'
import {
  MBody,
  MButton,
  MI,
  MKpi,
  MKpiRow,
  MListInset,
  MListRow,
  MSectionH,
  MTopBar,
} from '../../components/m/index.js'
import { MAiStripe } from '../../components/m/ai.js'
import { MSkeletonList } from '../../components/m-states/index.js'
import { formatMoney } from './format.js'

export function MobileRentalsUtilization({ companySlug }: { companySlug: string }) {
  const navigate = useNavigate()
  const [items, setItems] = useState<readonly InventoryItemRow[] | null>(null)

  useEffect(() => {
    listInventoryItems(companySlug)
      .then((r) => setItems(r.inventoryItems.filter((i) => !i.deleted_at)))
      .catch(() => setItems([]))
  }, [companySlug])

  if (items === null) {
    return (
      <>
        <MTopBar back title="Utilization" onBack={() => navigate('/rentals')} />
        <MBody>
          <MSkeletonList count={5} />
        </MBody>
      </>
    )
  }

  const idle = items.filter((i) => i.active)
  const idleDailyValue = idle.reduce((s, i) => s + Number(i.default_rental_rate ?? 0), 0)
  const utilizationPct = items.length > 0 ? Math.round(((items.length - idle.length) / items.length) * 100) : 0

  return (
    <>
      <MTopBar back title="Utilization" onBack={() => navigate('/rentals')} />
      <MBody>
        <div style={{ padding: '0 16px' }}>
          <MKpiRow cols={2}>
            <MKpi
              label="Utilization"
              value={`${utilizationPct}%`}
              meta="of fleet active"
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
                <MButton variant="ghost" size="sm" onClick={() => navigate('/rentals/dispatch')}>
                  Dispatch
                </MButton>
              }
            >
              Two active projects could absorb this — open dispatch to assign.
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
              .map((i) => (
                <MListRow
                  key={i.id}
                  leading={<MI.Truck size={18} />}
                  leadingTone="amber"
                  headline={i.description}
                  supporting={`${i.code} · $${i.default_rental_rate}/${i.unit || 'day'}`}
                  trailing={<span className="num">$0/day</span>}
                  chev
                />
              ))
          )}
        </MListInset>
      </MBody>
    </>
  )
}
