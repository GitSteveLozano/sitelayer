import { useNavigate } from 'react-router-dom'
import { MBody, MListPlain, MListRow, MTopBar } from '@/components/m'
import { useActiveCompanyModules, useInventoryItems, useInventoryLocations } from '@/lib/api'
import type { CompanyModules } from '@/lib/api'

type Entry = {
  to: string
  label: string
  detail: string
  /** Module flag the entry requires; omitted entries are always visible. */
  requires?: keyof CompanyModules
}

const ENTRIES: ReadonlyArray<Entry> = [
  { to: 'items', label: 'Items', detail: 'Catalog of rentable assets — code, rate, replacement value.' },
  { to: 'locations', label: 'Locations', detail: 'Yards, vendor pickup points, project-tied storage.' },
  { to: 'branches', label: 'Branches', detail: 'Branch / yard / staging hierarchy locations roll up into.' },
  { to: 'movements', label: 'Movements', detail: 'Deliver / return / transfer ledger.' },
  {
    to: 'scaffold-catalog',
    label: 'Scaffold catalog',
    detail: 'Manufacturers, systems, and per-part scaffold catalog.',
    requires: 'scaffold_bom',
  },
  {
    to: '/scaffold-designer',
    label: 'Scaffold designer',
    detail: 'Model bays × lifts → 3D scaffold + auto bill of materials.',
    requires: 'scaffold_bom',
  },
  {
    to: 'damage-charges',
    label: 'Damage charges',
    detail: 'Per-project damage / loss / late-return queue.',
    requires: 'rental_ops',
  },
]

export function InventoryAdminHubScreen() {
  const items = useInventoryItems()
  const locations = useInventoryLocations()
  const moduleFlags = useActiveCompanyModules()?.modules
  const navigate = useNavigate()

  const visibleEntries = ENTRIES.filter((e) => {
    if (!e.requires) return true
    // While modules are still loading, default to visible so admins don't
    // see a flickering empty hub. The route is hard-gated server-side via
    // requireRole + module-aware UI gates layered below as needed.
    if (!moduleFlags) return true
    return moduleFlags[e.requires]
  })

  return (
    <>
      <MTopBar
        back
        eyebrow="Settings"
        title="Inventory admin"
        sub={`${items.data?.inventoryItems.length ?? 0} items · ${locations.data?.inventoryLocations.length ?? 0} locations`}
        onBack={() => navigate('/more')}
      />
      <MBody>
        <p className="m-quiet-sm" style={{ padding: '14px 16px 4px', margin: 0 }}>
          Day-to-day rental dispatch lives in the Rentals tab. This is the configuration side.
        </p>
        <MListPlain>
          {visibleEntries.map((e) => (
            <MListRow key={e.to} headline={e.label} supporting={e.detail} chev onTap={() => navigate(e.to)} />
          ))}
        </MListPlain>
      </MBody>
    </>
  )
}
