/**
 * Estimator desktop · AI Queue — review AI takeoff drafts (Desktop v2 · EST 04).
 * Company-wide review lane for AI auto-takeoff drafts. See
 * docs/V2_DESKTOP_AND_REMAINING_PLAN.md and docs/MULTI_DRAFT_TAKEOFF_SPEC.md.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { useCompanyTakeoffDrafts, type CompanyTakeoffDraft } from '@/lib/api/takeoff-drafts'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MAiStripe, MButton, MPill } from '@/components/m'
import { shortDate } from '../mobile/format.js'

// Human label for a capture-pipeline source. Mirrors the four pipelines in
// packages/pipe-* (the company feed never returns 'manual').
const SOURCE_LABELS: Record<CompanyTakeoffDraft['source'], string> = {
  blueprint_vision: 'Blueprint vision',
  roomplan: 'RoomPlan',
  drone: 'Drone',
  photogrammetry: 'Photogrammetry',
}

function sourceLabel(source: CompanyTakeoffDraft['source']): string {
  return SOURCE_LABELS[source] ?? source
}

export function EstAiQueue({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  // Company-wide AI-drafts feed (GET /api/takeoff-drafts). Pipeline-produced
  // drafts only — manual canvas drafts are filtered out server-side.
  const draftsQuery = useCompanyTakeoffDrafts()
  const rows = useMemo<CompanyTakeoffDraft[]>(() => draftsQuery.data?.drafts ?? [], [draftsQuery.data])

  const reviewable = rows.length
  const needsReview = useMemo(() => rows.filter((r) => r.review_required).length, [rows])
  const detectedTotal = useMemo(() => rows.reduce((sum, r) => sum + r.quantities_count, 0), [rows])

  // Deep-link into the per-draft review/promote flow (est-ai-takeoff.tsx).
  // That screen reads the target draft from navigation state, falling back to
  // the project's latest capture draft, so we hand it the row's draft id.
  const openReview = (row: CompanyTakeoffDraft) =>
    navigate(`/desktop/ai-takeoff/${row.project_id}/review`, { state: { draftId: row.id } })

  const columns: Array<DColumn<CompanyTakeoffDraft>> = [
    {
      key: 'project',
      header: 'Project',
      render: (r) => <span className="d-table-cell-strong">{r.project_name}</span>,
    },
    { key: 'draft', header: 'Draft', render: (r) => r.name },
    { key: 'source', header: 'Source', render: (r) => sourceLabel(r.source) },
    {
      key: 'detected',
      header: 'Detected items',
      numeric: true,
      render: (r) => String(r.quantities_count),
    },
    {
      key: 'confidence',
      header: 'Confidence',
      render: (r) => (
        <MPill tone={r.review_required ? 'amber' : 'green'} dot>
          {r.review_required ? 'Review' : 'High'}
        </MPill>
      ),
    },
    { key: 'created', header: 'Captured', render: (r) => shortDate(r.created_at) },
    {
      key: 'review',
      header: '',
      render: (r) => (
        <MButton size="sm" variant="quiet" onClick={() => openReview(r)}>
          Review →
        </MButton>
      ),
    },
  ]

  const tableEmpty =
    bootstrap === null || draftsQuery.isLoading
      ? 'Loading…'
      : draftsQuery.isError
        ? 'Could not load the AI takeoff queue. Try again.'
        : 'No AI takeoff drafts to review. Upload a blueprint and run the auto-takeoff pipeline to populate this queue.'

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
          When a blueprint is processed by the AI takeoff pipeline, each sheet produces a draft of detected quantities.
          Nothing is committed to a project estimate until you review it here and promote the quantities you trust.
          Low-confidence sheets are flagged for a closer look.
        </MAiStripe>

        <DKpiStrip>
          <DKpi label="Drafts to review" value={String(reviewable)} tone="accent" meta="Awaiting estimator" />
          <DKpi
            label="Needs review"
            value={String(needsReview)}
            meta={needsReview > 0 ? 'Low-confidence quantities' : 'None flagged'}
            metaTone={needsReview > 0 ? 'bad' : undefined}
          />
          <DKpi label="Detected items" value={String(detectedTotal)} meta="Across all drafts" />
        </DKpiStrip>

        <DataTable<CompanyTakeoffDraft>
          title="AI takeoff drafts"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={openReview}
          empty={tableEmpty}
        />
      </div>
    </div>
  )
}
