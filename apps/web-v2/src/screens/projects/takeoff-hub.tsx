import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { AgentSurface, Attribution, Spark, StripeCard, useRejectSheet } from '@/components/ai'
import {
  useAiInsights,
  useApplyInsight,
  useAssemblies,
  useDismissInsight,
  useImportTakeoff,
  useQboCustomFields,
  useTriggerTakeoffToBid,
  type ImportRow,
  type TakeoffToBidPayload,
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
  const triggerAgent = useTriggerTakeoffToBid()
  const insights = useAiInsights<TakeoffToBidPayload>({
    kind: 'takeoff_to_bid',
    entityId: projectId,
    open: true,
  })
  const dismissInsight = useDismissInsight()
  const applyInsight = useApplyInsight()
  const [csvText, setCsvText] = useState('')
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [agentMsg, setAgentMsg] = useState<string | null>(null)

  const onTriggerAgent = async () => {
    setAgentMsg(null)
    try {
      await triggerAgent.mutateAsync({ project_id: projectId })
      setAgentMsg('Agent run enqueued. Refresh in a few seconds for proposals.')
    } catch (err) {
      setAgentMsg(err instanceof Error ? err.message : 'Failed to trigger agent')
    }
  }

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
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <Spark state="accent" size={12} aria-label="" />
            <div className="text-[13px] font-semibold">Takeoff canvas</div>
          </div>
          <Pill tone="good">live</Pill>
        </div>
        <div className="text-[12px] text-ink-2 leading-relaxed">
          Tap to drop polygon vertices, run lineal segments, or drop count markers. Saved measurements feed the estimate
          recompute and the takeoff → bid agent below.
        </div>
        <div className="mt-3">
          <Link
            to={`/projects/${projectId}/takeoff-canvas`}
            className="inline-flex items-center justify-center w-full py-2 rounded-md bg-accent text-white text-[13px] font-semibold"
          >
            Open canvas
          </Link>
        </div>
      </Card>

      {/* Phase 5: takeoff → bid agent */}
      <AgentSurface banner={`Agent draft · ${insights.data?.insights[0]?.confidence ?? 'pending'} confidence`}>
        <div className="text-[13px] font-semibold mb-2">Takeoff → bid suggestion</div>
        {insights.data?.insights[0] ? (
          <TakeoffToBidProposalBlock
            insightId={insights.data.insights[0].id}
            payload={insights.data.insights[0].payload}
            onApply={async (id) => {
              await applyInsight.mutateAsync({ id })
            }}
            onDismiss={async (id, reason) => {
              await dismissInsight.mutateAsync(reason ? { id, reason } : { id })
            }}
          />
        ) : (
          <div className="text-[12px] text-ink-2">
            No agent run yet. Trigger one to propose bid lines from the project's takeoff measurements. The agent uses
            your service-item catalog as the rate book; lines without a catalog match land at low confidence so you know
            to review.
          </div>
        )}
        <div className="mt-3 pt-2 border-t border-dashed border-line-2 flex items-center justify-between">
          <Attribution source="POST /api/ai/agents/takeoff-to-bid → ai_insights" />
          <button
            type="button"
            onClick={onTriggerAgent}
            disabled={triggerAgent.isPending}
            className="text-[12px] text-accent font-medium"
          >
            {triggerAgent.isPending ? 'Enqueuing…' : 'Run agent'}
          </button>
        </div>
        {agentMsg ? <div className="text-[11px] text-ink-3 mt-1">{agentMsg}</div> : null}
      </AgentSurface>

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
          EIFS wall = EPS + basecoat + finish coat + air barrier as separate billable lines on the same shape. Backed by
          takeoff_measurement_tags (1:N).
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
          30–200 page plans. Each page carries its own two-point calibration (click two points of known distance) so
          mixed scales across sheets work correctly.
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
          polygon / lineal / count / volume. Caulk runs along window frames, vents drop as markers, domain helpers
          already compute area + length + volume.
        </div>
        <div className="mt-2 pt-2 border-t border-dashed border-line-2">
          <Attribution source="@sitelayer/domain · normalizePolygonGeometry + calculateTakeoffQuantity" />
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
          blueprint_page_diffs records bounding boxes of changed regions per replaced page + affected_measurement_ids
          snapshot. Image-diff worker + side-by-side overlay land with the canvas port.
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
          PlanSwift-style scope item composites. Take "EPS @ $4.85/sqft" and crack it open into the actual material +
          labor breakdown.
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
          <MobileButton
            variant="primary"
            size="sm"
            onClick={onImport}
            disabled={importRows.isPending || !csvText.trim()}
          >
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
          Configure once: which QBO custom field id receives the sqft total on Estimate / Invoice / Bill. The worker
          writes structured numeric data on every push instead of narrative description — cost-per-sqft becomes a real
          metric for the first time.
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
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
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

function TakeoffToBidProposalBlock({
  insightId,
  payload,
  onApply,
  onDismiss,
}: {
  insightId: string
  payload: TakeoffToBidPayload
  onApply: (id: string) => Promise<void>
  onDismiss: (id: string, reason?: string) => Promise<void>
}) {
  const [rejectNode, askReject] = useRejectSheet()
  return (
    <div>
      <div className="num text-[20px] font-bold tracking-tight">${payload.total_amount.toLocaleString()}</div>
      <div className="text-[11px] text-ink-3 mt-0.5">
        {payload.lines.length} line{payload.lines.length === 1 ? '' : 's'} from {payload.measurement_count} measurement
        {payload.measurement_count === 1 ? '' : 's'}
      </div>
      <div className="mt-2 space-y-1">
        {payload.lines.slice(0, 5).map((line, i) => (
          <div key={i} className="flex items-center justify-between text-[12px]">
            <div className="truncate flex-1 mr-2">
              <span className="font-medium">{line.service_item_code}</span>
              <span className="text-ink-3">
                {' '}
                · {line.quantity}
                {line.unit}
              </span>
            </div>
            <Pill tone={line.confidence === 'high' ? 'good' : line.confidence === 'med' ? 'default' : 'warn'}>
              ${line.amount.toFixed(2)}
            </Pill>
          </div>
        ))}
        {payload.lines.length > 5 ? (
          <div className="text-[11px] text-ink-3 italic">
            +{payload.lines.length - 5} more line{payload.lines.length - 5 === 1 ? '' : 's'}
          </div>
        ) : null}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <MobileButton variant="primary" onClick={() => void onApply(insightId)}>
          Apply to estimate
        </MobileButton>
        <MobileButton
          variant="ghost"
          onClick={async () => {
            const reason = await askReject({
              title: 'Dismiss agent proposal?',
              body: 'Pick the closest match — this trains the model.',
            })
            if (reason !== null) await onDismiss(insightId, reason)
          }}
        >
          Dismiss
        </MobileButton>
      </div>
      {rejectNode}
    </div>
  )
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
