/**
 * `mb-takeoff-ai-count` — mobile AI auto-count setup + review.
 *
 * Ported from Steve's v2 master-flow mockup `V2AICountSetup` ("COUNT · SETUP")
 * and `V2EstAutoCountReview` ("COUNT · REVIEW") for MOBILE. Two route-able
 * screens:
 *   - TakeoffAiCountSetup  — confirm the tapped symbol, pick match sensitivity,
 *     and choose which sheets to scan, then RUN. → review.
 *   - TakeoffAiCountReview — hero count + canvas with the detected marks +
 *     a J/K/Y/N (tap keep/reject) review lane for the low-confidence flags.
 *
 * WIRED to the real capture pipeline. RUN posts to the takeoff-drafts capture
 * endpoint (kind=blueprint_vision, dry-run-safe JSON payload — no Anthropic
 * spend) and routes to REVIEW with the real draft id; REVIEW reads the draft's
 * stored TakeoffResult and promotes the kept quantities to committed
 * `takeoff_measurements`.
 *
 * GAP: the pipeline produces whole-draft quantities, not a per-symbol count
 * keyed to the tapped symbol. The symbol/sensitivity/sheet-scope controls stay
 * presentational; REVIEW shows the captured quantities as the "found" set with
 * a keep/reject lane. A dedicated single-symbol auto-count endpoint is a GAP.
 */
import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { MBanner, MButton, MI, MPill, Spark } from '../../components/m/index.js'
import {
  useCaptureTakeoffDraft,
  usePromoteCapturedQuantities,
  useTakeoffDraftResult,
  useTakeoffDrafts,
  type CapturedQuantity,
} from '../../lib/api/takeoff-drafts.js'

type Sensitivity = 'STRICT' | 'NORMAL' | 'LOOSE'

// Demo-data notice (C1, takeoff deep-dive 2026-06-01). RUN posts
// `payload: { dryRun: true }` with a JSON body and never streams a PDF, so this
// flow ALWAYS returns deterministic demo/stub quantities, never a real AI
// symbol read. The review surface always carries an explicit demo banner so a
// stub count can never be mistaken for a real read and submitted in a bid.
// Follow-up: wire the live multipart Claude-vision path (out of scope here).
const DEMO_BADGE_TITLE = 'DEMO DATA · NOT A REAL AI SYMBOL COUNT'
const DEMO_BADGE_BODY =
  'This count is placeholder demo data, not detected from your sheets. Do not submit it in a bid — verify every mark against the real drawing first.'

const eyebrow: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--m-ink-3)',
}

const sectionBar: React.CSSProperties = {
  padding: '10px 20px',
  background: 'var(--m-card-soft)',
  borderTop: '2px solid var(--m-ink)',
  borderBottom: '2px solid var(--m-ink)',
}

