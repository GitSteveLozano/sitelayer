/**
 * Rentals catalog — `rent-cat`. Inventory grid filtered by status, with
 * the "Scan tag" FAB. Each item card shows code, description, category,
 * status, daily rate.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listInventoryItems, type InventoryItemRow } from '../../api-v1-compat.js'
import {
  MBody,
  MChip,
  MChipRow,
  MFab,
  MI,
  MInput,
  MPill,
  MStat,
  MStatStrip,
  MTopBar,
} from '../../components/m/index.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'
import { formatMoney } from './format.js'

type Filter = 'all' | 'out' | 'available' | 'service'

export function MobileRentals({ companySlug }: { companySlug: string }) {
  const navigate = useNavigate()
  const [items, setItems] = useState<readonly InventoryItemRow[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listInventoryItems(companySlug)
      .then((r) => {
        if (cancelled) return
        setItems(r.inventoryItems)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [companySlug])

  // Without a /api/dispatch state join, "out" vs "available" comes from
  // the placeholder `active` flag. Tune once dispatch state is wired in.
  const counts = useMemo(() => {
    const arr = items?.filter((i) => !i.deleted_at) ?? []
    return {
      all: arr.length,
      out: arr.filter((i) => !i.active).length,
      available: arr.filter((i) => i.active).length,
      service: 0,
    }
  }, [items])

  const visible = useMemo(() => {
    const arr = items?.filter((i) => !i.deleted_at) ?? []
    const filtered =
      filter === 'all'
        ? arr
        : filter === 'out'
          ? arr.filter((i) => !i.active)
          : filter === 'available'
            ? arr.filter((i) => i.active)
            : []
    if (!query.trim()) return filtered
    const q = query.toLowerCase()
    return filtered.filter((i) => i.code.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
  }, [items, filter, query])

  // Items that are currently dispatched (active=false in our placeholder
  // model) earn their default rental rate per day. Once true dispatch
  // state lands, replace with the dispatched-item sum.
  const dailyRevenue = visible.filter((i) => !i.active).reduce((s, i) => s + Number(i.default_rental_rate ?? 0), 0)
  const utilizationPct = counts.all > 0 ? Math.round((counts.out / counts.all) * 100) : 0

  return (
    <>
      <MTopBar title="Rentals" sub={`My equipment · ${counts.all} active`} />
      <MBody>
        <div style={{ padding: '12px 16px 4px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'var(--m-card-soft)',
              borderRadius: 12,
              padding: '0 12px',
              height: 42,
            }}
          >
            <MI.Search size={18} style={{ color: 'var(--m-ink-3)' }} />
            <MInput
              type="search"
              placeholder="Search by tag or name"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                height: 'auto',
                padding: 0,
                fontSize: 15,
              }}
            />
          </div>
        </div>
        <MChipRow>
          <MChip active={filter === 'all'} onClick={() => setFilter('all')} count={counts.all}>
            All
          </MChip>
          <MChip active={filter === 'out'} onClick={() => setFilter('out')} count={counts.out}>
            Out
          </MChip>
          <MChip active={filter === 'available'} onClick={() => setFilter('available')} count={counts.available}>
            Available
          </MChip>
          <MChip outline onClick={() => setFilter('service')}>
            Service
          </MChip>
        </MChipRow>
        <MStatStrip>
          <MStat label="Out" value={String(counts.out)} />
          <MStat label="Daily revenue" value={formatMoney(dailyRevenue)} />
          <MStat label="Util" value={`${utilizationPct}%`} />
        </MStatStrip>
        {error ? (
          <div style={{ padding: 24, color: 'var(--m-red)', fontSize: 13 }}>{error}</div>
        ) : items === null ? (
          <MSkeletonList count={4} />
        ) : visible.length === 0 ? (
          <MEmptyState
            title="No equipment"
            body="Add your first item to start tracking dispatch and utilization."
            primaryLabel="New item"
            onPrimary={() => navigate('/inventory')}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 16px 80px' }}>
            {visible.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        )}
        <MFab extended ariaLabel="Scan tag" onClick={() => navigate('/m/rentals/scan')}>
          <MI.Camera size={18} />
          Scan tag
        </MFab>
      </MBody>
    </>
  )
}

function ItemCard({ item }: { item: InventoryItemRow }) {
  const out = !item.active
  return (
    <div
      style={{
        background: 'var(--m-card)',
        border: '1px solid var(--m-line)',
        borderRadius: 12,
        padding: '12px 14px',
        display: 'flex',
        gap: 12,
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 8,
          background: 'var(--m-card-soft)',
          color: 'var(--m-ink-3)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 18 }}>▦</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{item.description}</div>
        <div className="m-quiet-sm">
          {item.code} · {item.category}
        </div>
        <div className="m-quiet-sm" style={{ marginTop: 4 }}>
          ${item.default_rental_rate}/{item.unit || 'day'}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <MPill tone={out ? 'amber' : 'green'} dot>
          {out ? 'out' : 'in'}
        </MPill>
      </div>
    </div>
  )
}
