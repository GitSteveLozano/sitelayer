import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { AgentSurface, Attribution, Spark, useRejectSheet } from '@/components/ai'
import { EmptyState } from '@/components/shell/EmptyState'
import { SkeletonRows } from '@/components/shell/LoadingSkeleton'
import {
  useAiInsights,
  useApplyInsight,
  useDismissInsight,
  useImportTakeoff,
  useProjectMeasurements,
  useServiceItems,
  useTriggerTakeoffToBid,
  type ImportRow,
  type TakeoffMeasurement,
  type TakeoffToBidPayload,
} from '@/lib/api'
import { readElevation } from './takeoff-canvas'

/**
 * `prj-takeoff-list` — Sitemap §5 panel 2 ("Measurements list").
 *
 * The Takeoff sub-tab's primary content. Lists every measurement on
 * the project with thumb + code + qty, sorted newest-first. Header
 * action row links into the linear pipeline:
 *
 *   list (this screen) → detail → photo → summary
 *
 * The takeoff → bid agent surface and CSV importer collapse out of the
 * way — they're useful but not the screen's main job. The Phase 3
 * capability explainer cards moved to the dev/internal docs (the
 * migrations they describe are live and exposed through this list).
 */
export interface TakeoffListScreenProps {
  projectId: string
}

export function TakeoffListScreen({ projectId }: TakeoffListScreenProps) {
  const measurements = useProjectMeasurements(projectId)
  const rows = useMemo(
    () =>
      [...(measurements.data?.measurements ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
    [measurements.data],
  )

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Link
          to={`/projects/${projectId}/takeoff-canvas`}
          className="block rounded-md bg-accent text-white text-[12px] font-semibold py-2.5 text-center"
        >
          + Polygon
        </Link>
        <Link
          to={`/projects/${projectId}/photo-measure`}
          className="block rounded-md bg-card-soft text-ink-2 border border-line text-[12px] font-medium py-2.5 text-center"
        >
          📷 Photo
        </Link>
        <Link
          to={`/projects/${projectId}/takeoff-summary`}
          className="block rounded-md bg-card-soft text-ink-2 border border-line text-[12px] font-medium py-2.5 text-center"
        >
          Summary →
        </Link>
      </div>

      {measurements.isPending ? (
        <SkeletonRows count={4} className="px-0" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No measurements yet"
          body="Open the polygon canvas, photo-measure a feature, or paste a CSV export from Bluebeam / PlanSwift to get started."
          primaryAction={
            <Link
              to={`/projects/${projectId}/takeoff-canvas`}
              className="w-full h-[50px] rounded-[14px] bg-accent text-white text-[16px] font-semibold inline-flex items-center justify-center"
            >
              Open canvas
            </Link>
          }
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((m) => (
            <li key={m.id}>
              <MeasurementRow projectId={projectId} measurement={m} />
            </li>
          ))}
        </ul>
      )}

      {/* Takeoff → bid agent — collapsed by default; PMs only need it
          after a few measurements have landed. */}
      <TakeoffToBidPanel projectId={projectId} />

      {/* CSV importer — collapsed by default; expanded on demand. */}
      <CsvImportPanel projectId={projectId} />

      <Attribution source="Live from /api/projects/:id/takeoff/measurements" />
    </div>
  )
}

interface MeasurementRowProps {
  projectId: string
  measurement: TakeoffMeasurement
}

