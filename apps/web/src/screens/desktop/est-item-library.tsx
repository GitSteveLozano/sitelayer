/**
 * Estimator desktop item library — the read surface over the service-item
 * catalog (Desktop v2 · Estimator · Item Library). Reuses the same
 * `useServiceItems` hook the owner pricing book uses; this is a denser,
 * estimator-facing composition with division/category filtering.
 * See docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 *
 * Matches the dsg__38 EST_ITEM_LIBRARY design: a stat-line eyebrow
 * (`N items · M assemblies · synced QBO`), a filter chip row that includes an
 * ASSEMBLIES chip, and a dense table whose columns are CSI · ITEM · ASSEMBLY ·
 * UNIT · COST. The ASSEMBLY column shows the bordered name of the assembly an
 * item is the scope item for (or "—"). "New item" opens a real create-item
 * modal wired to `useCreateServiceItem`.
 */
import { useMemo, useState } from 'react'
import { useServiceItems, useCreateServiceItem, type ServiceItem } from '@/lib/api/service-items'
import { useAssemblies } from '@/lib/api/assemblies'
import { useQboConnection } from '@/lib/api/qbo'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, DModal, type DColumn } from '@/components/d'
import { MButton, MChip, MChipRow, MInput, MPill, MSelect } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

const ALL = '__all__'
const ASSEMBLIES = '__assemblies__'

export function EstItemLibrary() {
  const itemsQuery = useServiceItems()
  const assembliesQuery = useAssemblies()
  const qboQuery = useQboConnection()
  const [filter, setFilter] = useState<string>(ALL)
  const [createOpen, setCreateOpen] = useState(false)

  const items = useMemo<ServiceItem[]>(() => itemsQuery.data?.serviceItems ?? [], [itemsQuery.data?.serviceItems])

  // The design's ASSEMBLY column names the assembly each item is the scope
  // item for. An Assembly carries a `service_item_code`; map code → name so a
  // row can surface its parent assembly (or "—" when standalone).
  const assemblyByCode = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of assembliesQuery.data?.assemblies ?? []) {
      if (a.service_item_code) map.set(a.service_item_code, a.name)
    }
    return map
  }, [assembliesQuery.data?.assemblies])

  const assemblyCount = assembliesQuery.data?.assemblies?.length ?? 0
  const qboConnected = qboQuery.data?.connection != null

  const { categories, divisions, avgRate } = useMemo(() => {
    const cats = new Set<string>()
    let rateSum = 0
    let rateCount = 0
    for (const item of items) {
      const cat = item.category?.trim()
      if (cat) cats.add(cat)
      const rate = item.default_rate == null ? NaN : Number(item.default_rate)
      if (Number.isFinite(rate)) {
        rateSum += rate
        rateCount += 1
      }
    }
    return {
      categories: Array.from(cats).sort((a, b) => a.localeCompare(b)),
      divisions: cats.size,
      avgRate: rateCount > 0 ? rateSum / rateCount : null,
    }
  }, [items])

  const rows = useMemo<ServiceItem[]>(() => {
    if (filter === ALL) return items
    if (filter === ASSEMBLIES) return items.filter((i) => assemblyByCode.has(i.code))
    return items.filter((i) => (i.category?.trim() || '') === filter)
  }, [items, filter, assemblyByCode])

  const columns: Array<DColumn<ServiceItem>> = [
    {
      key: 'code',
      header: 'CSI',
      render: (r) => (
        <span style={{ fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-ink-3)' }}>{r.code}</span>
      ),
    },
    { key: 'name', header: 'Item', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    {
      key: 'assembly',
      header: 'Assembly',
      // The design shows the parent assembly as a bordered tag, or "—" when the
      // item is standalone. We resolve the real assembly that names this item as
      // its scope service item; uncovered items render "—".
      render: (r) => {
        const name = assemblyByCode.get(r.code)
        return name ? <MPill>{name}</MPill> : <span style={{ color: 'var(--m-ink-3)' }}>—</span>
      },
    },
    { key: 'unit', header: 'Unit', render: (r) => r.unit || '—' },
    {
      key: 'default_rate',
      header: 'Cost',
      numeric: true,
      render: (r) => (r.default_rate == null ? '—' : formatMoney(r.default_rate)),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          {/* Stat-line eyebrow per design: `N items · M assemblies · synced QBO`.
              The QBO segment only shows when a connection exists. */}
          <DEyebrow>
            {items.length} {items.length === 1 ? 'item' : 'items'} · {assemblyCount}{' '}
            {assemblyCount === 1 ? 'assembly' : 'assemblies'}
            {qboConnected ? ' · synced QBO' : ''}
          </DEyebrow>
          <DH1>Item Library</DH1>
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
          <MChip active={filter === ASSEMBLIES} outline onClick={() => setFilter(ASSEMBLIES)} count={assemblyCount}>
            Assemblies
          </MChip>
        </MChipRow>

        <DKpiStrip>
          <DKpi label="Total items" value={String(items.length)} meta="In catalog" />
          <DKpi label="Assemblies" value={String(assemblyCount)} meta="Grouped items" />
          <DKpi label="Divisions" value={String(divisions)} tone="accent" meta="Categories" />
          <DKpi label="Avg rate" value={avgRate == null ? '—' : formatMoney(avgRate)} meta="Across priced items" />
        </DKpiStrip>

        <DataTable<ServiceItem>
          title="Catalog items"
          action={
            <MButton size="sm" variant="quiet" onClick={() => setCreateOpen(true)}>
              + New item
            </MButton>
          }
          columns={columns}
          rows={rows}
          rowKey={(r) => r.code}
          empty="No items in your catalog yet. Service items added here are available to every estimate."
        />
      </div>

      {createOpen ? (
        <NewItemModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false)
            void itemsQuery.refetch()
          }}
        />
      ) : null}
    </div>
  )
}

