import { Link } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { useDivisions } from '@/lib/api'

/**
 * Divisions are seeded at company creation and not currently
 * editable via the UI — `/api/divisions` is GET-only. This screen
 * shows the active set so an admin can verify what was provisioned.
 */
export function CatalogDivisionsScreen() {
  const divisions = useDivisions()

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more/catalog" className="text-[12px] text-ink-3">
        ← Catalog
      </Link>
      <h1 className="mt-2 font-display text-[24px] font-bold tracking-tight leading-tight">Divisions</h1>
      <p className="text-[12px] text-ink-3 mt-1">
        Read-only seed data — configured at company setup. Adjust via the onboarding wizard or by engineering for now.
      </p>

      <div className="mt-6 space-y-2">
        {divisions.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : (divisions.data?.divisions ?? []).length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No divisions configured.</div>
          </Card>
        ) : (
          divisions.data?.divisions.map((d) => (
            <Card key={d.code} tight>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold truncate">{d.name}</div>
                  <div className="text-[11px] text-ink-3 mt-0.5 font-mono">{d.code}</div>
                </div>
                <Pill tone="default">#{d.sort_order}</Pill>
              </div>
            </Card>
          ))
        )}
        <div className="pt-2">
          <Attribution source="GET /api/divisions" />
        </div>
      </div>
    </div>
  )
}
