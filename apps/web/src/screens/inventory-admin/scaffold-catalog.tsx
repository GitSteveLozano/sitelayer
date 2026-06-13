import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  MBody,
  MButton,
  MButtonRow,
  MI,
  MListPlain,
  MListRow,
  MPill,
  MSelect,
  MTextarea,
  MTopBar,
} from '@/components/m'
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
  const navigate = useNavigate()

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
    <>
      <MTopBar
        back
        eyebrow="Inventory admin"
        title="Scaffold catalog"
        sub={`${partRows.length} parts`}
        onBack={() => navigate('/more/inventory')}
      />
      <MBody>
        <p className="m-quiet-sm" style={{ padding: '14px 16px 4px', margin: 0 }}>
          Physical scaffold parts indexed by manufacturer + system. BOMs (per-project) reference these.{' '}
          <Link to="/scaffold-designer" className="text-accent font-medium">
            Scaffold designer →
          </Link>
        </p>

        <div style={{ padding: '12px 16px 0' }}>
          <div className="m-card m-card-tight">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Manufacturer">
                <MSelect
                  value={manufacturerId}
                  onChange={(e) => {
                    setManufacturerId(e.target.value)
                    setSystemId('')
                  }}
                >
                  <option value="">— all —</option>
                  {(manufacturers.data?.manufacturers ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </MSelect>
              </Field>
              <Field label="System">
                <MSelect value={systemId} onChange={(e) => setSystemId(e.target.value)}>
                  <option value="">— all —</option>
                  {(systems.data?.systems ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </MSelect>
              </Field>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <MButton variant="primary" size="sm" onClick={() => setImportOpen(true)}>
              Import CSV
            </MButton>
          </div>
        </div>

        {parts.isPending ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            Loading…
          </div>
        ) : partRows.length === 0 ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            No catalog parts yet. Import a CSV to seed the catalog.
          </div>
        ) : (
          <MListPlain>
            {partRows.map((p) => (
              <MListRow
                key={p.id}
                headline={
                  <>
                    <span style={{ fontFamily: 'var(--m-num)' }}>{p.sku}</span> · {p.description}
                  </>
                }
                supporting={
                  <>
                    {p.manufacturer_id ? manufacturerById.get(p.manufacturer_id)?.name : 'unmapped manuf.'}
                    {p.scaffold_system_id ? <> · {systemById.get(p.scaffold_system_id)?.name ?? '?'}</> : null}
                    {p.weight_kg ? <> · {p.weight_kg} kg</> : null}
                    {p.unit ? <> · {p.unit}</> : null}
                  </>
                }
                trailing={<MPill tone={p.active ? 'green' : undefined}>{p.active ? 'active' : 'inactive'}</MPill>}
              />
            ))}
          </MListPlain>
        )}
      </MBody>

      {importOpen ? (
        <MSheet title="Import catalog parts (CSV)" onClose={() => setImportOpen(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 16 }}>
            <p className="m-quiet-sm" style={{ margin: 0 }}>
              Paste CSV with header row. Required columns:{' '}
              <span style={{ fontFamily: 'var(--m-num)' }}>sku, description</span>. Optional:{' '}
              <span style={{ fontFamily: 'var(--m-num)' }}>unit, weight_kg</span>. If manufacturer and system are
              selected above, those are applied to every row.
            </p>
            <MTextarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={8}
              placeholder={'sku,description,unit,weight_kg\nKWS-STD-2.0,Standard 2.0m,ea,12.5'}
              style={{ fontFamily: 'var(--m-num)', fontSize: 12 }}
            />
            {importError ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{importError}</div> : null}
            {importResult ? (
              <div style={{ color: 'var(--m-green)', fontSize: 13 }}>
                Inserted {importResult.inserted}, updated {importResult.updated}.
              </div>
            ) : null}
            <MButtonRow>
              <MButton type="button" variant="ghost" onClick={() => setImportOpen(false)}>
                Close
              </MButton>
              <MButton onClick={onImport} variant="primary" disabled={importParts.isPending}>
                Import
              </MButton>
            </MButtonRow>
          </div>
        </MSheet>
      ) : null}
    </>
  )
}

/**
 * Bottom sheet in the `.m-sheet` idiom (styles/m.css — square corners, 2px
 * ink top rule, hard offset shadow, no grabber/blur). Same pattern as the
 * AssignmentSheet swap in screens/mobile/schedule.tsx (e9b7c7f3); replaces
 * the retired wave-2 kit Sheet. ESC and backdrop-tap dismiss.
 */
function MSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'rgba(15, 14, 12, 0.5)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="m-sheet" style={{ maxWidth: 720 }}>
        <div className="m-sheet-header">
          <div className="m-sheet-title">{title}</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 4,
              color: 'var(--m-ink)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <MI.X size={20} />
          </button>
        </div>
        <div className="m-sheet-body" style={{ padding: '16px 20px 0' }}>
          {children}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="m-topbar-eyebrow">{label}</span>
      {children}
    </label>
  )
}
