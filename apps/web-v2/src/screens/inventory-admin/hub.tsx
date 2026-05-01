import { Link } from 'react-router-dom'
import { Card } from '@/components/mobile'
import { useInventoryItems, useInventoryLocations } from '@/lib/api'

const ENTRIES: ReadonlyArray<{ to: string; label: string; detail: string }> = [
  { to: 'items', label: 'Items', detail: 'Catalog of rentable assets — code, rate, replacement value.' },
  { to: 'locations', label: 'Locations', detail: 'Yards, vendor pickup points, project-tied storage.' },
  { to: 'movements', label: 'Movements', detail: 'Deliver / return / transfer ledger.' },
]

export function InventoryAdminHubScreen() {
  const items = useInventoryItems()
  const locations = useInventoryLocations()

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more" className="text-[12px] text-ink-3">
        ← More
      </Link>
      <h1 className="mt-2 font-display text-[26px] font-bold tracking-tight leading-tight">Inventory admin</h1>
      <p className="text-[12px] text-ink-3 mt-1">
        {items.data?.inventoryItems.length ?? 0} items · {locations.data?.inventoryLocations.length ?? 0} locations
      </p>
      <p className="text-[12px] text-ink-3 mt-1">
        Day-to-day rental dispatch lives in the Rentals tab. This is the configuration side.
      </p>

      <div className="mt-6 space-y-3">
        {ENTRIES.map((e) => (
          <Link key={e.to} to={e.to} className="block">
            <Card>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold">{e.label}</div>
                  <div className="text-[12px] text-ink-3 mt-0.5">{e.detail}</div>
                </div>
                <span className="text-ink-4" aria-hidden="true">
                  ›
                </span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
