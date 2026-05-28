/**
 * Estimator desktop · AI Queue — review AI takeoff drafts (Desktop v2 · EST 04).
 * Read-only review lane for AI auto-takeoff drafts. See
 * docs/V2_DESKTOP_AND_REMAINING_PLAN.md and docs/MULTI_DRAFT_TAKEOFF_SPEC.md.
 */
import { useMemo } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MAiStripe, MButton, MPill } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

type DraftRow = {
  id: string
  sheet: string
  detected: number
  confidence: 'high' | 'low'
  status: string
}

export function EstAiQueue({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  // There is no unified "AI takeoff drafts" list hook yet. Drafts are created
  // per-project by POST /api/projects/:id/takeoff-drafts/capture
  // (kind=blueprint_vision | roomplan | drone | photogrammetry) and reviewed/
  // promoted per-draft. Until a company-scoped drafts feed exists, this lane
  // renders an empty review queue with a clear empty state.
  // TODO: back this with a real AI-drafts feed once the capture pipeline
  // exposes a company-wide list (see takeoff-drafts/capture +
  // takeoff_drafts.source='blueprint_vision').
  const rows = useMemo<DraftRow[]>(() => [], [])

  const reviewable = rows.length
  const lowConfidence = useMemo(() => rows.filter((r) => r.confidence === 'low').length, [rows])
  const detectedTotal = useMemo(() => rows.reduce((sum, r) => sum + r.detected, 0), [rows])

  const columns: Array<DColumn<DraftRow>> = [
    { key: 'sheet', header: 'Sheet', render: (r) => <span className="d-table-cell-strong">{r.sheet}</span> },
    { key: 'detected', header: 'Detected items', numeric: true, render: (r) => String(r.detected) },
    {
      key: 'confidence',
      header: 'Confidence',
      render: (r) => (
        <MPill tone={r.confidence === 'high' ? 'green' : 'amber'} dot>
          {r.confidence === 'high' ? 'High' : 'Low'}
        </MPill>
      ),
    },
    { key: 'status', header: 'Status', render: (r) => r.status },
    {
      key: 'review',
      header: '',
      render: () => (
        // TODO: open the per-draft review/promote flow once the AI-drafts
        // feed lands (POST /api/projects/:id/takeoff-drafts/:draftId/promote).
        <MButton size="sm" variant="quiet" onClick={() => {}}>
          Review →
        </MButton>
      ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Estimator · AI Queue</DEyebrow>
          <DH1>Review drafts</DH1>
        </div>

        <MAiStripe
          eyebrow="AI auto-takeoff"
          title="Drafts land here for review before they hit an estimate"
          attribution="Auto-takeoff · review required"
        >
          When a blueprint is processed by the AI takeoff pipeline, each sheet produces a draft of detected
          quantities. Nothing is committed to a project estimate until you review it here and promote the
          quantities you trust. Low-confidence sheets are flagged for a closer look.
        </MAiStripe>

        <DKpiStrip>
          <DKpi label="Drafts to review" value={String(reviewable)} tone="accent" meta="Awaiting estimator" />
          <DKpi
            label="Low confidence"
            value={String(lowConfidence)}
            meta={lowConfidence > 0 ? 'Needs a closer look' : 'None flagged'}
            metaTone={lowConfidence > 0 ? 'bad' : undefined}
          />
          <DKpi label="Detected items" value={String(detectedTotal)} meta="Across all drafts" />
          <DKpi label="Est. value at review" value={formatMoney(0)} meta="Pending promotion" />
        </DKpiStrip>

        <DataTable<DraftRow>
          title="AI takeoff drafts"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty={
            bootstrap === null
              ? 'Loading…'
              : 'No AI takeoff drafts to review. Upload a blueprint and run the auto-takeoff pipeline to populate this queue.'
          }
        />
      </div>
    </div>
  )
}
