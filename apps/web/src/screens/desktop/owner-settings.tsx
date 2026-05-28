/**
 * Owner desktop settings — the "pricing book" (Desktop v2 · Owner · Settings).
 * Reuses the service-item catalog hook that the mobile settings screen uses;
 * just a dense desktop composition. See docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 *
 * Only the Pricing tab is built — the other tabs (Loaded labor / Hours /
 * Integrations / Roles) render a short "in progress" note via local tab state.
 */
import { useMemo, useState } from 'react'
import { useServiceItems, type ServiceItem } from '@/lib/api/service-items'
import { DataTable, DEyebrow, DH1, DTabBar, type DColumn } from '@/components/d'
import { MButton, MPill } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

const TABS = [
  { key: 'pricing', label: 'Pricing' },
  { key: 'loaded-labor', label: 'Loaded labor' },
  { key: 'hours', label: 'Hours' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'roles', label: 'Roles' },
]

export function OwnerSettings() {
  const [active, setActive] = useState('pricing')
  const itemsQuery = useServiceItems()

  const rows = useMemo<ServiceItem[]>(() => itemsQuery.data?.serviceItems ?? [], [itemsQuery.data?.serviceItems])

  const columns: Array<DColumn<ServiceItem>> = [
    { key: 'name', header: 'Item', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    {
      key: 'category',
      header: 'Division / Category',
      render: (r) => <MPill>{r.category || '—'}</MPill>,
    },
    { key: 'unit', header: 'Unit', render: (r) => r.unit || '—' },
    {
      key: 'default_rate',
      header: 'Rate',
      numeric: true,
      render: (r) => (r.default_rate == null ? '—' : formatMoney(r.default_rate)),
    },
    {
      key: 'edit',
      header: '',
      render: () => (
        <MButton
          size="sm"
          variant="quiet"
          onClick={(e) => {
            e.stopPropagation()
            // TODO: wire to a pricing-item editor sheet (usePatchServiceItem).
          }}
        >
          Edit
        </MButton>
      ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Settings</DEyebrow>
          <DH1>Pricing book</DH1>
        </div>

        <DTabBar tabs={TABS} active={active} onSelect={setActive} />

        {active === 'pricing' ? (
          <DataTable<ServiceItem>
            title="Service items"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.code}
            empty="No service items yet. Items added to your catalog show up here with their billing rates."
          />
        ) : (
          <div className="d-card" style={{ color: 'var(--m-ink-3)' }}>
            <div className="d-eyebrow">{TABS.find((t) => t.key === active)?.label}</div>
            <div style={{ fontSize: 14, marginTop: 8 }}>This section is in progress.</div>
          </div>
        )}
      </div>
    </div>
  )
}