interface NewItemModalProps {
  onClose: () => void
  onCreated: () => void
}

/** Create-item editor for the Item Library "New item" action (the design's
 *  prominent item-creation flow). Writes through `useCreateServiceItem`. */
function NewItemModal({ onClose, onCreated }: NewItemModalProps) {
  const create = useCreateServiceItem()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [category, setCategory] = useState('measurable')
  const [unit, setUnit] = useState('SF')
  const [rate, setRate] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSave = code.trim() !== '' && name.trim() !== '' && !saving

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const rateNum = rate.trim() === '' ? null : Number(rate)
      if (rateNum != null && (!Number.isFinite(rateNum) || rateNum < 0)) {
        setError('Cost must be a non-negative number.')
        setSaving(false)
        return
      }
      const trimmedCategory = category.trim()
      const trimmedUnit = unit.trim()
      await create.mutateAsync({
        code: code.trim(),
        name: name.trim(),
        default_rate: rateNum,
        ...(trimmedCategory ? { category: trimmedCategory } : {}),
        ...(trimmedUnit ? { unit: trimmedUnit } : {}),
      })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <DModal
      open
      onClose={onClose}
      title="New item"
      width={520}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%' }}>
          <span style={{ fontSize: 12, color: error ? 'var(--m-red)' : 'var(--m-ink-3)' }}>
            {error ?? 'Items added here are available to every estimate.'}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <MButton variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </MButton>
            <MButton variant="primary" onClick={() => void handleSave()} disabled={!canSave}>
              {saving ? 'Saving…' : 'Create item'}
            </MButton>
          </span>
        </div>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 0.8fr) minmax(0, 1.6fr)', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>CSI / code</span>
            <MInput value={code} placeholder="09 24 00" onChange={(e) => setCode(e.target.value)} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>Item name</span>
            <MInput value={name} placeholder='EPS Board · 2"' onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) 96px minmax(0, 1fr)', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>Category</span>
            <MInput value={category} placeholder="measurable" onChange={(e) => setCategory(e.target.value)} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>Unit</span>
            <MSelect value={unit} onChange={(e) => setUnit(e.target.value)}>
              {['SF', 'LF', 'EA', 'CY', 'HR', 'LS'].map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </MSelect>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>Cost</span>
            <MInput
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={rate}
              placeholder="0.00"
              onChange={(e) => setRate(e.target.value)}
              style={{ textAlign: 'right' }}
            />
          </label>
        </div>
      </div>
    </DModal>
  )
}

const labelStyle = {
  fontFamily: 'var(--m-num)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase' as const,
  color: 'var(--m-ink-3)',
}
