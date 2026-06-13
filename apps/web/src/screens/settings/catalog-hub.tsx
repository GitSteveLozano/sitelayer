import { useNavigate } from 'react-router-dom'
import { MBody, MListPlain, MListRow, MTopBar } from '@/components/m'

/**
 * Catalog hub — mobile-first index of the six reference-data
 * surfaces ported from v1 (Phase 6, Batch 2). Lives at /more/catalog.
 *
 * Each row links to a dedicated CRUD screen using the same
 * `components/m` primitives (MListRow / `.m-sheet` / MButton / MPill)
 * as the rest of v2 — no data tables, no desktop-style grids.
 */
const ENTRIES: ReadonlyArray<{ to: string; label: string; detail: string }> = [
  { to: 'customers', label: 'Customers', detail: 'Per-company customer roster (QBO-linked).' },
  { to: 'workers', label: 'Workers', detail: 'Crew roster — name, role, default division.' },
  { to: 'service-items', label: 'Service items', detail: 'Code-keyed catalog of billable scope items.' },
  { to: 'pricing-profiles', label: 'Pricing profiles', detail: 'Labor rate config per division.' },
  { to: 'bonus-rules', label: 'Bonus rules', detail: 'Tier schedule for crew bonus payouts.' },
  { to: 'divisions', label: 'Divisions', detail: 'Read-only seed data; configured at company setup.' },
]

export function CatalogHubScreen() {
  const navigate = useNavigate()
  return (
    <>
      <MTopBar back eyebrow="Settings" title="Catalog" onBack={() => navigate('/more')} />
      <MBody>
        <p className="m-quiet-sm" style={{ padding: '14px 16px 4px', margin: 0 }}>
          Reference data — every list backs a project, an estimate, or a bonus calc.
        </p>
        <MListPlain>
          {ENTRIES.map((e) => (
            <MListRow key={e.to} headline={e.label} supporting={e.detail} chev onTap={() => navigate(e.to)} />
          ))}
        </MListPlain>
      </MBody>
    </>
  )
}
