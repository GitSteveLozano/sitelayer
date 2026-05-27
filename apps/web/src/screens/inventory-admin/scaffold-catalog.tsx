import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet } from '@/components/mobile'
import {
  useCatalogParts,
  useImportCatalogParts,
  useScaffoldManufacturers,
  useScaffoldSystems,
  type ScaffoldManufacturer,
  type ScaffoldSystem,
} from '@/lib/api/scaffold-ops'

/**
 * Catalog of physical scaffold parts (Kwikstage / Ring / Cup-lock /
 * HAKI / etc.). Read view + CSV-style row import. The BOM bridge then
 * references catalog_part_id from project-scoped BOMs.
 */
export function ScaffoldCatalogAdminScreen() {
  const manufacturers = useScaffoldManufacturers()
  const [manufacturerId, setManufacturerId] = useState<string>('')
  const systems = useScaffoldSystems(manufacturerId || undefined)
  const [systemId, setSystemId] = useState<string>('')
  const partFilter: { manufacturerId?: string; systemId?: string } = {}
  if (manufacturerId) partFilter.manufacturerId = manufacturerId
  if (systemId) partFilter.systemId = systemId
  const parts = useCatalogParts(partFilter)
  const importParts = useImportCatalogParts()
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<{ inserted: number; updated: number } | null>(null)

  const partRows = parts.data?.catalogParts ?? []
  const manufacturerById = useMemo(() => {
    const map = new Map<string, ScaffoldManufacturer>()
    for (const m of manufacturers.data?.manufacturers ?? []) map.set(m.id, m)
    return map
  }, [manufacturers.data])
  const systemById = useMemo(() => {
    const map = new Map<string, ScaffoldSystem>()
    for (const s of systems.data?.systems ?? []) map.set(s.id, s)
    return map
  }, [systems.data])

  function onImport() {
    setImportError(null)
    setImportResult(null)
    // Accept a header row: sku,description,unit,weight_kg
    const lines = importText.split(/\r?\n/).filter((l) => l.trim().length > 0)
    if (lines.length < 2) {
      setImportError('Need a header row and at least one data row.')
      return
    }
    const header = lines[0]!.split(',').map((s) => s.trim().toLowerCase())
    const skuIdx = header.indexOf('sku')
    const descIdx = header.indexOf('description')
    if (skuIdx < 0 || descIdx < 0) {
      setImportError('Header must include sku and description columns.')
      return
    }
    const unitIdx = header.indexOf('unit')
    const weightIdx = header.indexOf('weight_kg')
    const rows = lines.slice(1).map((line) => {
      const cols = line.split(',').map((s) => s.trim())
      const row: Record<string, unknown> = { sku: cols[skuIdx], description: cols[descIdx] }
      if (unitIdx >= 0 && cols[unitIdx]) row.unit = cols[unitIdx]
      if (weightIdx >= 0 && cols[weightIdx]) row.weight_kg = Number(cols[weightIdx])
      if (manufacturerId) row.manufacturer_id = manufacturerId
      if (systemId) row.scaffold_system_id = systemId
      return row
    })
    importParts.mutate(
      { rows },
      {
        onSuccess: (data) => setImportResult(data),
        onError: (err) => setImportError(err.message),
      },
    )
  }

  return (
    <div className="px-5 pt-6 pb-12 max-w-3xl">
      <Link to="/more/inventory" className="text-[12px] text-ink-3">
        ← Inventory admin
      </Link>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">Scaffold catalog</h1>
        <Link to="/scaffold-designer" className="shrink-0 text-[12px] font-medium text-accent">
          Scaffold designer →
        </Link>
      </div>
      <p className="text-[12px] text-ink-3 mt-1">
        Physical scaffold parts indexed by manufacturer + system. BOMs (per-project) reference these.
      </p>

      <Card tight>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[12px] text-ink-3">Manufacturer</span>
            <select
              value={manufacturerId}
              onChange={(e) => {
                setManufacturerId(e.target.value)
                setSystemId('')
              }}
              className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[13px]"
            >
              <option value="">— all —</option>
              {(manufacturers.data?.manufacturers ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[12px] text-ink-3">System</span>
            <select
              value={systemId}
              onChange={(e) => setSystemId(e.target.value)}
              className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[13px]"
            >
              <option value="">— all —</option>
              {(systems.data?.systems ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="text-[12px] text-ink-3">{partRows.length} parts</div>
        <MobileButton variant="primary" onClick={() => setImportOpen(true)}>
          Import CSV
        </MobileButton>
      </div>

      <div className="mt-2 space-y-1">
        {parts.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : partRows.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No catalog parts yet. Import a CSV to seed the catalog.</div>
          </Card>
        ) : (
          partRows.map((p) => (
            <Card key={p.id} tight>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold truncate">
                    <span className="font-mono">{p.sku}</span> · {p.description}
                  </div>
                  <div className="text-[11px] text-ink-3 mt-0.5">
                    {p.manufacturer_id ? manufacturerById.get(p.manufacturer_id)?.name : 'unmapped manuf.'}
                    {p.scaffold_system_id ? <> · {systemById.get(p.scaffold_system_id)?.name ?? '?'}</> : null}
                    {p.weight_kg ? <> · {p.weight_kg} kg</> : null}
                    {p.unit ? <> · {p.unit}</> : null}
                  </div>
                </div>
                <Pill tone={p.active ? 'good' : 'default'}>{p.active ? 'active' : 'inactive'}</Pill>
              </div>
            </Card>
          ))
        )}
      </div>

      {importOpen ? (
        <Sheet open onClose={() => setImportOpen(false)} title="Import catalog parts (CSV)">
          <p className="text-[12px] text-ink-3">
            Paste CSV with header row. Required columns: <span className="font-mono">sku, description</span>. Optional:{' '}
            <span className="font-mono">unit, weight_kg</span>. If manufacturer and system are selected above, those are
            applied to every row.
          </p>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={8}
            placeholder={'sku,description,unit,weight_kg\nKWS-STD-2.0,Standard 2.0m,ea,12.5'}
            className="mt-2 w-full rounded-md border border-line bg-base p-2 text-[12px] font-mono"
          />
          {importError ? <div className="text-[12px] text-danger mt-2">{importError}</div> : null}
          {importResult ? (
            <div className="text-[12px] text-good mt-2">
              Inserted {importResult.inserted}, updated {importResult.updated}.
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-3">
            <MobileButton type="button" variant="ghost" onClick={() => setImportOpen(false)}>
              Close
            </MobileButton>
            <MobileButton onClick={onImport} variant="primary" disabled={importParts.isPending}>
              Import
            </MobileButton>
          </div>
        </Sheet>
      ) : null}
    </div>
  )
}
