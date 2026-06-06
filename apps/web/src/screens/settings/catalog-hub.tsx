import { Link } from 'react-router-dom'
import { Card } from '@/components/mobile'

/**
 * Catalog hub — mobile-first index of the six reference-data
 * surfaces ported from v1 (Phase 6, Batch 2). Lives at /more/catalog.
 *
 * Each card links to a dedicated CRUD screen using the same
 * mobile primitives (Card / Sheet / MobileButton / Pill) as the
 * rest of v2 — no data tables, no desktop-style grids.
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
  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more" className="text-[12px] text-ink-3">
        ← More
      </Link>
      <h1 className="mt-2 font-display text-[26px] font-bold tracking-tight leading-tight">Catalog</h1>
      <p className="text-[12px] text-ink-3 mt-1">
        Reference data — every list backs a project, an estimate, or a bonus calc.
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
