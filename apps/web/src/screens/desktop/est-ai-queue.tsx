/**
 * Estimator desktop · AI Queue — review AI takeoff drafts (Desktop v2 · EST 04).
 * Company-wide review lane for AI auto-takeoff drafts. See
 * docs/V2_DESKTOP_AND_REMAINING_PLAN.md and docs/MULTI_DRAFT_TAKEOFF_SPEC.md.
 *
 * Layout matches the handoff (dsg__08): an eyebrow + H1, then a vertical list
 * of large bordered review cards — each with a left yellow accent bar, a square
 * 'AI' tile, a '<PROJECT> · <relative time>' eyebrow, the draft title, a stat
 * sub-line, and a 'REVIEW DRAFT →' button.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { useCompanyTakeoffDrafts, type CompanyTakeoffDraft } from '@/lib/api/takeoff-drafts'
import { DEyebrow, DH1 } from '@/components/d'
import { MButton } from '@/components/m'

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

// Compact relative time for the card eyebrow ("42S AGO" / "8M AGO" in dsg__08).
function relativeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (sec < 60) return `${sec}S AGO`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}M AGO`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}H AGO`
  return `${Math.round(hr / 24)}D AGO`
}

function DraftCard({ row, onReview }: { row: CompanyTakeoffDraft; onReview: () => void }) {
  const ago = relativeAgo(row.created_at)
  // Stat sub-line mirrors the design's "<n> items · <conf>" breadcrumb. We have
  // the detected-item count + a coarse review flag; sheet/per-confidence splits
  // aren't in the company feed yet, so we surface what the API exposes.
  const stat = `${row.quantities_count} ITEMS · ${row.source.toUpperCase().replace('_', ' ')} · ${
    row.review_required ? 'REVIEW REQUIRED' : 'HIGH CONFIDENCE'
  }`
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onReview}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onReview()
        }
      }}
      style={{
        display: 'grid',
        gridTemplateColumns: '6px auto minmax(0, 1fr) auto',
        alignItems: 'center',
        gap: 20,
        background: 'var(--m-card)',
        border: '2px solid var(--m-ink)',
        cursor: 'pointer',
      }}
    >
      {/* Left yellow accent bar */}
      <div style={{ alignSelf: 'stretch', background: 'var(--m-accent)' }} aria-hidden />
      {/* Square AI tile */}
      <div
        style={{
          width: 56,
          height: 56,
          margin: '20px 0 20px 14px',
          background: 'var(--m-accent)',
          border: '2px solid var(--m-ink)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--m-num)',
          fontWeight: 800,
          fontSize: 14,
          color: 'var(--m-ink)',
        }}
        aria-hidden
      >
        AI
      </div>
      {/* Project eyebrow + draft title + stat sub-line */}
      <div style={{ padding: '20px 0', minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            color: 'var(--m-ink-2)',
            textTransform: 'uppercase',
          }}
        >
          {row.project_name}
          {ago ? ` · ${ago}` : ''}
        </div>
        <div
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 800,
            fontSize: 22,
            color: 'var(--m-ink)',
            textTransform: 'uppercase',
            margin: '4px 0 6px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {row.name || sourceLabel(row.source)}
        </div>
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--m-ink-2)',
          }}
        >
          {stat}
        </div>
      </div>
      {/* Review action */}
      <div style={{ padding: '0 20px' }}>
        <MButton
          variant="primary"
          onClick={(e) => {
            e.stopPropagation()
            onReview()
          }}
        >
          Review draft →
        </MButton>
      </div>
    </div>
  )
}

export function EstAiQueue({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  // Company-wide AI-drafts feed (GET /api/takeoff-drafts). Pipeline-produced
  // drafts only — manual canvas drafts are filtered out server-side.
  const draftsQuery = useCompanyTakeoffDrafts()
  const rows = useMemo<CompanyTakeoffDraft[]>(() => draftsQuery.data?.drafts ?? [], [draftsQuery.data])

  // Deep-link into the per-draft review/promote flow (est-ai-takeoff.tsx).
  // That screen reads the target draft from navigation state, falling back to
  // the project's latest capture draft, so we hand it the row's draft id.
  const openReview = (row: CompanyTakeoffDraft) =>
    navigate(`/desktop/ai-takeoff/${row.project_id}/review`, { state: { draftId: row.id } })

  const loading = bootstrap === null || draftsQuery.isLoading
  const emptyMessage = draftsQuery.isError
    ? 'Could not load the AI queue. Try again.'
    : loading
      ? 'Loading…'
      : 'No AI drafts to review. Upload a blueprint and run the auto-takeoff pipeline to populate this queue.'

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>AI · Drafts ready to review</DEyebrow>
          <DH1>AI Queue</DH1>
        </div>

        {rows.length === 0 ? (
          <div
            style={{
              border: '2px solid var(--m-ink)',
              background: 'var(--m-card)',
              padding: 24,
              fontFamily: 'var(--m-num)',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--m-ink-2)',
            }}
          >
            {emptyMessage}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {rows.map((row) => (
              <DraftCard key={row.id} row={row} onReview={() => openReview(row)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