function CountAppBar({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="m-topbar">
      <button type="button" className="m-topbar-back" aria-label="Back" onClick={onBack}>
        <MI.ChevLeft size={22} />
      </button>
      <div className="m-topbar-title">
        <div className="m-topbar-eyebrow" data-tone="accent" style={{ display: 'inline-flex', gap: 5 }}>
          <Spark size={11} state="strong" /> AI · AUTO-COUNT
        </div>
        <div className="m-h1">{title}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Setup — symbol confirm + sensitivity + sheet scope + RUN.
// ---------------------------------------------------------------------------
type ScanSheet = { code: string; label: string; on: boolean; dim?: boolean; sub?: string }

const SCAN_SHEETS: ScanSheet[] = [
  { code: 'M-101', label: 'M-101 · MECH PLAN', on: true },
  { code: 'M-102', label: 'M-102 · MECH UPPER', on: true },
  { code: 'M-103', label: 'M-103 · MECH LOWER', on: true },
  { code: 'M-104', label: 'M-104 · MECH ROOF', on: true },
  { code: 'A-201', label: 'A-201 · EAST ELEV.', on: false, dim: true, sub: 'NOT A MECH SHEET' },
]

export function TakeoffAiCountSetup({ companySlug }: { companySlug: string }) {
  void companySlug
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  const [sensitivity, setSensitivity] = useState<Sensitivity>('NORMAL')
  const [sheets, setSheets] = useState<ScanSheet[]>(SCAN_SHEETS)
  const capture = useCaptureTakeoffDraft(projectId)

  const toggleSheet = (code: string) =>
    setSheets((prev) => prev.map((s) => (s.code === code && !s.dim ? { ...s, on: !s.on } : s)))
  const scanCount = sheets.filter((s) => s.on).length

  const run = () => {
    if (!projectId || capture.isPending) return
    // Dry-run-safe capture (JSON body → deterministic stub on the API; no
    // live Anthropic spend). Carries the real draft id into the review lane.
    capture.mutate(
      { kind: 'blueprint_vision', name: 'AI auto-count', payload: { dryRun: true } },
      {
        onSuccess: (res) =>
          navigate(`/projects/${projectId}/takeoff-ai/count/review`, { state: { draftId: res.draft.id } }),
      },
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <CountAppBar title="TAP A SYMBOL" onBack={() => navigate(`/projects/${projectId}/takeoff-ai`)} />

      {/* Tapped symbol */}
      <div style={{ padding: '24px 20px', borderBottom: '2px solid var(--m-ink)' }}>
        <div style={eyebrow}>TAPPED · A-104 SHEET</div>
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 14 }}>
          <span
            style={{
              width: 64,
              height: 64,
              background: 'var(--m-accent)',
              border: '2px solid var(--m-ink)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 24,
              flexShrink: 0,
            }}
            aria-hidden
          >
            ◯
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 16 }}>
              DIFFUSER · 24&quot; ROUND
            </div>
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                color: 'var(--m-ink-3)',
                marginTop: 4,
                fontWeight: 600,
              }}
            >
              OR: <span style={{ textDecoration: 'underline' }}>PICK DIFFERENT</span>
            </div>
          </div>
        </div>
      </div>

      {/* Sensitivity */}
      <div style={sectionBar}>
        <div className="m-topbar-eyebrow">MATCH SENSITIVITY</div>
      </div>
      <div style={{ padding: '18px 20px', borderBottom: '2px solid var(--m-ink)' }}>
        <div style={{ display: 'flex', border: '2px solid var(--m-ink)' }}>
          {(['STRICT', 'NORMAL', 'LOOSE'] as const).map((s, i, arr) => {
            const on = sensitivity === s
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSensitivity(s)}
                aria-pressed={on}
                style={{
                  flex: 1,
                  padding: '16px 0',
                  background: on ? 'var(--m-accent)' : 'transparent',
                  color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                  border: 'none',
                  borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  cursor: 'pointer',
                }}
              >
                {s}
              </button>
            )
          })}
        </div>
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            color: 'var(--m-ink-3)',
            marginTop: 10,
            fontWeight: 600,
            lineHeight: 1.45,
          }}
        >
          NORMAL = HIGH-CONF AUTO + REVIEW THE EDGES.
        </div>
      </div>

      {/* Sheet scope */}
      <div style={sectionBar}>
        <div className="m-topbar-eyebrow">SCAN WHICH SHEETS</div>
      </div>
      <div style={{ padding: '14px 20px' }}>
        {sheets.map((s, i) => (
          <button
            key={s.code}
            type="button"
            onClick={() => toggleSheet(s.code)}
            disabled={s.dim}
            aria-pressed={s.on}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '12px 0',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              background: 'transparent',
              border: 'none',
              borderBottom: i < sheets.length - 1 ? '1px solid var(--m-line-2)' : 'none',
              cursor: s.dim ? 'default' : 'pointer',
            }}
          >
            <span
              style={{
                width: 20,
                height: 20,
                background: s.on ? 'var(--m-accent)' : 'transparent',
                border: '2px solid var(--m-ink)',
                opacity: s.dim ? 0.4 : 1,
                flexShrink: 0,
              }}
              aria-hidden
            />
            <span style={{ flex: 1, minWidth: 0, opacity: s.dim ? 0.4 : 1 }}>
              <span style={{ display: 'block', fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700 }}>
                {s.label}
              </span>
              {s.sub ? (
                <span
                  style={{
                    display: 'block',
                    fontFamily: 'var(--m-num)',
                    fontSize: 9,
                    color: 'var(--m-ink-3)',
                    marginTop: 3,
                    fontWeight: 600,
                  }}
                >
                  {s.sub}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>

      <div style={{ flex: 1 }} />
      <div style={{ padding: '14px 20px 18px', borderTop: '2px solid var(--m-ink)' }}>
        {capture.isError ? (
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--m-red)',
              marginBottom: 10,
            }}
          >
            ● {capture.error.message || 'Capture failed — try again.'}
          </div>
        ) : null}
        <MButton variant="primary" onClick={run} disabled={capture.isPending || scanCount === 0}>
          {capture.isPending ? 'Scanning…' : `Run demo · ${scanCount} sheet${scanCount === 1 ? '' : 's'} · stub`}
        </MButton>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Review — hero count (real captured quantity total) + keep/reject lane over
