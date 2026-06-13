/**
 * `mb-est-quantities-summary` — mobile quantities summary (design msg__30,
 * audit M05 #13).
 *
 * The screen the takeoff canvas DONE lands on, BETWEEN canvas and Price&Send:
 * a TOTAL LINE ITEMS hero, a sheet-verification status line, the priced
 * line-item list, then EDIT / GENERATE PDF and a continue-to-pricing CTA.
 *
 * Data is the same surface the desktop EstQuantities + mobile estimate
 * review use — nothing invented:
 *   - line items + totals + staleness: `useEstimateBuilder`
 *     (GET /api/projects/:id/estimate/scope-vs-bid);
 *   - project name: GET /api/projects/:id/summary;
 *   - sheet verification: the project's latest blueprint document's pages
 *     (useProjectBlueprints + useBlueprintPages). A sheet counts as verified
 *     when it carries the per-sheet scale sign-off (`scale_verified_at`,
 *     migration 123) OR a set two-point calibration (`calibration_set_at`) —
 *     the same trust signals the canvas / autoscale-verify screens use.
 *
 * HONEST GAP: the design's per-line sheet refs ("A-201-203") need per-line
 * sheet provenance that estimate_lines don't carry yet (the desktop screen
 * stubs this — see est-quantities.tsx QtyRow.sheets TODO). Rather than
 * fabricate sheet names, each row shows its real line total.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet, getActiveCompanySlug, type ProjectSummary } from '@/lib/api'
import { useEstimateBuilder } from '@/machines/estimate-builder'
import { useBlueprintPages, useProjectBlueprints } from '../../lib/api/takeoff.js'
import { MBanner, MBody, MButton, MTopBar } from '../../components/m/index.js'
import { MSkeletonList } from '../../components/m-states/index.js'
import { formatMoney } from './format.js'

const mono = (extra: CSSProperties = {}): CSSProperties => ({
  fontFamily: 'var(--m-num)',
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  ...extra,
})

export function MobileEstQuantitiesSummary({ companySlug }: { companySlug: string }) {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  // Line items + live totals + staleness — same machine as Price&Send.
  const builder = useEstimateBuilder(projectId, getActiveCompanySlug())

  // Project name for the SUMMARY · <PROJECT> eyebrow.
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    apiGet<ProjectSummary>(`/api/projects/${projectId}/summary`, companySlug)
      .then((s) => {
        if (!cancelled) setSummary(s)
      })
      .catch((err) => {
        if (!cancelled) setSummaryError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, companySlug])

  // Sheet verification — real blueprint pages on the project's latest doc.
  const blueprintsQuery = useProjectBlueprints(projectId)
  const latestDoc = (blueprintsQuery.data?.blueprints ?? []).filter((b) => !b.deleted_at).at(-1) ?? null
  const pagesQuery = useBlueprintPages(latestDoc?.id ?? null)
  const pages = pagesQuery.data?.pages ?? []
  const sheetTotal = pages.length
  const sheetVerified = useMemo(
    () => pages.filter((p) => Boolean(p.scale_verified_at) || Boolean(p.calibration_set_at)).length,
    [pages],
  )
  const sheetsLoading = blueprintsQuery.isLoading || pagesQuery.isLoading
  const allVerified = sheetTotal > 0 && sheetVerified === sheetTotal

  const lines = builder.lines
  const hasLines = lines.length > 0
  const isStale = Boolean(builder.snapshot?.is_stale)

  const backToCanvas = () => navigate(`/projects/${projectId}/takeoff-mobile`)
  const openPdf = () => navigate(`/projects/${projectId}/estimate/pdf`)
  const openPricing = () => navigate(`/projects/${projectId}/estimate`)
  const openVerify = () => navigate(`/projects/${projectId}/takeoff-ai/autoscale`)

  // Honest sheet-status line: every branch states exactly what the data says.
  const sheetLine = sheetsLoading
    ? 'CHECKING SHEETS…'
    : !latestDoc
      ? 'NO BLUEPRINT ON THIS PROJECT'
      : sheetTotal === 0
        ? 'BLUEPRINT HAS NO SHEETS'
        : allVerified
          ? `${sheetTotal} SHEET${sheetTotal === 1 ? '' : 'S'} · ALL VERIFIED ✓ · READY FOR ESTIMATE`
          : `${sheetTotal} SHEET${sheetTotal === 1 ? '' : 'S'} · ${sheetVerified} VERIFIED · ${
              sheetTotal - sheetVerified
            } TO REVIEW`

  return (
    <>
      <MTopBar
        back
        eyebrow={`SUMMARY${summary?.project.name ? ` · ${summary.project.name.toUpperCase()}` : ''}`}
        title="Quantities"
        onBack={backToCanvas}
      />
      <MBody>
        {summaryError ? (
          <div style={{ padding: '12px 16px', color: 'var(--m-red)', fontSize: 13 }}>{summaryError}</div>
        ) : null}

        {/* TOTAL LINE ITEMS hero + sheet-verification line (msg__30 head). */}
        <div style={{ padding: '20px 16px 16px', borderBottom: '2px solid var(--m-ink)' }}>
          <div style={mono({ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--m-ink-3)' })}>
            Total line items
          </div>
          <div
            className="num"
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 64,
              lineHeight: 0.9,
              letterSpacing: '-0.035em',
              marginTop: 8,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {builder.isLoading && !hasLines ? '—' : lines.length}
          </div>
          {/* Verification line — taps through to the autoscale verify screen
              while sheets remain unverified. */}
          {allVerified || sheetsLoading || !latestDoc || sheetTotal === 0 ? (
            <div
              style={mono({
                fontSize: 11,
                marginTop: 12,
                color: allVerified ? 'var(--m-ink-2)' : 'var(--m-ink-3)',
                lineHeight: 1.5,
              })}
            >
              {sheetLine}
            </div>
          ) : (
            <button
              type="button"
              onClick={openVerify}
              style={{
                ...mono({ fontSize: 11, lineHeight: 1.5 }),
                marginTop: 12,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: 'var(--m-red)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {sheetLine} →
            </button>
          )}
        </div>

        {/* H4 staleness — a measurement / assembly / rate changed after the
            last recompute, so these quantities are out of date. */}
        {isStale ? (
          <div style={{ padding: '12px 16px 0' }}>
            <MBanner
              tone="warn"
              title="Quantities out of date"
              body="A measurement, assembly, or rate changed after this estimate was last computed. Recompute before generating the PDF."
              action={
                <MButton variant="ghost" size="sm" disabled={builder.isRecomputing} onClick={() => builder.recompute()}>
                  {builder.isRecomputing ? 'Recomputing…' : 'Recompute'}
                </MButton>
              }
            />
          </div>
        ) : null}

        {builder.error ? (
          <div style={{ padding: '12px 16px 0' }}>
            <MBanner
              tone="error"
              title="Could not load quantities"
              body={builder.error}
              action={
                <MButton variant="ghost" size="sm" onClick={() => builder.refresh()}>
                  Retry
                </MButton>
              }
            />
          </div>
        ) : null}

        {/* Line-item list — real estimate lines, qty + unit on the right. */}
        {builder.isLoading && !hasLines ? (
          <MSkeletonList count={4} />
        ) : hasLines ? (
          <div>
            {lines.map((line) => {
              const qty = Number(line.quantity)
              return (
                <div
                  key={line.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '16px',
                    borderBottom: '1px solid var(--m-line-2)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 16 }}>
                      {line.service_item_code}
                    </div>
                    <div style={mono({ fontSize: 10, color: 'var(--m-ink-3)', marginTop: 3 })}>
                      {formatMoney(line.amount)}
                      {line.division_code ? ` · ${line.division_code}` : ''}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div
                      className="num"
                      style={{
                        fontFamily: 'var(--m-font-display)',
                        fontWeight: 800,
                        fontSize: 24,
                        lineHeight: 1,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {Number.isFinite(qty) ? qty.toLocaleString('en-US') : '—'}
                    </div>
                    <div style={mono({ fontSize: 10, color: 'var(--m-ink-3)', marginTop: 3 })}>{line.unit || '—'}</div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div style={{ padding: '20px 16px' }}>
            <div style={{ fontSize: 13, color: 'var(--m-ink-3)', lineHeight: 1.5 }}>
              No line items yet. Run takeoff first, then recompute the estimate.
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <MButton variant="ghost" size="sm" disabled={builder.isRecomputing} onClick={() => builder.recompute()}>
                {builder.isRecomputing ? 'Recomputing…' : 'Recompute estimate'}
              </MButton>
            </div>
          </div>
        )}

        {/* EDIT / GENERATE PDF pair + continue-to-pricing (msg__30 foot). */}
        <div style={{ padding: 16, display: 'grid', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
            <MButton variant="ghost" onClick={backToCanvas} style={{ minWidth: 0 }}>
              Edit
            </MButton>
            <MButton variant="primary" onClick={openPdf} disabled={!hasLines} style={{ minWidth: 0 }}>
              Generate PDF
            </MButton>
          </div>
          <MButton variant="ghost" onClick={openPricing}>
            Continue to pricing →
          </MButton>
        </div>
      </MBody>
    </>
  )
}
