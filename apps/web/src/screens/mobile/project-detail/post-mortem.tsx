/**
 * PROJECT · POST-MORTEM (mobile, v2 brutalist). Fixes CONFORMANCE-REPORT
 * §319 — until now only the desktop PostMortemDrawer existed.
 *
 * Routed at `/projects/:projectId/post-mortem`, reachable from the closed
 * project hero / Budget-tab closeout card's "Open post-mortem" affordance.
 *
 * Renders FINAL MARGIN + per-division labor variance (the same read-model
 * the desktop drawer uses: useProjectCloseoutSummary + useProjectLaborVariance)
 * over the project-closeout workflow snapshot. The one durable workflow
 * fact is the human acknowledgement: when the closeout state is `completed`
 * it offers ACKNOWLEDGE_POST_MORTEM (completed → post_mortem terminal); when
 * `post_mortem` it shows the acknowledged date. Thin renderer over the
 * headless useProjectCloseoutMachine — no business state mirrored.
 */
import { useNavigate, useParams } from 'react-router-dom'
import { useProjectCloseoutSummary } from '../../../lib/api/closeout-summary.js'
import { useProjectLaborVariance } from '../../../lib/api/labor-variance.js'
import { getActiveCompanySlug } from '../../../lib/api/client.js'
import { useProjectCloseoutMachine } from '../../../machines/project-closeout.js'
import { MBanner, MBody, MButton, MKpi, MSectionH, MTopBar } from '../../../components/m/index.js'
import { formatMoney, shortDate } from '../format.js'

export function MobilePostMortem() {
  const { projectId = '' } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const closeout = useProjectCloseoutSummary(projectId || undefined)
  const variance = useProjectLaborVariance(projectId || undefined)
  const workflow = useProjectCloseoutMachine(projectId, getActiveCompanySlug())

  const rawMargin = closeout.data?.margin_pct ?? null
  // margin_pct may arrive as a fraction (0.34) or a percent (34) — normalize.
  const marginPct = rawMargin == null ? null : Math.round(Math.abs(rawMargin) <= 1 ? rawMargin * 100 : rawMargin)
  const bid = closeout.data?.bid ?? null
  const totalActual = closeout.data?.total_actual ?? null

  // Per-division labor variance (real rows grouped by division).
  const byDivision = new Map<string, { est: number; act: number }>()
  for (const r of variance.data?.variance ?? []) {
    const key = r.division_code ?? 'Other'
    const d = byDivision.get(key) ?? { est: 0, act: 0 }
    d.est += r.estimated_hours
    d.act += r.actual_hours
    byDivision.set(key, d)
  }
  const lines = [...byDivision.entries()]
    .map(([label, d]) => {
      const pct = d.est > 0 ? Math.round(((d.act - d.est) / d.est) * 100) : 0
      return { label, pct, bad: pct > 0 }
    })
    .sort((a, b) => b.pct - a.pct)
  const worst = lines.find((l) => l.bad) ?? null

  const loading = closeout.isPending || variance.isPending
  const errored = closeout.isError || variance.isError

  const wfSnapshot = workflow.snapshot
  const ackEvent = wfSnapshot?.next_events.find((ev) => ev.type === 'ACKNOWLEDGE_POST_MORTEM')

  return (
    <>
      <MTopBar back title="Post-mortem" onBack={() => navigate(`/projects/${projectId}`)} />
      <MBody>
        {loading ? (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--m-ink-3)', fontWeight: 600 }}>
            Loading post-mortem…
          </div>
        ) : errored ? (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--m-red)', fontWeight: 600 }}>
            Could not load the post-mortem.
          </div>
        ) : (
          <div style={{ paddingTop: 8 }}>
            <div style={{ padding: '0 16px 12px' }}>
              <MKpi
                label="Final margin"
                value={marginPct != null ? marginPct : '—'}
                unit={marginPct != null ? '%' : undefined}
                meta={`${bid != null ? `Bid ${formatMoney(bid)}` : 'Bid —'} · ${
                  totalActual != null ? `Actual ${formatMoney(totalActual)}` : 'Actual —'
                }`}
                metaTone={marginPct != null && marginPct < 0 ? 'red' : 'green'}
              />
            </div>

            <MSectionH>Labor variance by division</MSectionH>
            {lines.length > 0 ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {lines.map((l, idx) => (
                  <li
                    key={l.label}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '12px 16px',
                      borderBottom: idx === lines.length - 1 ? 'none' : '1px solid var(--m-line)',
                    }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--m-ink)' }}>{l.label}</span>
                    <span
                      className="num"
                      style={{ fontSize: 14, fontWeight: 700, color: l.bad ? 'var(--m-red)' : 'var(--m-green)' }}
                    >
                      {l.pct > 0 ? '+' : ''}
                      {l.pct}%
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div style={{ padding: '0 16px 12px', fontSize: 13, color: 'var(--m-ink-3)', lineHeight: 1.45 }}>
                No labor-variance data for this job.
              </div>
            )}

            {worst ? (
              <div
                style={{
                  margin: '12px 16px',
                  padding: 14,
                  background: 'var(--m-accent)',
                  border: '2px solid var(--m-ink)',
                }}
              >
                <div
                  className="num"
                  style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--m-accent-ink)' }}
                >
                  ● NEXT TIME
                </div>
                <div
                  className="num"
                  style={{
                    fontSize: 11,
                    color: 'var(--m-accent-ink)',
                    marginTop: 8,
                    fontWeight: 600,
                    lineHeight: 1.5,
                  }}
                >
                  {worst.label.toUpperCase()} LABOR RAN {worst.pct}% OVER ESTIMATE. ADD A BUFFER ON SIMILAR JOBS.
                </div>
              </div>
            ) : null}

            {/* Post-mortem acknowledgement — the durable workflow fact. */}
            {wfSnapshot ? (
              <div style={{ padding: '12px 16px 24px' }}>
                {workflow.outOfSync ? (
                  <div style={{ marginBottom: 10 }}>
                    <MBanner
                      tone="warn"
                      title="Workflow state moved"
                      body="Reloaded the latest state — review before acknowledging again."
                    />
                  </div>
                ) : null}
                {wfSnapshot.state === 'post_mortem' ? (
                  <div className="num" style={{ fontSize: 12, color: 'var(--m-green)', fontWeight: 700 }}>
                    ● POST-MORTEM ACKNOWLEDGED
                    {wfSnapshot.context.post_mortem_acknowledged_at
                      ? ` · ${shortDate(wfSnapshot.context.post_mortem_acknowledged_at)}`
                      : ''}
                  </div>
                ) : ackEvent ? (
                  <MButton
                    variant="primary"
                    disabled={workflow.isSubmitting}
                    onClick={() => workflow.dispatch('ACKNOWLEDGE_POST_MORTEM')}
                  >
                    {workflow.isSubmitting ? 'Closing record…' : 'Acknowledge & close record'}
                  </MButton>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </MBody>
    </>
  )
}
