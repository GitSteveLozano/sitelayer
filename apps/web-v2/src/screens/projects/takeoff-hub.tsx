import { useState } from 'react'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution, Spark, StripeCard } from '@/components/ai'
import {
  useAssemblies,
  useImportTakeoff,
  useQboCustomFields,
  type ImportRow,
} from '@/lib/api'

/**
 * Takeoff hub for the prj-detail Takeoff sub-tab.
 *
 * Phase 3 ships the full takeoff backend: multi-condition tags, per-page
 * scale calibration, multi-page nav, linear/count geometry kinds, plan
 * revision diffs, assemblies, CSV import, and the QBO sqft custom-field
 * bridge. The polygon-canvas UI itself is a 1000+ LOC port from v1; that
 * lands in a focused follow-on. This hub:
 *
 *   - Surfaces the new capabilities (each as a card with current count
 *     + action where applicable)
 *   - Hosts the CSV importer (3G) inline — text-paste UX
 *   - Links out to v1 for the canvas drawing
 *   - Documents what each Phase 3 migration unlocks
 */
export function TakeoffHubScreen({ projectId }: { projectId: string }) {
  const assemblies = useAssemblies()
  const customFields = useQboCustomFields()
  const importRows = useImportTakeoff(projectId)
  const [csvText, setCsvText] = useState('')
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const onImport = async () => {
    setImportError(null)
    setImportMsg(null)
    try {
      const rows = parseCsv(csvText)
      if (rows.length === 0) {
        setImportError('No rows parsed. Expect a header row: code,quantity[,unit][,rate][,notes]')
        return
      }
      const result = await importRows.mutateAsync({ rows, source_label: 'pasted-csv' })
      setImportMsg(`Imported ${result.imported} measurements (source: ${result.source_label}).`)
      setCsvText('')
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed')
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <Spark state="muted" size={12} aria-label="" />
          <div className="text-[13px] font-semibold">Takeoff canvas</div>
        </div>
        <div className="text-[12px] text-ink-2 leading-relaxed">
          The polygon-drawing canvas, multi-condition tagging UI, per-page calibration overlay, and
          plan-revision Compare visualizer ship next as a focused canvas port from v1. The data layer
          they all read/write is live below.
        </div>
      </Card>

      {/* Phase 3A: multi-condition tags */}
      <StripeCard tone="accent">
        <div className="flex items-start justify-between mb-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-ink">
            Phase 3A · Multi-condition takeoff
          </div>
          <Pill tone="good">backend live</Pill>
        </div>
        <div className="text-[13px] font-semibold">One polygon · many scope tags</div>
        <div className="text-[11px] text-ink-2 mt-1">
          EIFS wall = EPS + basecoat + finish coat + air barrier as separate billable lines on the same
          shape. Backed by takeoff_measurement_tags (1:N).
        </div>
        <div className="mt-2 pt-2 border-t border-dashed border-line-2">
          <Attribution source="API: GET/POST /api/takeoff/measurements/:id/tags" />
        </div>
      </StripeCard>

      {/* Phase 3B/C: pages + calibration */}
      <StripeCard tone="accent">
        <div className="flex items-start justify-between mb-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-ink">
            Phase 3B/C · Multi-page + calibration
          </div>
          <Pill tone="good">backend live</Pill>
        </div>
        <div className="text-[13px] font-semibold">Per-page scale + page strip</div>
        <div className="text-[11px] text-ink-2 mt-1">
          30–200 page plans. Each page carries its own two-point calibration (click two points of known
          distance) so mixed scales across sheets work correctly.
        </div>
        <div className="mt-2 pt-2 border-t border-dashed border-line-2">
          <Attribution source="API: /api/blueprints/:docId/pages, /api/blueprint-pages/:id/calibrate" />
        </div>
      </StripeCard>

      {/* Phase 3D: linear/count */}
      <StripeCard tone="accent">
        <div className="flex items-start justify-between mb-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-ink">
            Phase 3D · Linear + count tools
          </div>
          <Pill tone="good">backend live</Pill>
        </div>
        <div className="text-[13px] font-semibold">geometry_kind discriminator</div>
        <div className="text-[11px] text-ink-2 mt-1">
          polygon / lineal / count / volume. Caulk runs along window frames, vents drop as markers,
          domain helpers already compute area + length + volume.
        </div>
      </StripeCard>

      {/* Phase 3E: compare */}
      <StripeCard tone="accent">
        <div className="flex items-start justify-between mb-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-ink">
            Phase 3E · Plan revision compare
          </div>
          <Pill tone="warn">backend + worker pending UI</Pill>
        </div>
        <div className="text-[13px] font-semibold">"3 measurements live on areas that changed"</div>
        <div className="text-[11px] text-ink-2 mt-1">
          blueprint_page_diffs records bounding boxes of changed regions per replaced page +
          affected_measurement_ids snapshot. Image-diff worker + side-by-side overlay land with the
          canvas port.
        </div>
      </StripeCard>

      {/* Phase 3F: assemblies */}
      <Card>
        <div className="flex items-start justify-between mb-1">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-ink">
              Phase 3F · Assemblies
            </div>
            <div className="text-[13px] font-semibold mt-1">Materials + waste + labor + freight</div>
          </div>
          <Pill tone={assemblies.data?.assemblies.length ? 'good' : 'default'}>
            {assemblies.data?.assemblies.length ?? 0} configured
          </Pill>
        </div>
        <div className="text-[11px] text-ink-2 mt-1">
          PlanSwift-style scope item composites. Take "EPS @ $4.85/sqft" and crack it open into the
          actual material + labor breakdown.
        </div>
        <div className="mt-2 pt-2 border-t border-dashed border-line-2">
          <Attribution source="API: GET/POST /api/assemblies + /api/assemblies/:id/components" />
        </div>
      </Card>

      {/* Phase 3G: CSV import — inline */}
      <Card>
        <div className="text-[13px] font-semibold mb-1">Phase 3G · CSV import</div>
        <div className="text-[11px] text-ink-2 mb-3">
          Paste a Bluebeam / PlanSwift / OST export below. First row is the header. Required columns:
          <code className="bg-card-soft px-1 py-0.5 rounded ml-1">code</code>,
          <code className="bg-card-soft px-1 py-0.5 rounded ml-1">quantity</code>. Optional:
          <code className="bg-card-soft px-1 py-0.5 rounded ml-1">unit</code>,
          <code className="bg-card-soft px-1 py-0.5 rounded ml-1">rate</code>,
          <code className="bg-card-soft px-1 py-0.5 rounded ml-1">notes</code>.
        </div>
        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          rows={6}
          placeholder={'code,quantity,unit,rate\nEPS,1284.5,sqft,4.85\nBASE,1284.5,sqft,3.95'}
          className="w-full p-3 rounded border border-line-2 bg-card text-[12px] font-mono focus:outline-none focus:border-accent resize-none"
        />
        {importError ? <div className="mt-2 text-[12px] text-bad">{importError}</div> : null}
        {importMsg ? <div className="mt-2 text-[12px] text-good">{importMsg}</div> : null}
        <div className="mt-3 flex gap-2">
          <MobileButton variant="primary" size="sm" onClick={onImport} disabled={importRows.isPending || !csvText.trim()}>
            {importRows.isPending ? 'Importing…' : 'Import rows'}
          </MobileButton>
        </div>
      </Card>

      {/* Phase 3H: QBO sqft */}
      <Card>
        <div className="flex items-start justify-between mb-1">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-ink">
              Phase 3H · QBO sqft custom field
            </div>
            <div className="text-[13px] font-semibold mt-1">Position C payoff</div>
          </div>
          <Pill tone={customFields.data?.mappings.length ? 'good' : 'default'}>
            {customFields.data?.mappings.length ?? 0} mapping
            {customFields.data?.mappings.length === 1 ? '' : 's'}
          </Pill>
        </div>
        <div className="text-[11px] text-ink-2 mt-1">
          Configure once: which QBO custom field id receives the sqft total on Estimate / Invoice / Bill.
          The worker writes structured numeric data on every push instead of narrative description —
          cost-per-sqft becomes a real metric for the first time.
        </div>
        <div className="mt-2 pt-2 border-t border-dashed border-line-2">
          <Attribution source="API: GET/PUT /api/qbo/custom-fields" />
        </div>
      </Card>
    </div>
  )
}

/** Minimal CSV parser: handles quoted strings + commas. No vendor-
 *  specific dialect handling — we only need code/quantity/unit/rate/notes
 *  columns and the brief explicitly chooses column-mapping over auto-detect. */
function parseCsv(text: string): ImportRow[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []
  const header = splitCsvRow(lines[0]!).map((s) => s.trim().toLowerCase())
  const codeIdx = header.findIndex((c) => c === 'code' || c === 'service_item_code')
  const qtyIdx = header.findIndex((c) => c === 'quantity' || c === 'qty')
  if (codeIdx < 0 || qtyIdx < 0) {
    throw new Error('CSV header must include `code` and `quantity` columns')
  }
  const unitIdx = header.findIndex((c) => c === 'unit')
  const rateIdx = header.findIndex((c) => c === 'rate')
  const notesIdx = header.findIndex((c) => c === 'notes' || c === 'note')

  const rows: ImportRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvRow(lines[i]!)
    const code = (cols[codeIdx] ?? '').trim()
    const qty = Number((cols[qtyIdx] ?? '').replace(/,/g, ''))
    if (!code || !Number.isFinite(qty) || qty < 0) continue
    const row: ImportRow = { service_item_code: code, quantity: qty }
    if (unitIdx >= 0 && cols[unitIdx]) row.unit = cols[unitIdx]!.trim()
    if (rateIdx >= 0 && cols[rateIdx]) {
      const r = Number(cols[rateIdx]!.replace(/[^0-9.]/g, ''))
      if (Number.isFinite(r)) row.rate = r
    }
    if (notesIdx >= 0 && cols[notesIdx]) row.notes = cols[notesIdx]!.trim()
    rows.push(row)
  }
  return rows
}

function splitCsvRow(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        current += ch
      }
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') {
        result.push(current)
        current = ''
      } else {
        current += ch
      }
    }
  }
  result.push(current)
  return result
}
