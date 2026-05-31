/**
 * `mb-takeoff-cross-link` — mobile cross-sheet callout jump (msg29).
 *
 * Implements Steve's handoff design `AI · CROSS-LINKED / A-201 EAST`: the AI
 * links detail callouts (A1, B3, …) it found while parsing the plan set; each
 * callout circle is overlaid on the active sheet and, when tapped, shows a
 * "JUMPS TO · <sheet> · DETAIL <tag>" tooltip and navigates to that sheet/page
 * on the takeoff canvas. A footer summarises "● N CALLOUTS LINKED · TAP A
 * CIRCLE TO JUMP" and a BACK-TO-<sheet> button returns to the source.
 *
 * GAP: there is no callout-extraction endpoint. The callout coordinates +
 * targets are therefore presentational, but the sheet list they jump BETWEEN is
 * real (useBlueprintPages on the latest blueprint) so a tap genuinely opens the
 * referenced page in the mobile takeoff canvas. Suggested fill: a parse step
 * that emits { page_id, tag, target_page_id, x, y } rows.
 *
 * Route: projects/:projectId/takeoff-ai/cross-link?blueprint=<docId>
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { MButton, MI, Spark } from '../../components/m/index.js'
import { useBlueprintPages, useProjectBlueprints } from '../../lib/api/takeoff.js'

type Callout = {
  tag: string
  /** board-space (0–100) position of the circle on the sheet */
  x: number
  y: number
  detail: string
  /** index into the real page list this callout jumps to (clamped) */
  targetPageIdx: number
}

// Presentational callout positions (the AI would emit these from the parse).
const CALLOUTS: Callout[] = [
  { tag: 'A1', x: 14, y: 26, detail: 'WALL SECTION A1', targetPageIdx: 1 },
  { tag: 'B3', x: 52, y: 44, detail: 'DETAIL B3', targetPageIdx: 2 },
]

export function TakeoffCrossLink({ companySlug }: { companySlug: string }) {
  void companySlug
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const projectId = params.projectId ?? ''

  const blueprintsQuery = useProjectBlueprints(projectId)
  const docParam = searchParams.get('blueprint')
  const docs = (blueprintsQuery.data?.blueprints ?? []).filter((b) => !b.deleted_at)
  const doc = docs.find((b) => b.id === docParam) ?? docs.at(-1) ?? null
  const pagesQuery = useBlueprintPages(doc?.id ?? null)
  const pages = useMemo(() => pagesQuery.data?.pages ?? [], [pagesQuery.data])

  const sourceLabel = (doc?.file_name ?? 'A-201').toUpperCase()
  const [activeTag, setActiveTag] = useState<string>(CALLOUTS[1]!.tag)
  const active = CALLOUTS.find((c) => c.tag === activeTag) ?? null

  // Resolve a callout's jump target against the REAL page list when available.
  const targetLabel = (c: Callout): string => {
    const page = pages[Math.min(c.targetPageIdx, Math.max(pages.length - 1, 0))]
    if (page) return `PAGE ${page.page_number}`
    return `A-50${c.targetPageIdx}`
  }

  const jump = (c: Callout) => {
    const page = pages[Math.min(c.targetPageIdx, Math.max(pages.length - 1, 0))]
    const qs = new URLSearchParams()
    if (doc) qs.set('blueprint', doc.id)
    if (page) qs.set('page', page.id)
    navigate(`/projects/${projectId}/takeoff-mobile${qs.toString() ? `?${qs}` : ''}`)
  }

  const back = () => navigate(`/projects/${projectId}/takeoff-mobile`)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="m-topbar">
        <button type="button" className="m-topbar-back" aria-label="Back" onClick={back}>
          <MI.ChevLeft size={22} />
        </button>
        <div className="m-topbar-title">
          <div className="m-topbar-eyebrow" data-tone="accent" style={{ display: 'inline-flex', gap: 5 }}>
            <Spark size={11} state="strong" /> AI · CROSS-LINKED
          </div>
          <div className="m-h1">{sourceLabel}</div>
        </div>
      </div>

      {/* Elevation with callout circles. */}
      <div style={{ flex: 1, background: 'var(--m-card-soft)', position: 'relative', overflow: 'hidden' }}>
        <svg
          viewBox="0 0 100 100"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid slice"
          style={{ position: 'absolute', inset: 0 }}
        >
          <defs>
            <pattern id="cross-link-grid" width="5" height="5" patternUnits="userSpaceOnUse">
              <path d="M 5 0 L 0 0 0 5" stroke="var(--m-ink-3)" strokeWidth="0.15" fill="none" />
            </pattern>
          </defs>
          <rect width="100" height="100" fill="url(#cross-link-grid)" />

          {/* Stylised elevation outline (matches msg29's gabled facade). */}
          <path d="M14 30 L50 16 L86 30 L86 78 L14 78 Z" fill="none" stroke="var(--m-ink)" strokeWidth="0.8" />
          <rect x="22" y="40" width="14" height="14" fill="none" stroke="var(--m-ink)" strokeWidth="0.6" />
          <rect x="62" y="56" width="14" height="22" fill="none" stroke="var(--m-ink)" strokeWidth="0.6" />

          {/* Callout circles — tap to select + show the jump tooltip. */}
          {CALLOUTS.map((c) => {
            const on = c.tag === activeTag
            return (
              <g key={c.tag} onPointerDown={() => setActiveTag(c.tag)} style={{ cursor: 'pointer' }}>
                <circle
                  cx={c.x}
                  cy={c.y}
                  r="4.6"
                  fill="var(--m-accent)"
                  stroke="var(--m-ink)"
                  strokeWidth={on ? 1.1 : 0.7}
                />
                <text
                  x={c.x}
                  y={c.y + 1.6}
                  textAnchor="middle"
                  fontFamily="var(--m-num)"
                  fontSize="3.4"
                  fontWeight="800"
                  fill="var(--m-accent-ink)"
                >
                  {c.tag}
                </text>
              </g>
            )
          })}
        </svg>

        {/* JUMPS TO tooltip on the active callout. */}
        {active ? (
          <div
            style={{
              position: 'absolute',
              left: `${Math.min(active.x + 6, 52)}%`,
              top: `${active.y}%`,
              maxWidth: 180,
              padding: '8px 12px',
              background: 'var(--m-ink)',
              color: 'var(--m-sand)',
              border: '2px solid var(--m-ink)',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.08em',
                color: 'var(--m-ink-4)',
              }}
            >
              JUMPS TO
            </div>
            <button
              type="button"
              onClick={() => jump(active)}
              style={{
                marginTop: 4,
                background: 'transparent',
                border: 'none',
                padding: 0,
                color: 'var(--m-sand)',
                fontFamily: 'var(--m-font-display)',
                fontWeight: 800,
                fontSize: 15,
                lineHeight: 1.1,
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              {targetLabel(active)} · {active.detail}
            </button>
          </div>
        ) : null}
      </div>

      {/* Footer summary. */}
      <div
        style={{
          padding: '12px 20px',
          background: 'var(--m-ink)',
          color: 'var(--m-sand)',
          borderTop: '2px solid var(--m-ink)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            color: 'var(--m-accent)',
          }}
        >
          ● {CALLOUTS.length} CALLOUTS LINKED
        </span>
        <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 600, color: 'var(--m-ink-4)' }}>
          TAP A CIRCLE TO JUMP
        </span>
      </div>

      <div style={{ padding: '14px 20px 18px', borderTop: '2px solid var(--m-ink)' }}>
        <MButton variant="primary" onClick={back}>
          Back to {sourceLabel}
        </MButton>
      </div>
    </div>
  )
}
