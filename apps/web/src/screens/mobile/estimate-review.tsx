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
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet, getActiveCompanySlug, type ProjectSummary } from '@/lib/api'
import { useCustomers } from '@/lib/api/customers'
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
  MPill,
  MListInset,
  MSectionH,
  MTextarea,
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
  // Margin control (the design's slider + −/+ stepper). Drives a live sell-total
  // preview off the internal cost basis. Margin isn't a persisted field, so this
  // is a presentation control: it never writes back, it lets the operator see
  // what the sell total would be at a chosen margin before sending.
  const [marginOverride, setMarginOverride] = useState<number | null>(null)
  // Send-to-client confirmation sheet (the design's full-screen SEND TO CLIENT
  // sheet). The send no longer fires immediately on tap — it opens this sheet.
  const [showSendSheet, setShowSendSheet] = useState(false)
  const [sendNote, setSendNote] = useState('')

  // Editable line list + totals. The machine owns the scope-vs-bid
  // snapshot (whose lines carry `id`), staged edits, and save/conflict UI
  // state. The summary above stays the source for KPIs / AI stripe.
  const builder = useEstimateBuilder(projectId, getActiveCompanySlug())

  // Client identity for the SELL TOTAL · TO <name> qualifier + the send sheet.
  const customersQuery = useCustomers()
  const client = useMemo(() => {
    const all = customersQuery.data?.customers ?? []
    return all.find((c) => c.id === summary?.project.customer_id) ?? null
  }, [customersQuery.data?.customers, summary?.project.customer_id])

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

  // Step 1: open the confirmation sheet (client card + attachment + note).
  const handleSendToClient = () => {
    if (!projectId) return
    setCreateError(null)
    setShowSendSheet(true)
  }

  // Step 2: from inside the sheet, snapshot the estimate into a push and hop
  // to the estimate-push review (which drives the QBO workflow).
  const confirmSend = async () => {
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
  // Live priced total: prefer the machine snapshot (updates as edits save)
  // and fall back to the summary metric before the snapshot loads.
  const liveTotal = builder.snapshot?.scope_total ?? m.estimateTotal

  // Internal cost basis (the design's "YOUR COST · INTERNAL" hero). totalCost
  // already folds materials + labor + subs (+ any burden) on the server.
  const costBasis = m.totalCost

  // Margin: the actual computed margin from the priced estimate, or the
  // operator's slider override. Clamped to the design's 0–50% track.
  const computedMargin = Number.isFinite(m.margin.margin) ? m.margin.margin : 0
  const marginValue = marginOverride ?? computedMargin
  const marginClamped = Math.min(0.5, Math.max(0, marginValue))
  const marginPct = `${Math.round(marginClamped * 100)}%`
  const marginTone: 'green' | 'amber' | 'red' = marginClamped > 0.18 ? 'green' : marginClamped > 0.1 ? 'amber' : 'red'

  // Sell total. When the operator hasn't touched the slider we show the real
  // priced total; once they move it, preview sell = cost / (1 − margin),
  // rounded up to the nearest $10 (matching the design's "ROUNDED UP" line).
  const rawSell = marginOverride === null ? liveTotal : marginClamped < 1 ? costBasis / (1 - marginClamped) : liveTotal
  const sellTotal = Math.ceil(rawSell / 10) * 10
  const roundingDelta = sellTotal - rawSell
  const profit = sellTotal - costBasis
  const clientLabel = client?.name ?? summary.project.customer_name ?? ''
  const clientFirstName = clientLabel.trim().split(/\s+/)[0] ?? ''

  const stepMargin = (delta: number) => {
    const base = marginOverride ?? computedMargin
    const next = Math.min(0.5, Math.max(0, Math.round((base + delta) * 100) / 100))
    setMarginOverride(next)
  }

  return (
    <>
      <MTopBar back title="Estimate" sub={summary.project.name} onBack={() => navigate(`/projects/${projectId}`)} />
      <MBody>
        {/* YOUR COST · INTERNAL — internal cost-basis hero above margin. */}
        <div style={{ padding: '20px 16px 16px', borderBottom: '2px solid var(--m-ink)' }}>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
            }}
          >
            Your cost · internal
          </div>
          <div
            className="num"
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 44,
              lineHeight: 0.9,
              letterSpacing: '-0.035em',
              marginTop: 8,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatMoney(costBasis)}
          </div>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
              marginTop: 8,
            }}
          >
            Materials + labor + rentals + burden
          </div>
        </div>

        {/* MARGIN — interactive 0–50% slider + −/+ stepper driving the preview. */}
        <MarginControl
          marginPct={marginPct}
          value={marginClamped}
          tone={marginTone}
          onSlide={(v) => setMarginOverride(v)}
          onStep={stepMargin}
        />

        {/* SELL TOTAL · TO <client> — accent block + profit/cost/rounding line. */}
        <div style={{ background: 'var(--m-accent)', color: 'var(--m-accent-ink)', padding: '18px 16px' }}>
          {/* Dark inverted chip — the design's black "SELL TOTAL · TO JOHN" label on yellow. */}
          <span
            style={{
              display: 'inline-block',
              background: 'var(--m-ink)',
              color: 'var(--m-accent)',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              padding: '4px 8px',
            }}
          >
            {clientLabel ? `Sell total · to ${clientFirstName || clientLabel}` : 'Sell total'}
          </span>
          <div
            className="num"
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 46,
              lineHeight: 0.85,
              letterSpacing: '-0.035em',
              marginTop: 10,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatMoney(sellTotal)}
          </div>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              marginTop: 10,
            }}
          >
            Profit {formatMoney(profit)} · Cost {formatMoney(costBasis)}
            {roundingDelta >= 1 ? ` · Rounded up ${formatMoney(roundingDelta)}` : ''}
          </div>
        </div>

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
              {formatMoney(sellTotal)}
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

        {createError && !showSendSheet ? (
          <div style={{ padding: '0 16px', color: 'var(--m-red)', fontSize: 13 }}>{createError}</div>
        ) : null}
        <div style={{ padding: 16 }}>
          <MButtonStack>
            <MButton
              variant="primary"
              onClick={handleSendToClient}
              disabled={creatingPush || builder.hasDirtyEdits || builder.isSaving || editableLines.length === 0}
            >
              {builder.hasDirtyEdits || builder.isSaving ? 'Saving edits…' : 'Send to client'}
            </MButton>
            <MButton variant="ghost" onClick={() => navigate(`/projects/${projectId}`)}>
              Back to project
            </MButton>
          </MButtonStack>
        </div>
      </MBody>

      {showSendSheet ? (
        <SendToClientSheet
          clientName={clientLabel || 'Client'}
          clientFirstName={clientFirstName || clientLabel || 'client'}
          clientCompany={client?.source ?? null}
          fileName={`${slugifyFile(summary.project.name)}.pdf`}
          lineCount={editableLines.length}
          note={sendNote}
          onNoteChange={setSendNote}
          sending={creatingPush}
          error={createError}
          onSend={confirmSend}
          onClose={() => {
            if (!creatingPush) setShowSendSheet(false)
          }}
        />
      ) : null}
    </>
  )
}

