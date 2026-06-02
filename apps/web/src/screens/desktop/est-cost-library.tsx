/**
 * Shared cost library — desktop estimator surface (Takeoff Deep Dive M5).
 *
 * A company + shared catalog of trade unit costs (cladding / siding / framing)
 * with a CSV/.xlsx price-book import (PlanSwift parity). This is purely
 * additive: the pricing resolver consults the library only as the lowest
 * fallback (apps/api pricing.ts layer 6), so an empty library changes nothing.
 *
 * Layout mirrors the Item Library screen: a stat eyebrow, a KPI strip, a
 * search input + trade filter chips, and a dense table (TRADE · CODE · ITEM ·
 * UNIT · MATERIAL · LABOR · REGION · SOURCE). Two actions: "Import price book"
 * (CSV/.xlsx) and "New row".
 *
 * Regional MULTIPLIER resolution is a deliberate follow-up — the screen
 * surfaces the source region but does not yet apply a multiplier.
 */
import { useMemo, useState } from 'react'
import {
  fileToBase64,
  useCostLibrary,
  useCreateCostLibraryItem,
  useImportCostLibrary,
  type CostLibraryItem,
} from '@/lib/api/cost-library'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, DModal, type DColumn } from '@/components/d'
import { MButton, MChip, MChipRow, MInput, MSelect } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

const ALL = '__all__'

function moneyOrDash(raw: string | null): string {
  if (raw == null) return '—'
  const n = Number(raw)
  return Number.isFinite(n) ? formatMoney(n) : '—'
}

export function EstCostLibrary() {
  const libraryQuery = useCostLibrary()
  const [filter, setFilter] = useState<string>(ALL)
  const [search, setSearch] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const items = useMemo<CostLibraryItem[]>(() => libraryQuery.data?.items ?? [], [libraryQuery.data?.items])

  const trades = useMemo(() => {
    const set = new Set<string>()
    for (const it of items) {
      const t = it.trade?.trim()
      if (t) set.add(t)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [items])

  const sharedCount = useMemo(() => items.filter((i) => i.company_id == null).length, [items])

  const rows = useMemo<CostLibraryItem[]>(() => {
    const q = search.trim().toLowerCase()
    return items.filter((i) => {
      if (filter !== ALL && (i.trade?.trim() || '') !== filter) return false
      if (!q) return true
      return i.code.toLowerCase().includes(q) || (i.name?.toLowerCase().includes(q) ?? false)
    })
  }, [items, filter, search])

  const columns: Array<DColumn<CostLibraryItem>> = [
    {
      key: 'trade',
      header: 'Trade',
      render: (r) => <span style={{ color: 'var(--m-ink-3)', fontSize: 12 }}>{r.trade || '—'}</span>,
    },
    {
      key: 'code',
      header: 'Code',
      render: (r) => (
        <span style={{ fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-ink-3)' }}>{r.code}</span>
      ),
    },
    { key: 'name', header: 'Item', render: (r) => <span className="d-table-cell-strong">{r.name || '—'}</span> },
    { key: 'unit', header: 'Unit', render: (r) => r.unit || '—' },
    { key: 'material_rate', header: 'Material', numeric: true, render: (r) => moneyOrDash(r.material_rate) },
    { key: 'labor_rate', header: 'Labor', numeric: true, render: (r) => moneyOrDash(r.labor_rate) },
    {
      key: 'region',
      header: 'Region',
      render: (r) => <span style={{ color: 'var(--m-ink-3)', fontSize: 12 }}>{r.region || 'National'}</span>,
    },
    {
      key: 'source',
      header: 'Source',
      render: (r) => <span style={{ color: 'var(--m-ink-3)', fontSize: 12 }}>{r.source}</span>,
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>
            {items.length} {items.length === 1 ? 'row' : 'rows'} · {trades.length}{' '}
            {trades.length === 1 ? 'trade' : 'trades'}
            {sharedCount > 0 ? ` · ${sharedCount} shared` : ''}
          </DEyebrow>
          <DH1>Cost Library</DH1>
        </div>

        <DKpiStrip>
          <DKpi label="Total rows" value={String(items.length)} meta="Company + shared" />
          <DKpi label="Trades" value={String(trades.length)} tone="accent" meta="Distinct trades" />
          <DKpi label="Shared rows" value={String(sharedCount)} meta="Cross-company catalog" />
          <DKpi label="Company rows" value={String(items.length - sharedCount)} meta="Your imports" />
        </DKpiStrip>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <MInput
            value={search}
            placeholder="Search code or item…"
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 280 }}
          />
        </div>

        <MChipRow>
          <MChip active={filter === ALL} onClick={() => setFilter(ALL)} count={items.length}>
            All
          </MChip>
          {trades.map((t) => (
            <MChip
              key={t}
              active={filter === t}
              outline
              onClick={() => setFilter(t)}
              count={items.filter((i) => (i.trade?.trim() || '') === t).length}
            >
              {t}
            </MChip>
          ))}
        </MChipRow>

        <DataTable<CostLibraryItem>
          title="Catalog rows"
          action={
            <span style={{ display: 'flex', gap: 8 }}>
              <MButton size="sm" variant="quiet" onClick={() => setImportOpen(true)}>
                Import price book
              </MButton>
              <MButton size="sm" variant="quiet" onClick={() => setCreateOpen(true)}>
                + New row
              </MButton>
            </span>
          }
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty="No cost-library rows yet. Import a CSV/.xlsx price book or add a row — rates here are used only as the lowest pricing fallback."
        />
      </div>

      {importOpen ? (
        <ImportPriceBookModal
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false)
            void libraryQuery.refetch()
          }}
        />
      ) : null}
      {createOpen ? (
        <NewRowModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false)
            void libraryQuery.refetch()
          }}
        />
      ) : null}
    </div>
  )
}