function MeasurementRow({ projectId, measurement }: MeasurementRowProps) {
  const items = useServiceItems()
  const item = items.data?.serviceItems.find((s) => s.code === measurement.service_item_code)
  const elevation = readElevation(measurement)
  const qty = Number(measurement.quantity)
  const kind = measurement.geometry && 'kind' in measurement.geometry ? measurement.geometry.kind : null
  return (
    <Link to={`/projects/${projectId}/takeoff/${measurement.id}`} className="block">
      <Card tight>
        <div className="flex items-center gap-3">
          {measurement.image_thumbnail ? (
            <img
              src={measurement.image_thumbnail}
              alt=""
              className="w-12 h-12 rounded-md object-cover shrink-0 border border-line"
              aria-hidden="true"
            />
          ) : (
            <div
              className="w-12 h-12 rounded-md bg-card-soft border border-line shrink-0 flex items-center justify-center text-[10px] text-ink-3"
              aria-hidden="true"
            >
              {kind ? kind[0]?.toUpperCase() : '—'}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-semibold truncate">{measurement.service_item_code}</span>
              {elevation !== 'none' ? (
                <Pill tone="default">{elevation}</Pill>
              ) : kind ? (
                <span className="text-[10px] text-ink-3 uppercase tracking-[0.04em]">{kind}</span>
              ) : null}
            </div>
            <div className="text-[11px] text-ink-3 mt-0.5 truncate">{item?.name ?? 'Unmapped service item'}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="font-mono tabular-nums text-[14px] font-semibold leading-none">
              {Number.isFinite(qty) ? qty.toFixed(2) : '0.00'}
            </div>
            <div className="text-[10px] text-ink-3 mt-0.5">{measurement.unit}</div>
          </div>
        </div>
      </Card>
    </Link>
  )
}

function TakeoffToBidPanel({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false)
  const insights = useAiInsights<TakeoffToBidPayload>({
    kind: 'takeoff_to_bid',
    entityId: projectId,
    open: true,
  })
  const trigger = useTriggerTakeoffToBid()
  const apply = useApplyInsight()
  const dismiss = useDismissInsight()
  const [rejectNode, askReject] = useRejectSheet()
  const [agentMsg, setAgentMsg] = useState<string | null>(null)

  const insight = insights.data?.insights[0]
  const hasInsight = Boolean(insight)

  const onTrigger = async () => {
    setAgentMsg(null)
    try {
      await trigger.mutateAsync({ project_id: projectId })
      setAgentMsg('Agent run enqueued. Refresh in a few seconds for proposals.')
    } catch (err) {
      setAgentMsg(err instanceof Error ? err.message : 'Failed to trigger agent')
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-card-soft border border-line rounded-md text-[12px] font-medium text-ink-2"
      >
        <span className="flex items-center gap-2">
          <Spark state={hasInsight ? 'accent' : 'dim'} size={10} aria-label="" />
          Takeoff → bid agent {hasInsight ? `· ${insight!.confidence} draft` : '· no run yet'}
        </span>
        <span className="text-ink-3">{open ? '−' : '+'}</span>
      </button>
      {open ? (
        <div className="mt-2">
          <AgentSurface banner={`Agent draft · ${insight?.confidence ?? 'pending'} confidence`}>
            <div className="text-[13px] font-semibold mb-2">Takeoff → bid suggestion</div>
            {insight ? (
              <ProposalBlock
                insightId={insight.id}
                payload={insight.payload}
                onApply={async (id) => {
                  await apply.mutateAsync({ id })
                }}
                onDismiss={async (id, reason) => {
                  await dismiss.mutateAsync(reason ? { id, reason } : { id })
                }}
                askReject={askReject}
              />
            ) : (
              <div className="text-[12px] text-ink-2">
                No agent run yet. Trigger one to propose bid lines from the project's takeoff measurements. The agent
                uses your service-item catalog as the rate book; lines without a catalog match land at low confidence so
                you know to review.
              </div>
            )}
            <div className="mt-3 pt-2 border-t border-dashed border-line-2 flex items-center justify-between">
              <Attribution source="POST /api/ai/agents/takeoff-to-bid → ai_insights" />
              <button
                type="button"
                onClick={onTrigger}
                disabled={trigger.isPending}
                className="text-[12px] text-accent font-medium"
              >
                {trigger.isPending ? 'Enqueuing…' : 'Run agent'}
              </button>
            </div>
            {agentMsg ? <div className="text-[11px] text-ink-3 mt-1">{agentMsg}</div> : null}
          </AgentSurface>
          {rejectNode}
        </div>
      ) : null}
    </div>
  )
}

interface ProposalBlockProps {
  insightId: string
  payload: TakeoffToBidPayload
  onApply: (id: string) => Promise<void>
  onDismiss: (id: string, reason?: string) => Promise<void>
  askReject: (opts: { title: string; body?: string }) => Promise<string | null>
}

function ProposalBlock({ insightId, payload, onApply, onDismiss, askReject }: ProposalBlockProps) {
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
    </div>
  )
}

function CsvImportPanel({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false)
  const importRows = useImportTakeoff(projectId)
  const [csvText, setCsvText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const onImport = async () => {
    setError(null)
    setMsg(null)
    try {
      const rows = parseCsv(csvText)
      if (rows.length === 0) {
        setError('No rows parsed. Expect a header row: code,quantity[,unit][,rate][,notes]')
        return
      }
      const result = await importRows.mutateAsync({ rows, source_label: 'pasted-csv' })
      setMsg(`Imported ${result.imported} measurements (source: ${result.source_label}).`)
      setCsvText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-card-soft border border-line rounded-md text-[12px] font-medium text-ink-2"
      >
        <span>CSV import (Bluebeam / PlanSwift / OST)</span>
        <span className="text-ink-3">{open ? '−' : '+'}</span>
      </button>
      {open ? (
        <Card className="mt-2">
          <div className="text-[11px] text-ink-2 mb-3">
            Paste an export below. First row is the header. Required columns:
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
          {error ? <div className="mt-2 text-[12px] text-bad">{error}</div> : null}
          {msg ? <div className="mt-2 text-[12px] text-good">{msg}</div> : null}
          <div className="mt-3">
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
      ) : null}
    </div>
  )
}

/** Minimal CSV parser: handles quoted strings + commas. */
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