// "Hillcrest Mews Phase 4" → "hillcrest-mews-phase-4". Used to derive the
// deliverable filename shown in the send sheet (the design's HILLCREST-PH4-TO).
function slugifyFile(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'estimate'
}

/**
 * MARGIN control — the design's big-% readout, −/+ stepper pair, and a 0–50%
 * slider track. Pure presentation over the cost basis: sliding previews the
 * sell total upstream; it never persists (margin isn't a stored field).
 */
function MarginControl({
  marginPct,
  value,
  tone,
  onSlide,
  onStep,
}: {
  marginPct: string
  value: number
  tone: 'green' | 'amber' | 'red'
  onSlide: (v: number) => void
  onStep: (delta: number) => void
}) {
  return (
    <div style={{ padding: '18px 16px', borderBottom: '2px solid var(--m-ink)' }}>
      <div
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--m-ink-3)',
        }}
      >
        Margin
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 8 }}>
        <div
          className="num"
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 800,
            fontSize: 44,
            lineHeight: 0.9,
            letterSpacing: '-0.035em',
            color: tone === 'red' ? 'var(--m-red)' : 'var(--m-ink)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {marginPct}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <MButton variant="ghost" size="sm" onClick={() => onStep(-0.01)} aria-label="decrease margin">
            −
          </MButton>
          <MButton variant="primary" size="sm" onClick={() => onStep(0.01)} aria-label="increase margin">
            +
          </MButton>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={50}
        step={1}
        value={Math.round(value * 100)}
        aria-label="margin percent"
        onChange={(e) => onSlide(Number(e.target.value) / 100)}
        style={{ width: '100%', marginTop: 14, accentColor: 'var(--m-accent)' }}
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: 'var(--m-num)',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.04em',
          color: 'var(--m-ink-3)',
          marginTop: 4,
        }}
      >
        <span>0%</span>
        <span>20%</span>
        <span>50%</span>
      </div>
    </div>
  )
}

