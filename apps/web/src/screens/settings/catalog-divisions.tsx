import { useNavigate } from 'react-router-dom'
import { MBody, MListPlain, MListRow, MPill, MTopBar } from '@/components/m'
import { Attribution } from '@/components/ai'
import { useDivisions } from '@/lib/api'

/**
 * Divisions are seeded at company creation and not currently
 * editable via the UI — `/api/divisions` is GET-only. This screen
 * shows the active set so an admin can verify what was provisioned.
 */
export function CatalogDivisionsScreen() {
  const divisions = useDivisions()
  const navigate = useNavigate()

  return (
    <>
      <MTopBar back eyebrow="Settings" title="Divisions" onBack={() => navigate('/more/catalog')} />
      <MBody>
        <p className="m-quiet-sm" style={{ padding: '14px 16px 4px', margin: 0 }}>
          Read-only seed data — configured at company setup. Adjust via the onboarding wizard or by engineering for now.
        </p>
        {divisions.isPending ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            Loading…
          </div>
        ) : (divisions.data?.divisions ?? []).length === 0 ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            No divisions configured.
          </div>
        ) : (
          <MListPlain>
            {divisions.data?.divisions.map((d) => (
              <MListRow
                key={d.code}
                headline={d.name}
                supporting={<span style={{ fontFamily: 'var(--m-num)' }}>{d.code}</span>}
                trailing={<MPill>#{d.sort_order}</MPill>}
              />
            ))}
          </MListPlain>
        )}
        <div style={{ padding: '8px 16px 0' }}>
          <Attribution source="GET /api/divisions" />
        </div>
      </MBody>
    </>
  )
}