// the captured quantities, then promote the kept ones.
// ---------------------------------------------------------------------------
function confidenceLabel(confidence: number): 'HIGH' | 'MED' | 'LOW' {
  if (confidence >= 0.8) return 'HIGH'
  if (confidence >= 0.5) return 'MED'
  return 'LOW'
}

function formatQty(value: number, unit: string): string {
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100
  return `${rounded.toLocaleString()} ${unit.toUpperCase()}`
}

/**
 * Resolve the draft id to review: prefer the one handed over by the setup
 * screen via navigation state; otherwise fall back to the most-recent
 * capture-sourced draft for the project (covers deep-links / refresh).
 */
function useCountReviewDraftId(projectId: string): string | null {
  const location = useLocation()
  const stateDraftId =
    location.state && typeof location.state === 'object' && 'draftId' in location.state
      ? String((location.state as { draftId?: unknown }).draftId ?? '')
      : ''
  const draftsQuery = useTakeoffDrafts(stateDraftId ? null : projectId)
  if (stateDraftId) return stateDraftId
  const latestCapture = (draftsQuery.data?.drafts ?? []).filter((d) => d.source && d.source !== 'manual').at(-1)
  return latestCapture?.id ?? null
}

export function TakeoffAiCountReview({ companySlug }: { companySlug: string }) {
  void companySlug
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  const draftId = useCountReviewDraftId(projectId)
  const resultQuery = useTakeoffDraftResult(draftId)
  const promote = usePromoteCapturedQuantities(projectId, draftId)

  const quantities = useMemo<CapturedQuantity[]>(
    () => resultQuery.data?.takeoff_result.quantities ?? [],
    [resultQuery.data],
  )

  // Per-quantity keep/reject decisions, keyed by quantity id. Default keep.
  const [rejected, setRejected] = useState<Record<string, boolean>>({})
  const [active, setActive] = useState(0)
  const keep = (id: string, isKept: boolean) => setRejected((prev) => ({ ...prev, [id]: !isKept }))

  const confidenceBuckets = useMemo(() => {
    return quantities.reduce(
      (acc, q) => {
        acc[confidenceLabel(q.confidence)] += 1
        return acc
      },
      { HIGH: 0, MED: 0, LOW: 0 },
    )
  }, [quantities])

  const rejectedCount = useMemo(() => quantities.filter((q) => rejected[q.id]).length, [quantities, rejected])
  const keptIds = useMemo(() => quantities.filter((q) => !rejected[q.id]).map((q) => q.id), [quantities, rejected])
  const total = quantities.length

  const approve = () => {
    if (!draftId || keptIds.length === 0 || promote.isPending) return
    promote.mutate({ quantity_ids: keptIds }, { onSuccess: () => navigate(`/projects/${projectId}/takeoff-mobile`) })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <CountAppBar title="REVIEW COUNT" onBack={() => navigate(`/projects/${projectId}/takeoff-ai/count`)} />

      {/* Hero count slab */}
      <div style={{ padding: 20, background: 'var(--m-ink)', color: 'var(--m-sand)' }}>
        <div className="m-topbar-eyebrow" style={{ color: 'var(--m-amber)' }}>
          DEMO · {resultQuery.data?.source ? resultQuery.data.source.toUpperCase() : 'AI DETECTED'} · STUB
        </div>
        <div
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 800,
            fontSize: 72,
            lineHeight: 0.9,
            letterSpacing: '-0.035em',
            marginTop: 6,
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--m-sand)',
          }}
        >
          {resultQuery.isLoading ? '…' : total - rejectedCount}
          <span style={{ fontSize: 24, color: 'var(--m-ink-4)', marginLeft: 6 }}> KEPT</span>
        </div>
        <div
          style={{ fontFamily: 'var(--m-num)', fontSize: 12, marginTop: 8, color: 'var(--m-ink-4)', fontWeight: 600 }}
        >
          HIGH {confidenceBuckets.HIGH} · MED {confidenceBuckets.MED} · LOW {confidenceBuckets.LOW}
        </div>
      </div>

      <div style={{ padding: '14px 20px 0' }}>
        <MBanner tone="warn" icon={<MI.AlertTri size={18} />} title={DEMO_BADGE_TITLE} body={DEMO_BADGE_BODY} />
      </div>

      {/* Keep/reject lane over the captured quantities */}
      <div
        style={{
          padding: '10px 20px',
          background: 'var(--m-ink)',
          color: 'var(--m-accent)',
          borderTop: '2px solid var(--m-ink)',
          fontFamily: 'var(--m-num)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.04em',
        }}
      >
        TAP A ROW · Y KEEP · N REJECT
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {resultQuery.isError ? (
          <div
            style={{ padding: 20, fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-red)', fontWeight: 600 }}
          >
            Couldn&apos;t load the count result. {resultQuery.error.message}
          </div>
        ) : null}
        {!resultQuery.isLoading && !resultQuery.isError && quantities.length === 0 ? (
          <div
            style={{ padding: 20, fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-ink-3)', fontWeight: 600 }}
          >
            {draftId ? 'This draft has no detected quantities.' : 'Run the count to produce a draft.'}
          </div>
        ) : null}
        {quantities.map((q, i) => {
          const on = i === active
          const isKept = !rejected[q.id]
          return (
            <div
              key={q.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 20px',
                borderBottom: '1px solid var(--m-line-2)',
                background: on ? 'var(--m-accent-soft)' : 'transparent',
                opacity: isKept ? 1 : 0.45,
              }}
            >
              <button
                type="button"
                onClick={() => setActive(i)}
                aria-pressed={on}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  background: 'transparent',
                  border: 'none',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{ width: 8, height: 8, background: isKept ? 'var(--m-accent)' : 'var(--m-red)' }}
                  aria-hidden
                />
                <span style={{ flex: 1, fontFamily: 'var(--m-num)', fontSize: 12, fontWeight: 700, minWidth: 0 }}>
                  {q.description || q.masterformatCode || q.id} · {formatQty(q.value, q.unit)}
                </span>
                <MPill
                  tone={
                    confidenceLabel(q.confidence) === 'HIGH'
                      ? 'green'
                      : confidenceLabel(q.confidence) === 'MED'
                        ? 'amber'
                        : 'red'
                  }
                >
                  {confidenceLabel(q.confidence)}
                </MPill>
              </button>
              <button
                type="button"
                onClick={() => keep(q.id, true)}
                aria-label={`Keep ${q.id}`}
                style={{
                  padding: '6px 12px',
                  background: isKept ? 'var(--m-green)' : 'transparent',
                  color: isKept ? '#fff' : 'var(--m-ink-3)',
                  border: '2px solid var(--m-ink)',
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Y
              </button>
              <button
                type="button"
                onClick={() => keep(q.id, false)}
                aria-label={`Reject ${q.id}`}
                style={{
                  padding: '6px 12px',
                  background: !isKept ? 'var(--m-red)' : 'transparent',
                  color: !isKept ? '#fff' : 'var(--m-ink-3)',
                  border: '2px solid var(--m-ink)',
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                N
              </button>
            </div>
          )
        })}
      </div>

      {promote.isError ? (
        <div
          style={{
            padding: '10px 20px',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--m-red)',
            borderTop: '2px solid var(--m-ink)',
          }}
        >
          ● {promote.error.message || 'Promote failed — try again.'}
        </div>
      ) : null}
      <div style={{ padding: '14px 20px', display: 'flex', gap: 8, borderTop: '2px solid var(--m-ink)' }}>
        <MButton
          variant="ghost"
          onClick={() => navigate(`/projects/${projectId}/takeoff-ai/count`)}
          style={{ flex: 1 }}
        >
          Re-run
        </MButton>
        <MButton
          variant="primary"
          onClick={approve}
          disabled={promote.isPending || keptIds.length === 0 || !draftId}
          style={{ flex: 2 }}
        >
          {promote.isPending ? 'Promoting…' : `Approve ${keptIds.length}`}
        </MButton>
      </div>
    </div>
  )
}
