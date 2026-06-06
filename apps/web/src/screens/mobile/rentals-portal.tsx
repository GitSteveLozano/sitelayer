/**
 * Mobile customer rental portal preview. This is the in-app operator
 * route for the handoff's `rentals-portal` surface; external-domain
 * deployment can reuse the same content later without the app chrome.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listInventoryItems, type InventoryItem } from '@/lib/api'
import { MBody, MButton, MI, MListInset, MListRow, MPill, MSectionH, MTopBar } from '../../components/m/index.js'
import { MSkeletonList } from '../../components/m-states/index.js'
import { formatMoney } from './format.js'

export function MobileRentalsPortal({ companySlug }: { companySlug: string }) {
  const navigate = useNavigate()
  const [items, setItems] = useState<readonly InventoryItem[] | null>(null)

  useEffect(() => {
    let cancelled = false
    listInventoryItems(companySlug)
      .then((r) => {
        if (!cancelled) setItems(r.inventoryItems.filter((i) => i.active && !i.deleted_at))
      })
      .catch(() => {
        if (!cancelled) setItems([])
      })
    return () => {
      cancelled = true
    }
  }, [companySlug])

  return (
    <>
      <MTopBar back title="Customer portal" sub="Rental catalog" onBack={() => navigate('/rentals')} />
      <MBody>
        <div style={{ padding: '16px 20px 14px', borderBottom: '1px solid var(--m-line)' }}>
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.05 }}>
            Book job-site equipment
          </div>
          <div style={{ color: 'var(--m-ink-3)', fontSize: 14, marginTop: 6 }}>
            Available inventory, daily rates, and request-to-reserve flow.
          </div>
          <div style={{ marginTop: 12 }}>
            <MButton variant="primary" onClick={() => navigate('/rentals/dispatch')}>
              Reserve from operator app
            </MButton>
          </div>
        </div>
        <MSectionH>Available now</MSectionH>
        {items === null ? (
          <MSkeletonList count={5} />
        ) : (
          <MListInset>
            {items.slice(0, 12).map((item) => (
              <MListRow
                key={item.id}
                leading={<MI.Truck size={18} />}
                leadingTone="green"
                headline={item.description}
                supporting={`${item.category} · ${item.code}`}
                trailing={
                  <>
                    <span className="num">
                      {formatMoney(Number(item.default_rental_rate))}/{item.unit || 'day'}
                    </span>
                    <MPill tone="green">in</MPill>
                  </>
                }
              />
            ))}
            {items.length === 0 ? (
              <MListRow headline="No public inventory" supporting="Add active rental items first." />
            ) : null}
          </MListInset>
        )}
      </MBody>
    </>
  )
}