interface ImportModalProps {
  onClose: () => void
  onImported: () => void
}

/** CSV/.xlsx price-book import. CSV files are read as text; .xlsx as base64. */
function ImportPriceBookModal({ onClose, onImported }: ImportModalProps) {
  const importMutation = useImportCostLibrary()
  const [file, setFile] = useState<File | null>(null)
  const [region, setRegion] = useState('')
  const [source, setSource] = useState('import')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<number | null>(null)

  const canImport = file != null && !busy

  const handleImport = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const isXlsx = /\.xlsx$/i.test(file.name)
      const content = isXlsx ? await fileToBase64(file) : await file.text()
      const trimmedRegion = region.trim()
      const trimmedSource = source.trim()
      const res = await importMutation.mutateAsync({
        format: isXlsx ? 'xlsx' : 'csv',
        content,
        ...(trimmedRegion ? { region: trimmedRegion } : {}),
        ...(trimmedSource ? { source: trimmedSource } : {}),
      })
      setResult(res.imported)
      onImported()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <DModal
      open
      onClose={onClose}
      title="Import price book"
      width={520}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%' }}>
          <span style={{ fontSize: 12, color: error ? 'var(--m-red)' : 'var(--m-ink-3)' }}>
            {error ?? (result != null ? `Imported ${result} rows.` : 'CSV or .xlsx with a code column.')}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <MButton variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </MButton>
            <MButton variant="primary" onClick={() => void handleImport()} disabled={!canImport}>
              {busy ? 'Importing…' : 'Import'}
            </MButton>
          </span>
        </div>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={labelStyle}>Price book (CSV / .xlsx)</span>
          <MInput type="file" accept=".csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>Region (optional)</span>
            <MInput value={region} placeholder="CA" onChange={(e) => setRegion(e.target.value)} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>Source label</span>
            <MInput value={source} placeholder="import" onChange={(e) => setSource(e.target.value)} />
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--m-ink-3)', margin: 0, lineHeight: 1.5 }}>
          Recognized columns: trade, code (or CSI / service_item_code), name, unit, material_rate, labor_rate (or a
          single rate/cost), region, source. Re-importing the same code updates its rates in place. Regional multipliers
          are a follow-up.
        </p>
      </div>
    </DModal>
  )
}

interface NewRowModalProps {
  onClose: () => void
  onCreated: () => void
}

/** Add a single cost-library row by hand. */
function NewRowModal({ onClose, onCreated }: NewRowModalProps) {
  const create = useCreateCostLibraryItem()
  const [trade, setTrade] = useState('cladding')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [unit, setUnit] = useState('SF')
  const [material, setMaterial] = useState('')
  const [labor, setLabor] = useState('')
  const [region, setRegion] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSave = code.trim() !== '' && !saving

  const parseRate = (raw: string): number | null | 'invalid' => {
    if (raw.trim() === '') return null
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return 'invalid'
    return n
  }

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    const mat = parseRate(material)
    const lab = parseRate(labor)
    if (mat === 'invalid' || lab === 'invalid') {
      setError('Rates must be non-negative numbers.')
      setSaving(false)
      return
    }
    try {
      const trimmedTrade = trade.trim()
      const trimmedName = name.trim()
      const trimmedUnit = unit.trim()
      const trimmedRegion = region.trim()
      await create.mutateAsync({
        code: code.trim(),
        material_rate: mat,
        labor_rate: lab,
        ...(trimmedTrade ? { trade: trimmedTrade } : {}),
        ...(trimmedName ? { name: trimmedName } : {}),
        ...(trimmedUnit ? { unit: trimmedUnit } : {}),
        ...(trimmedRegion ? { region: trimmedRegion } : {}),
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
      title="New cost-library row"
      width={560}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%' }}>
          <span style={{ fontSize: 12, color: error ? 'var(--m-red)' : 'var(--m-ink-3)' }}>
            {error ?? 'Used only as the lowest pricing fallback.'}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <MButton variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </MButton>
            <MButton variant="primary" onClick={() => void handleSave()} disabled={!canSave}>
              {saving ? 'Saving…' : 'Create row'}
            </MButton>
          </span>
        </div>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>Trade</span>
            <MInput value={trade} placeholder="cladding" onChange={(e) => setTrade(e.target.value)} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>Code / CSI</span>
            <MInput value={code} placeholder="09 24 00" onChange={(e) => setCode(e.target.value)} />
          </label>
        </div>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={labelStyle}>Item name</span>
          <MInput value={name} placeholder="Fiber cement panel" onChange={(e) => setName(e.target.value)} />
        </label>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '96px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)',
            gap: 10,
          }}
        >
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
            <span style={labelStyle}>Material</span>
            <MInput
              value={material}
              placeholder="3.50"
              inputMode="decimal"
              onChange={(e) => setMaterial(e.target.value)}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>Labor</span>
            <MInput value={labor} placeholder="1.25" inputMode="decimal" onChange={(e) => setLabor(e.target.value)} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>Region</span>
            <MInput value={region} placeholder="CA" onChange={(e) => setRegion(e.target.value)} />
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
