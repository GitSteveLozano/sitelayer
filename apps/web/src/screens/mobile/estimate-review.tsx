/**
 * Mobile estimate review. Shows the project's estimate lines + totals
 * with a send CTA. KPIs / AI stripe / scope tree come from
 * /api/projects/:id/summary; the editable line list comes from the
 * `useEstimateBuilder` machine (GET /api/projects/:id/estimate/scope-vs-bid),
 * whose lines carry the `id` that PATCH /api/estimate-lines/:id targets.
 *
 * Inline editing: each line exposes quantity + rate fields. Edits stage
 * on the machine (keyed on service_item_code) and flush through a 700ms
 * debounced SAVE → PATCH. The returned scope_vs_bid refreshes totals; a
 * 409 reloads the snapshot and shows a conflict banner.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet, getActiveCompanySlug, type ProjectSummary } from '@/lib/api'
import { useEstimateBuilder } from '@/machines/estimate-builder'
import type { EstimateLine } from '../../lib/api/estimate.js'
import { createEstimatePush } from '../../lib/api/estimate-pushes.js'
import {
  MBanner,
  MBody,
  MButton,
  MButtonStack,
  MI,
  MInput,
  MKpi,
  MKpiRow,
  MPill,
  MListInset,
  MSectionH,
  MTopBar,
} from '../../components/m/index.js'
import { MAiStripe } from '../../components/m/ai.js'
import { MSkeletonList } from '../../components/m-states/index.js'
import { formatMoney } from './format.js'

export function MobileEstimateReview({ companySlug }: { companySlug: string }) {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creatingPush, setCreatingPush] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Editable line list + totals. The machine owns the scope-vs-bid
  // snapshot (whose lines carry `id`), staged edits, and save/conflict UI
  // state. The summary above stays the source for KPIs / AI stripe.
  const builder = useEstimateBuilder(projectId, getActiveCompanySlug())

  // Debounced auto-save (700ms) — mirrors the desktop estimate-builder.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!builder.hasDirtyEdits) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => builder.save(), 700)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [builder])

  const handleSendToClient = async () => {
    if (!projectId) return
    setCreatingPush(true)
    setCreateError(null)
    try {
      const result = await createEstimatePush(projectId)
      const pushId = result.kind === 'created' ? result.pushId : result.openId
      navigate(`/projects/${projectId}/estimate-push/${pushId}`)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreatingPush(false)
    }
  }

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    apiGet<ProjectSummary>(`/api/projects/${projectId}/summary`, companySlug)
      .then((s) => {
        if (cancelled) return
        setSummary(s)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, companySlug])

  if (error) {
    return (
      <>
        <MTopBar back title="Estimate" onBack={() => navigate(`/projects/${projectId}`)} />
        <MBody>
          <div style={{ padding: 24, color: 'var(--m-red)', fontSize: 13 }}>{error}</div>
        </MBody>
      </>
    )
  }
  if (!summary) {
    return (
      <>
        <MTopBar back title="Estimate" onBack={() => navigate(`/projects/${projectId}`)} />
        <MBody>
          <MSkeletonList count={5} />
        </MBody>
      </>
    )
  }

  const m = summary.metrics
  // Editable lines come from the builder snapshot (they carry `id`). Fall
  // back to the summary lines for the scope tree / empty-state guard.
  const editableLines = builder.lines
  const summaryLines = summary.estimateLines
  // Live total: prefer the machine snapshot (updates as edits save) and
  // fall back to the summary metric before the snapshot loads.
  const liveTotal = builder.snapshot?.scope_total ?? m.estimateTotal
  const marginPct = `${(m.margin.margin * 100).toFixed(0)}%`
  const marginTone: 'green' | 'amber' | 'red' =
    m.margin.margin > 0.18 ? 'green' : m.margin.margin > 0.1 ? 'amber' : 'red'

  return (
    <>
      <MTopBar back title="Estimate" sub={summary.project.name} onBack={() => navigate(`/projects/${projectId}`)} />
      <MBody>
        {/* Price hero: MARGIN big-number + accent SELL TOTAL big-number. */}
        <MKpiRow cols={2}>
          <MKpi label="Margin" value={marginPct} meta={formatMoney(m.margin.profit)} metaTone={marginTone} />
          <div
            className="m-kpi"
            style={{ background: 'var(--m-accent)', color: 'var(--m-accent-ink)', marginLeft: -2 }}
          >
            <div className="m-kpi-eyebrow" style={{ color: 'var(--m-accent-ink)', opacity: 0.7 }}>
              Sell total
            </div>
            <div
              className="num"
              style={{
                fontFamily: 'var(--m-font-display)',
                fontSize: 38,
                fontWeight: 800,
                letterSpacing: '-0.035em',
                marginTop: 6,
                lineHeight: 0.85,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatMoney(liveTotal)}
            </div>
          </div>
        </MKpiRow>

        <div style={{ padding: '0 16px', marginTop: 12 }}>
          <MAiStripe
            eyebrow="Bid accuracy"
            title="This estimate is in line with comparable jobs"
            attribution={
              <>
                Based on <strong>historical close rate</strong>.
              </>
            }
          >
            Labor cost {formatMoney(m.laborCost)} · materials {formatMoney(m.materialCost)} · subs{' '}
            {formatMoney(m.subCost)}.
          </MAiStripe>
        </div>

        {builder.error ? (
          <div style={{ padding: '0 16px', marginTop: 12 }}>
            <MBanner
              tone={builder.conflict ? 'warn' : 'error'}
              title={builder.conflict ? 'Estimate refreshed' : 'Could not save'}
              body={
                builder.conflict
                  ? 'Another device changed this estimate while you were editing — your view has been refreshed.'
                  : builder.error
              }
              action={
                <MButton variant="ghost" size="sm" onClick={() => builder.dismissError()}>
                  Dismiss
                </MButton>
              }
            />
          </div>
        ) : null}

        <MSectionH>{builder.isSaving ? 'Line items · saving…' : 'Line items'}</MSectionH>
        {summaryLines.length === 0 && editableLines.length === 0 ? (
          <div style={{ padding: '0 16px', color: 'var(--m-ink-3)', fontSize: 13 }}>
            No line items yet. Run takeoff first, then recompute the estimate.
          </div>
        ) : (
          <>
            <EstimateScopeTree lines={summaryLines.length > 0 ? summaryLines : editableLines} />
            <MSectionH>Builder</MSectionH>
            {builder.isLoading && editableLines.length === 0 ? (
              <MSkeletonList count={3} />
            ) : (
              <MListInset>
                {editableLines.map((line) => (
                  <EstimateLineEditor
                    key={line.id}
                    line={line}
                    pending={builder.pendingEdits[line.service_item_code] ?? null}
                    onEdit={builder.editLine}
                  />
                ))}
              </MListInset>
            )}
          </>
        )}

        {/* CLIENT SEES — square pills summarizing what lands on the share. */}
        <MSectionH>Client sees</MSectionH>
        <div style={{ padding: '0 16px 4px', display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Sell total</span>
            <span className="num" style={{ fontSize: 15, fontWeight: 700 }}>
              {formatMoney(liveTotal)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Line items</span>
            <MPill tone="accent">{editableLines.length} priced</MPill>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Margin</span>
            <MPill tone={marginTone}>{marginPct} hidden</MPill>
          </div>
        </div>

        {createError ? (
          <div style={{ padding: '0 16px', color: 'var(--m-red)', fontSize: 13 }}>{createError}</div>
        ) : null}
        <div style={{ padding: 16 }}>
          <MButtonStack>
            <MButton
              variant="primary"
              onClick={handleSendToClient}
              disabled={creatingPush || builder.hasDirtyEdits || builder.isSaving || editableLines.length === 0}
            >
              {creatingPush
                ? 'Drafting…'
                : builder.hasDirtyEdits || builder.isSaving
                  ? 'Saving edits…'
                  : 'Send to client'}
            </MButton>
            <MButton variant="ghost" onClick={() => navigate(`/projects/${projectId}`)}>
              Back to project
            </MButton>
          </MButtonStack>
        </div>
      </MBody>
    </>
  )
}

/**
 * One editable estimate line: quantity + rate inputs with a live amount.
 * Edits stage on the builder machine (keyed on service_item_code); the
 * screen's debounced SAVE flushes them through PATCH /api/estimate-lines/:id.
 */
function EstimateLineEditor({
  line,
  pending,
  onEdit,
}: {
  line: EstimateLine
  pending: { quantity?: number; override_rate?: number | null } | null
  onEdit: (edit: { service_item_code: string; quantity?: number; override_rate?: number | null }) => void
}) {
  const [qtyDraft, setQtyDraft] = useState<string>(() => formatNum(line.quantity))
  const [rateDraft, setRateDraft] = useState<string>(() => formatNum(line.rate))

  // Re-sync from the snapshot when a save lands (no pending edit in flight),
  // so a recompute / conflict-reload repaints the inputs.
  useEffect(() => {
    if (!pending) {
      setQtyDraft(formatNum(line.quantity))
      setRateDraft(formatNum(line.rate))
    }
  }, [line.quantity, line.rate, pending])

  const qty = pending?.quantity ?? Number(line.quantity)
  const rate = pending?.override_rate ?? Number(line.rate)
  const amount = (Number.isFinite(qty) ? qty : 0) * (Number.isFinite(rate) ? rate : 0)

  return (
    <div style={{ padding: '10px 16px', borderTop: '1px solid var(--m-line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <MI.FileText size={18} />
        <div style={{ minWidth: 0, flex: 1, fontSize: 14, fontWeight: 600 }}>{line.service_item_code}</div>
        <span className="num" style={{ fontSize: 14, fontWeight: 600 }}>
          {formatMoney(amount)}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <label style={{ flex: 1, fontSize: 11, color: 'var(--m-ink-3)' }}>
          Qty ({line.unit})
          <MInput
            type="number"
            inputMode="decimal"
            step="0.01"
            aria-label={`quantity for ${line.service_item_code}`}
            value={qtyDraft}
            onChange={(e) => {
              setQtyDraft(e.target.value)
              const next = Number(e.target.value)
              if (Number.isFinite(next)) onEdit({ service_item_code: line.service_item_code, quantity: next })
            }}
          />
        </label>
        <label style={{ flex: 1, fontSize: 11, color: 'var(--m-ink-3)' }}>
          Rate
          <MInput
            type="number"
            inputMode="decimal"
            step="0.01"
            aria-label={`rate for ${line.service_item_code}`}
            value={rateDraft}
            onChange={(e) => {
              setRateDraft(e.target.value)
              const next = Number(e.target.value)
              if (Number.isFinite(next)) onEdit({ service_item_code: line.service_item_code, override_rate: next })
            }}
          />
        </label>
      </div>
      {pending ? (
        <div style={{ fontSize: 11, color: 'var(--m-accent)', marginTop: 4 }}>Edited · saving shortly</div>
      ) : null}
    </div>
  )
}

function formatNum(raw: string | number): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return '0'
  return String(n)
}

type ScopeTreeLine = { service_item_code: string; amount: string }

function EstimateScopeTree({ lines }: { lines: ScopeTreeLine[] }) {
  const groups = new Map<string, { count: number; amount: number }>()
  for (const line of lines) {
    const group = line.service_item_code.split(/[-_.]/)[0] || line.service_item_code
    const cur = groups.get(group) ?? { count: 0, amount: 0 }
    cur.count += 1
    cur.amount += Number(line.amount ?? 0)
    groups.set(group, cur)
  }

  return (
    <>
      <MSectionH>Scope tree</MSectionH>
      <div>
        {Array.from(groups.entries()).map(([group, value]) => (
          <div
            key={group}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '14px 16px',
              borderTop: '1px solid var(--m-line-2)',
            }}
          >
            {/* Status bar — square accent rule on the leading edge. */}
            <div style={{ width: 6, alignSelf: 'stretch', background: 'var(--m-accent)' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 15 }}>{group}</div>
              <div className="m-quiet-sm">{value.count} line items</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div
                className="num"
                style={{
                  fontFamily: 'var(--m-font-display)',
                  fontWeight: 800,
                  fontSize: 22,
                  lineHeight: 1,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatMoney(value.amount)}
              </div>
              <div style={{ marginTop: 4 }}>
                <MPill tone="accent">priced</MPill>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