/**
 * SEND TO CLIENT sheet — the design's full-screen confirmation: client
 * identity card, an attaching row (filename + size + line-item count), an
 * optional note, the private-share-link explainer, and a SEND · NOTIFY
 * <name> commit. The actual estimate-push create happens on send.
 */
function SendToClientSheet({
  clientName,
  clientFirstName,
  clientCompany,
  fileName,
  lineCount,
  note,
  onNoteChange,
  sending,
  error,
  onSend,
  onClose,
}: {
  clientName: string
  clientFirstName: string
  clientCompany: string | null
  fileName: string
  lineCount: number
  note: string
  onNoteChange: (v: string) => void
  sending: boolean
  error: string | null
  onSend: () => void
  onClose: () => void
}) {
  const initials = clientName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
  return (
    <div
      role="dialog"
      aria-label="Send to client"
      style={{ position: 'fixed', inset: 0, background: 'var(--m-sand)', zIndex: 60, overflowY: 'auto' }}
    >
      <MTopBar
        title="Send to client"
        eyebrow="SHARE"
        actionLabel="Close"
        actionIcon={<MI.X size={20} />}
        onAction={onClose}
      />
      <MBody>
        {/* Client identity card */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '16px',
            borderBottom: '2px solid var(--m-ink)',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 52,
              height: 52,
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--m-ink)',
              color: 'var(--m-sand)',
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 18,
            }}
          >
            {initials || '—'}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="m-quiet-sm" style={{ fontFamily: 'var(--m-num)', letterSpacing: '0.06em' }}>
              CLIENT
            </div>
            <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 18, lineHeight: 1.1 }}>
              {clientName}
            </div>
            {clientCompany ? (
              <div
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: 'var(--m-ink-3)',
                  marginTop: 2,
                }}
              >
                {clientCompany}
              </div>
            ) : null}
          </div>
        </div>

        {/* Attaching row — the deliverable PDF + size + line-item count */}
        <MSectionH>Attaching</MSectionH>
        <div style={{ padding: '0 16px 4px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              border: '2px solid var(--m-ink)',
              padding: '12px 14px',
            }}
          >
            <span
              aria-hidden
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 40,
                height: 40,
                border: '1.5px solid var(--m-ink)',
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                fontWeight: 700,
              }}
            >
              PDF
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 14, wordBreak: 'break-word' }}
              >
                {fileName.toUpperCase()}
              </div>
              <div className="m-quiet-sm" style={{ fontFamily: 'var(--m-num)', letterSpacing: '0.04em' }}>
                {lineCount} LINE {lineCount === 1 ? 'ITEM' : 'ITEMS'}
              </div>
            </div>
          </div>
        </div>

        {/* Optional note */}
        <MSectionH>Note (optional)</MSectionH>
        <div style={{ padding: '0 16px 4px' }}>
          <MTextarea
            rows={3}
            placeholder={`${clientFirstName} — takeoff finished. ${lineCount} line ${
              lineCount === 1 ? 'item' : 'items'
            }, all sheets verified. Estimate to follow.`}
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            aria-label="note to client"
          />
        </div>

        <div
          style={{
            padding: '8px 16px 0',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.03em',
            color: 'var(--m-ink-3)',
            lineHeight: 1.5,
          }}
        >
          → GENERATES A PRIVATE SHARE LINK. AUTO-ATTACHES THE DELIVERABLE TO {clientFirstName.toUpperCase()}&apos;S
          PROFILE.
        </div>

        {error ? <div style={{ padding: '8px 16px 0', color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}

        <div style={{ padding: 16 }}>
          <MButtonStack>
            <MButton variant="primary" onClick={onSend} disabled={sending}>
              {sending ? 'Sending…' : `Send · notify ${clientFirstName}`}
            </MButton>
            <MButton variant="ghost" onClick={onClose} disabled={sending}>
              Cancel
            </MButton>
          </MButtonStack>
        </div>
      </MBody>
    </div>
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
