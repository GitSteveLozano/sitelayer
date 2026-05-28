/**
 * Estimator desktop item library — the read surface over the service-item
 * catalog (Desktop v2 · Estimator · Item Library). Reuses the same
 * `useServiceItems` hook the owner pricing book uses; this is a denser,
 * estimator-facing composition with division/category filtering.
 * See docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 */
import { useMemo, useState } from 'react'
import { useServiceItems, type ServiceItem } from '@/lib/api/service-items'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MButton, MChip, MChipRow, MPill } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

const ALL = '__all__'

export function EstItemLibrary() {
  const itemsQuery = useServiceItems()
  const [filter, setFilter] = useState<string>(ALL)

  const items = useMemo<ServiceItem[]>(() => itemsQuery.data?.serviceItems ?? [], [itemsQuery.data?.serviceItems])

  const { categories, assemblies, divisions, avgRate } = useMemo(() => {
    const cats = new Set<string>()
    let assemblyCount = 0
    let rateSum = 0
    let rateCount = 0
    for (const item of items) {
      const cat = item.category?.trim()
      if (cat) cats.add(cat)
      if (item.source === 'assembly') assemblyCount += 1
      const rate = item.default_rate == null ? NaN : Number(item.default_rate)
      if (Number.isFinite(rate)) {
        rateSum += rate
        rateCount += 1
      }
    }
    return {
      categories: Array.from(cats).sort((a, b) => a.localeCompare(b)),
      assemblies: assemblyCount,
      divisions: cats.size,
      avgRate: rateCount > 0 ? rateSum / rateCount : null,
    }
  }, [items])

  const rows = useMemo<ServiceItem[]>(
    () => (filter === ALL ? items : items.filter((i) => (i.category?.trim() || '') === filter)),
    [items, filter],
  )

  const columns: Array<DColumn<ServiceItem>> = [
    { key: 'name', header: 'Item', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'code', header: 'Code', render: (r) => r.code },
    {
      key: 'category',
      header: 'Division / Category',
      render: (r) => <MPill>{r.category?.trim() || '—'}</MPill>,
    },
    { key: 'unit', header: 'Unit', render: (r) => r.unit || '—' },
    {
      key: 'default_rate',
      header: 'Rate',
      numeric: true,
      render: (r) => (r.default_rate == null ? '—' : formatMoney(r.default_rate)),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Estimator · Item Library</DEyebrow>
          <DH1>
            {items.length} {items.length === 1 ? 'item' : 'items'} in catalog
          </DH1>
        </div>

        <MChipRow>
          <MChip active={filter === ALL} onClick={() => setFilter(ALL)} count={items.length}>
            All
          </MChip>
          {categories.map((cat) => (
            <MChip
              key={cat}
              active={filter === cat}
              outline
              onClick={() => setFilter(cat)}
              count={items.filter((i) => (i.category?.trim() || '') === cat).length}
            >
              {cat}
            </MChip>
          ))}
        </MChipRow>

        <DKpiStrip>
          <DKpi label="Total items" value={String(items.length)} meta="In catalog" />
          <DKpi label="Assemblies" value={String(assemblies)} meta="Grouped items" />
          <DKpi label="Divisions" value={String(divisions)} tone="accent" meta="Categories" />
          <DKpi label="Avg rate" value={avgRate == null ? '—' : formatMoney(avgRate)} meta="Across priced items" />
        </DKpiStrip>

        <DataTable<ServiceItem>
          title="Catalog items"
          action={
            <MButton
              size="sm"
              variant="quiet"
              onClick={() => {
                // TODO: wire to a new-item editor sheet (useCreateServiceItem).
              }}
            >
              New item
            </MButton>
          }
          columns={columns}
          rows={rows}
          rowKey={(r) => r.code}
          empty="No items in your catalog yet. Service items added here are available to every estimate."
        />
      </div>
    </div>
  )
}
