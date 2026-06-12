/**
 * `takeoff-ai-takeoff` — RESPONSIVE AI auto-takeoff setup + review.
 *
 * Phase B of the responsive consolidation (docs/RESPONSIVE_CONSOLIDATION_ANALYSIS.md):
 * this single screen replaces the former desktop twin `screens/desktop/est-ai-takeoff.tsx`
 * and the mobile `screens/mobile/takeoff-ai-takeoff.tsx`. It renders the MOBILE
 * app-bar layout by default and the DESKTOP floating-palette / DataTable layout at
 * the Tailwind `lg:` (≥1024px) breakpoint. The data + capture layer is shared
 * verbatim — the merge is layout-only.
 *
 * Two route-able screens (each reachable from BOTH the `/desktop/*` route table
 * and the `/projects/*` mobile route table — `useNavFamily` keeps each tree's
 * own navigation targets):
 *   - TakeoffAiTakeoffSetup  — choose symbol→item targets + sheet scope, then RUN
 *     the AI auto-takeoff. → review.
 *   - TakeoffAiTakeoffReview — keep/drop AND edit the AI-detected quantities
 *     (per-row service_item_code override), then ACCEPT DRAFT (promote the kept
 *     rows to committed `takeoff_measurements`). Edits ride along as the promote
 *     endpoint's `service_item_code_overrides` map; the server runs each override
 *     through the same curated-catalog gate as a manual takeoff write, so a code
 *     that isn't in `service_item_divisions` comes back as a 422 `rejected[]`
 *     (the offending input is highlighted inline). Rows the server couldn't
 *     promote on a 2xx (missing unit / no derivable code) come back as
 *     `skipped[]` and are summarized in the footer instead of navigating away.
 *
 * WIRED to the real capture pipeline. There are two RUN paths (preserved from the
 * desktop twin — the mobile twin only had the dry-run path; the merge gives mobile
 * the live path too, additively):
 *   - LIVE (ASYNC since 2026-06-12): when the API reports live mode is available
 *     (Gemini prod default or env-gated Anthropic, surfaced via /api/features) AND
 *     the project has a blueprint document, the screen downloads that blueprint PDF
 *     and streams it as multipart/form-data. The API answers 202 with
 *     result_summary.status='processing' and NO inline result — the worker runs the
 *     provider read; the review screen polls GET /api/takeoff-drafts/:id/result
 *     (useTakeoffDraftResult refetchInterval) until the status leaves 'processing'.
 *   - DRY-RUN: otherwise (no blueprint, live mode off, or any live-path error) it
 *     posts the dry-run JSON payload — deterministic demo quantities (201, sync),
 *     no provider spend, and keeps the demo badge.
 * REVIEW reads the draft's stored TakeoffResult and promotes the kept quantities to
 * committed `takeoff_measurements` via .../:draftId/promote. While the worker is
 * still processing it renders an explicit in-progress state; a failed capture
 * surfaces the provider error (zero fabricated rows) with a "run again" retry that
 * re-POSTs /capture (fresh draft). The demo-vs-live badge keys off the server's
 * `provenance` discriminator ('stub-dry-run' = demo, '*-live' = real read), falling
 * back to the navigation-state capture mode for processing/pre-migration drafts.
 *
 * The symbol→item target toggles + sheet scope stay presentational — the capture
 * endpoint takes no per-target/per-sheet selection (GAP LIST). They still gate RUN
 * (≥1 target).
 */
import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, DLoadingState, type DColumn } from '../../components/d/index.js'
import { MAiStripe, MBanner, MButton, MI, MInput, MPill, Spark } from '../../components/m/index.js'
import {
  draftResultStatus,
  fetchBlueprintFile,
  isLiveProvenance,
  promoteRejectionsFromError,
  useBlueprintVisionLiveAvailable,
  useCaptureBlueprintVisionLive,
  useCaptureTakeoffDraft,
  usePromoteCapturedQuantities,
  useTakeoffDraftResult,
  useTakeoffDrafts,
  type CapturedQuantity,
  type PromoteRejection,
  type PromoteResponse,
} from '../../lib/api/takeoff-drafts.js'
import { useProjectBlueprints } from '../../lib/api/takeoff.js'

// ---------------------------------------------------------------------------
// Demo-data notice (C1, takeoff deep-dive 2026-06-01).
// The Run button has two paths. The DRY-RUN path posts `payload: { dryRun: true }`
// with a JSON body and never streams a PDF, so the capture endpoint returns
// deterministic demo/stub quantities — that draft always carries the demo banner
// below so a stub can never be mistaken for a real read and submitted in a bid.
// The LIVE path streams the project's blueprint PDF as multipart/form-data when
// the API reports live mode is available (BLUEPRINT_VISION_MODE=live +
// ANTHROPIC_API_KEY) AND the project has a blueprint document; that draft carries
// result_summary.mode='live' and the review surface shows an "AI read · review
// required" affordance instead.
// ---------------------------------------------------------------------------
const DEMO_BADGE_TITLE = 'DEMO DATA · NOT A REAL AI SHEET READ'
const DEMO_BADGE_BODY =
  'These quantities are placeholder demo numbers, not measured from your blueprint. Do not submit them in a bid — verify every line against the real drawing first.'

// Live-read review notice — shown when the draft came from a real Claude-vision
// sheet read. Not a "this is correct" claim: AI takeoffs still demand a human
// pass before they go into a bid, so the copy stays review-forward.
const LIVE_BADGE_TITLE = 'AI READ · REVIEW REQUIRED'
const LIVE_BADGE_BODY =
  'These quantities were measured from your blueprint by the AI sheet read. They are a starting point, not a final takeoff — verify every line against the drawing before you accept it into a bid.'

// Async-capture states (2026-06-12). A LIVE capture is 202-accepted and runs on
// the worker: review polls the draft result until the status leaves
// 'processing'. A failed read produces ZERO fabricated rows — the only honest
// render is the provider error plus a re-run affordance (fresh POST /capture).
const PROCESSING_TITLE = 'AI READ IN PROGRESS'
const PROCESSING_BODY =
  'The AI is reading your blueprint on the server. This screen updates automatically — quantities appear when the read completes.'
const FAILED_TITLE = 'AI READ FAILED · NO QUANTITIES PRODUCED'

// Capture mode discriminator carried setup → review (via navigation state) and
// returned on result_summary.mode. Absent ⇒ treated as 'dry-run' (demo badge).
export type CaptureMode = 'live' | 'dry-run'

// ---------------------------------------------------------------------------
// Navigation family. This screen is mounted under BOTH the `/desktop/*` route
// table and the `/projects/*` mobile route table. We keep each tree's own
// navigation targets verbatim by branching on the current path prefix — a
// desktop-mounted screen navigates to `/desktop/...`, a mobile-mounted one to
// `/projects/...`. (Phase D will collapse the two route tables; until then this
// keeps both routes working with no behavior change.)
// ---------------------------------------------------------------------------
function useNavFamily(projectId: string) {
  const location = useLocation()
  const isDesktopRoute = location.pathname.startsWith('/desktop')
  if (isDesktopRoute) {
    return {
      setupBack: () => (projectId ? `/desktop/canvas/${projectId}` : '/desktop/ai-queue'),
      toReview: () => `/desktop/ai-takeoff/${projectId}/review`,
      reviewBack: () => `/desktop/ai-takeoff/${projectId}`,
      afterAccept: () => (projectId ? `/desktop/estimate/${projectId}` : '/desktop/ai-queue'),
    }
  }
  return {
    setupBack: () => `/projects/${projectId}/takeoff-ai`,
    toReview: () => `/projects/${projectId}/takeoff-ai/takeoff/review`,
    reviewBack: () => `/projects/${projectId}/takeoff-ai/takeoff`,
    afterAccept: () => `/projects/${projectId}/takeoff-mobile`,
  }
}

// ---------------------------------------------------------------------------
// Desktop chrome helpers (translated from the mockup's DCanvasBackdrop9 /
// .dt-float / .dt-float-head into repo --m-* tokens). Rendered only at `lg:`.
// ---------------------------------------------------------------------------
function TakeoffBackdrop({ children }: { children?: React.ReactNode }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--m-ink-2)', overflow: 'hidden' }}>
      <svg
        viewBox="0 0 1208 836"
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid slice"
        style={{ position: 'absolute', inset: 0, opacity: 0.4 }}
        aria-hidden="true"
      >
        <defs>
          <pattern id="ai-takeoff-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" stroke="var(--m-ink-3)" strokeWidth="0.5" fill="none" />
          </pattern>
        </defs>
        <rect width="1208" height="836" fill="url(#ai-takeoff-grid)" />
        <rect x="300" y="200" width="620" height="420" fill="none" stroke="var(--m-ink)" strokeWidth="3" />
        {children}
      </svg>
    </div>
  )
}

const floatHead: React.CSSProperties = {
  padding: '10px 14px',
  borderBottom: '2px solid var(--m-ink)',
  background: 'var(--m-ink)',
  color: 'var(--m-accent)',
  fontFamily: 'var(--m-num)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
}

const dLabel: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--m-ink-3)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
}

const sectionBar: React.CSSProperties = {
  padding: '10px 20px',
  background: 'var(--m-card-soft)',
  borderTop: '2px solid var(--m-ink)',
  borderBottom: '2px solid var(--m-ink)',
}

function TakeoffAppBar({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="m-topbar">
      <button type="button" className="m-topbar-back" aria-label="Back" onClick={onBack}>
        <MI.ChevLeft size={22} />
      </button>
      <div className="m-topbar-title">
        <div className="m-topbar-eyebrow" data-tone="accent" style={{ display: 'inline-flex', gap: 5 }}>
          <Spark size={11} state="strong" /> AI · AUTO-TAKEOFF
        </div>
        <div className="m-h1">{title}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Setup — symbol → item targets + sheet scope + RUN (shared logic; two layouts).
// ---------------------------------------------------------------------------
type Target = { sym: string; item: string; param: string; on: boolean }

// One unified target list (the two twins drifted to slightly different copy; we
// keep the desktop sym/item/param triple — it carries the most information and
// the mobile layout renders sym+item on one line, param underneath).
const TARGETS: Target[] = [
  { sym: 'EXT WALLS', item: 'EPS · 2"', param: 'NET AREA · 8FT DEF', on: true },
  { sym: 'BASECOAT', item: 'Basecoat', param: 'MATCH EPS', on: true },
  { sym: 'FINISH COAT', item: 'Finish coat', param: 'MATCH EPS', on: true },
  { sym: 'STONE HATCH', item: 'Stone veneer', param: 'FOOTPRINT', on: true },
  { sym: 'WIN/DOOR', item: 'Deduct', param: 'CUT FROM WALL', on: true },
  { sym: 'JOINT LINE', item: 'Sealant', param: 'LINEAR · PERIM', on: false },
]

// Shared RUN hook — owns the two capture paths (LIVE multipart provider read +
// DRY-RUN JSON stub). Used by the setup hook below AND by the review screen's
// failed-capture retry (a re-run is always a fresh POST /capture → fresh draft),
// so the capture logic lives in exactly one place.
function useRunAutoTakeoff(projectId: string, onReviewDraft: (draftId: string, mode: CaptureMode) => void) {
  const capture = useCaptureTakeoffDraft(projectId)
  const captureLive = useCaptureBlueprintVisionLive(projectId)

  // Live-path gates: the API must report live mode is available AND the project
  // must actually have a blueprint document to read. Either missing ⇒ dry-run.
  const liveAvailable = useBlueprintVisionLiveAvailable()
  const blueprints = useProjectBlueprints(projectId)
  const firstBlueprint = (blueprints.data?.blueprints ?? []).find((b) => !b.deleted_at) ?? null
  const canRunLive = liveAvailable.data === true && firstBlueprint != null

  // A live-path failure (download / multipart / API error) should not strand the
  // estimator — surface it and let them fall through to the dry-run path.
  const [liveError, setLiveError] = useState<string | null>(null)

  const isPending = capture.isPending || captureLive.isPending
  const errorMessage = liveError ?? capture.error?.message ?? captureLive.error?.message ?? null

  // draft_kind='takeoff' tags the draft so the company AI queue routes its
  // "Review draft →" back to this takeoff reviewer (migration 122). It is also
  // the API default, but we send it explicitly to keep the two AI flows
  // symmetric with takeoff-ai-count.tsx.
  const runDryRun = () => {
    capture.mutate(
      { kind: 'blueprint_vision', draft_kind: 'takeoff', name: 'AI auto-takeoff', payload: { dryRun: true } },
      { onSuccess: (res) => onReviewDraft(res.draft.id, res.result_summary.mode ?? 'dry-run') },
    )
  }

  const runTakeoff = () => {
    if (!projectId || isPending) return
    setLiveError(null)

    // LIVE path: download the project's blueprint PDF and stream it as
    // multipart/form-data. Since the 2026-06-12 async split a live capture is
    // ACCEPTED (202, result_summary.status='processing') rather than run
    // inline — the review screen polls the draft result until the worker
    // finishes. Any failure here (storage read, network, API rejection) falls
    // back to dry-run so the estimator always lands on a reviewable draft.
    if (canRunLive && firstBlueprint) {
      void fetchBlueprintFile(firstBlueprint.id, firstBlueprint.file_name)
        .then((file) =>
          captureLive.mutateAsync({ file, draftKind: 'takeoff', name: 'AI auto-takeoff' }).then((res) => {
            // Trust the server's discriminator: even on the live path the API
            // returns mode='dry-run' if its env gate isn't actually live.
            onReviewDraft(res.draft.id, res.result_summary.mode ?? 'dry-run')
          }),
        )
        .catch((err: unknown) => {
          setLiveError(
            `Live AI read failed (${err instanceof Error ? err.message : 'unknown error'}) — falling back to demo data.`,
          )
          runDryRun()
        })
      return
    }

    // DRY-RUN path: JSON body → deterministic stub on the API (synchronous
    // 201); no provider spend. Carries the real draft id + mode into review.
    runDryRun()
  }

  return { canRunLive, isPending, errorMessage, runTakeoff }
}

// Shared setup hook — target toggles over the shared RUN hook. Both the
// responsive screen and the standalone `EstAiTakeoffSetupPanel` (consumed by
// the desktop est-canvas overlay) use it.
function useTakeoffSetup(projectId: string, onReviewDraft: (draftId: string, mode: CaptureMode) => void) {
  // Target toggles stay presentational (the capture endpoint takes no per-target
  // selection — GAP). They still gate RUN (≥1 target).
  const [targets, setTargets] = useState<Target[]>(TARGETS)
  const run = useRunAutoTakeoff(projectId, onReviewDraft)

  const toggle = (index: number) => setTargets((prev) => prev.map((t, i) => (i === index ? { ...t, on: !t.on } : t)))
  const enabled = targets.filter((t) => t.on).length

  return { targets, toggle, enabled, ...run }
}

type TakeoffSetupState = ReturnType<typeof useTakeoffSetup>

// Desktop float palette — the `.dt-float` chrome only (no backdrop). Presentational
// over a `TakeoffSetupState`. Mounted INSIDE the takeoff canvas (canvas visible
// behind) via the exported `EstAiTakeoffSetupPanel`, or by the responsive screen's
// desktop layout block.
function TakeoffSetupFloat({ setup, onClose }: { setup: TakeoffSetupState; onClose: () => void }) {
  const { targets, toggle, enabled, canRunLive, isPending, errorMessage, runTakeoff } = setup
  return (
    <div
      style={{
        position: 'absolute',
        top: 24,
        right: 24,
        width: 340,
        background: 'var(--m-card)',
        border: '2px solid var(--m-ink)',
        boxShadow: '6px 6px 0 var(--m-ink)',
        zIndex: 20,
      }}
    >
      <div style={{ ...floatHead, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>● AI · Draft the whole takeoff · {canRunLive ? 'LIVE' : 'DEMO'}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--m-accent)',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 800,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ padding: 18 }}>
        <div style={dLabel}>Targets · symbol → item</div>
        <div style={{ marginTop: 10, border: '2px solid var(--m-ink)' }}>
          {targets.map((t, i) => (
            <button
              key={t.sym}
              type="button"
              onClick={() => toggle(i)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '10px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                borderBottom: i < targets.length - 1 ? '1px solid var(--m-line-2)' : 'none',
                background: t.on ? 'transparent' : 'var(--m-card-soft)',
                cursor: 'pointer',
              }}
              aria-pressed={t.on}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  background: t.on ? 'var(--m-accent)' : 'transparent',
                  border: '2px solid var(--m-ink)',
                  flexShrink: 0,
                }}
                aria-hidden
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 800 }}>
                  {t.sym} <span style={{ color: 'var(--m-ink-3)' }}>→ {t.item}</span>
                </span>
                <span
                  style={{
                    display: 'block',
                    fontFamily: 'var(--m-num)',
                    fontSize: 8,
                    color: 'var(--m-ink-3)',
                    marginTop: 2,
                    fontWeight: 600,
                  }}
                >
                  {t.param}
                </span>
              </span>
            </button>
          ))}
        </div>
        {/*
          Custom symbol→item targets aren't wired yet: the capture endpoint
          reads every detected symbol and takes no per-target selection (the
          GAP noted on `useTakeoffSetup`). Rather than a silent no-op button
          that looks clickable, this is an honest disabled affordance until the
          custom-target backend lands.
        */}
        <button
          type="button"
          disabled
          aria-disabled="true"
          title="Custom symbol targets are coming soon — the AI read currently uses the built-in target set."
          style={{
            width: '100%',
            marginTop: 8,
            padding: 8,
            background: 'transparent',
            border: '2px dashed var(--m-line-2)',
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color: 'var(--m-ink-3)',
            cursor: 'not-allowed',
            opacity: 0.55,
          }}
        >
          + ADD TARGET · SOON
        </button>

        <div style={{ ...dLabel, marginTop: 16 }}>Sheet scope</div>
        <div
          style={{
            marginTop: 8,
            padding: '10px 12px',
            background: 'var(--m-card-soft)',
            border: '2px solid var(--m-ink)',
          }}
        >
          <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700 }}>ALL VERIFIED · 22 SHEETS</div>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 9,
              color: 'var(--m-ink-3)',
              marginTop: 3,
              fontWeight: 600,
            }}
          >
            A-101 · A-201..204 · M-101..104 · …
          </div>
        </div>

        <div
          style={{
            padding: '10px 12px',
            background: 'var(--m-accent)',
            color: 'var(--m-accent-ink)',
            marginTop: 14,
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
          }}
        >
          {canRunLive
            ? `LIVE · ${enabled} TARGETS · AI READS YOUR BLUEPRINT · REVIEW EVERY LINE`
            : `DEMO · ${enabled} TARGETS · STUB QUANTITIES · NOT A REAL SHEET READ`}
        </div>
        <MButton variant="primary" onClick={runTakeoff} disabled={isPending || enabled === 0}>
          {isPending
            ? canRunLive
              ? 'Reading blueprint…'
              : 'Drafting…'
            : canRunLive
              ? 'Run AI auto-takeoff →'
              : 'Run demo auto-takeoff →'}
        </MButton>
        {errorMessage ? (
          <div
            style={{
              marginTop: 10,
              fontFamily: 'var(--m-num)',
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--m-red)',
            }}
          >
            ● {errorMessage}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Standalone AI auto-takeoff SETUP float palette. Self-contained (owns the setup
 * hooks). Mounted as an overlay INSIDE the desktop takeoff canvas (est-canvas.tsx)
 * with the canvas visible behind. Kept exported so that Phase-C canvas consumer is
 * unaffected by the desktop↔mobile screen merge.
 */
export function EstAiTakeoffSetupPanel({
  projectId,
  onClose,
  onReviewDraft,
}: {
  projectId: string
  onClose: () => void
  onReviewDraft: (draftId: string, mode: CaptureMode) => void
}) {
  const setup = useTakeoffSetup(projectId, onReviewDraft)
  return <TakeoffSetupFloat setup={setup} onClose={onClose} />
}

export function TakeoffAiTakeoffSetup({ companySlug }: { companySlug: string }) {
  void companySlug
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  const nav = useNavFamily(projectId)

  const goReview = (id: string, mode: CaptureMode) => navigate(nav.toReview(), { state: { draftId: id, mode } })
  const setup = useTakeoffSetup(projectId, goReview)
  const { targets, toggle, enabled, canRunLive, isPending, errorMessage, runTakeoff } = setup

  const runLabel = isPending
    ? canRunLive
      ? 'Reading blueprint…'
      : 'Drafting…'
    : canRunLive
      ? `Run AI auto-takeoff · ${enabled} targets →`
      : `Run demo · ${enabled} targets · stub data`

  return (
    <>
      {/* MOBILE layout (default, hidden ≥lg). */}
      <div
        className="lg:hidden"
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }}
      >
        <TakeoffAppBar title="DEFINE TARGETS" onBack={() => navigate(nav.setupBack())} />

        <div style={sectionBar}>
          <div className="m-topbar-eyebrow">WHAT TO MEASURE</div>
        </div>
        <div style={{ padding: '14px 20px' }}>
          {targets.map((t, i) => (
            <button
              key={t.sym}
              type="button"
              onClick={() => toggle(i)}
              aria-pressed={t.on}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '12px 0',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                background: 'transparent',
                border: 'none',
                borderBottom: i < targets.length - 1 ? '1px solid var(--m-line-2)' : 'none',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  width: 20,
                  height: 20,
                  background: t.on ? 'var(--m-accent)' : 'transparent',
                  border: '2px solid var(--m-ink)',
                  flexShrink: 0,
                }}
                aria-hidden
              />
              <span style={{ flex: 1, minWidth: 0, opacity: t.on ? 1 : 0.55 }}>
                <span style={{ display: 'block', fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700 }}>
                  {t.sym} <span style={{ color: 'var(--m-ink-3)' }}>→ {t.item}</span>
                </span>
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
                  {t.param}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div style={sectionBar}>
          <div className="m-topbar-eyebrow">SHEETS</div>
        </div>
        <div style={{ padding: '14px 20px' }}>
          <div style={{ padding: '14px 16px', background: 'var(--m-card-soft)', border: '2px solid var(--m-ink)' }}>
            <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700 }}>ALL VERIFIED SHEETS · 22</div>
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                color: 'var(--m-ink-3)',
                marginTop: 4,
                fontWeight: 600,
              }}
            >
              A-101 · A-201..204 · M-101..104 · S-101..103 · …
            </div>
          </div>
        </div>

        <div style={{ flex: 1 }} />
        <div style={{ padding: '14px 20px 18px', borderTop: '2px solid var(--m-ink)' }}>
          {errorMessage ? (
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--m-red)',
                marginBottom: 10,
              }}
            >
              ● {errorMessage}
            </div>
          ) : null}
          <MButton variant="primary" onClick={runTakeoff} disabled={isPending || enabled === 0}>
            {runLabel}
          </MButton>
        </div>
      </div>

      {/* DESKTOP layout (≥lg only) — faint blueprint backdrop + floating palette. */}
      <div className="hidden lg:block d-content-full" style={{ position: 'relative' }}>
        <TakeoffBackdrop>
          <polygon
            points="320,220 600,222 602,400 318,398"
            fill="rgba(255,212,0,0.30)"
            stroke="var(--m-ink)"
            strokeWidth="2"
          />
        </TakeoffBackdrop>
        <TakeoffSetupFloat setup={setup} onClose={() => navigate(nav.setupBack())} />
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Review — accept/adjust AI-detected quantities (from the real captured
// TakeoffResult), then promote the kept ones to committed measurements.
// ---------------------------------------------------------------------------
type ReviewStatus = 'ok' | 'review' | 'flag'

// Mirrors REVIEW_REQUIRED_CONFIDENCE_FLOOR (0.7) in @sitelayer/capture-schema:
// the API flags any captured quantity below this as review_required. Keep in sync.
// (We adopt the desktop twin's 0.7 floor; the old mobile twin used 0.8 — the 0.7
// floor is the one that matches the API gate.)
const REVIEW_CONFIDENCE_FLOOR = 0.7

/** Rows at/above the API review floor are safe to keep by default; below it the
 * estimator must review before accepting. <0.5 is flagged as low-confidence. */
function statusForConfidence(confidence: number): ReviewStatus {
  if (confidence >= REVIEW_CONFIDENCE_FLOOR) return 'ok'
  if (confidence >= 0.5) return 'review'
  return 'flag'
}

function confidenceLabel(confidence: number): 'HIGH' | 'MED' | 'LOW' {
  if (confidence >= REVIEW_CONFIDENCE_FLOOR) return 'HIGH'
  if (confidence >= 0.5) return 'MED'
  return 'LOW'
}

function statusColor(status: ReviewStatus): string {
  return status === 'ok' ? 'var(--m-green)' : status === 'review' ? 'var(--m-amber)' : 'var(--m-red)'
}

// Desktop status accent bar — the amber/review tone maps to the accent token.
function statusBarDesktop(status: ReviewStatus): string {
  return status === 'ok' ? 'var(--m-green)' : status === 'review' ? 'var(--m-accent)' : 'var(--m-red)'
}

function formatQty(value: number, unit: string): string {
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100
  return `${rounded.toLocaleString()} ${unit.toUpperCase()}`
}

/**
 * The service_item_code the API will derive for a quantity if the operator
 * does NOT override it. Mirrors `deriveServiceItemCodeFromQuantity` in
 * apps/api/src/routes/takeoff-drafts.ts: prefer MasterFormat, then UniFormat,
 * then OmniClass. Returns '' when the AI proposed no usable code — the row
 * then REQUIRES an override before it can be promoted (the server skips it
 * with "no service_item_code on quantity" otherwise).
 */
function aiDerivedCode(q: CapturedQuantity): string {
  return (q.masterformatCode ?? q.uniformatCode ?? q.omniclassCode ?? '').trim()
}

/** One-line summary of curated-catalog rejections (422 promote) for the footer
 *  banner — the per-row inputs already carry the highlight + inline label. */
function rejectionSummary(rejections: PromoteRejection[]): string {
  const codes = Array.from(new Set(rejections.map((r) => r.service_item_code)))
  const n = rejections.length
  return `${n} ${n === 1 ? 'code is' : 'codes are'} not in your curated catalog: ${codes.join(', ')}. Fix or clear ${
    n === 1 ? 'it' : 'them'
  } and accept again.`
}

/** One-line summary of rows the server couldn't promote (2xx body `skipped[]`),
 *  e.g. a quantity missing a unit or with no derivable service item code. */
function skippedSummary(skipped: PromoteResponse['skipped']): string {
  const n = skipped.length
  return `Promoted the rest, but ${n} ${n === 1 ? 'row' : 'rows'} couldn't be committed: ${skipped
    .map((s) => s.reason)
    .join('; ')}`
}

/**
 * Resolve the draft id to review: prefer the one handed over by the setup screen
 * via navigation state; otherwise fall back to the most-recent capture-sourced
 * draft for the project (covers deep-links / refresh).
 */
function useReviewDraftId(projectId: string): string | null {
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

/**
 * Resolve the capture mode the setup screen handed over via navigation state.
 * Defaults to 'dry-run' so a deep-link / refresh (no nav state) keeps the
 * conservative demo badge — a draft is never silently presented as a real AI
 * read without an explicit 'live' signal from the producing run.
 */
function useReviewMode(): CaptureMode {
  const location = useLocation()
  const stateMode =
    location.state && typeof location.state === 'object' && 'mode' in location.state
      ? String((location.state as { mode?: unknown }).mode ?? '')
      : ''
  return stateMode === 'live' ? 'live' : 'dry-run'
}

function confidenceTone(confidence: 'HIGH' | 'MED' | 'LOW'): 'green' | 'amber' | 'red' {
  return confidence === 'HIGH' ? 'green' : confidence === 'MED' ? 'amber' : 'red'
}

// Per-row review decision. OK rows are kept by default; review/flag rows stay
// 'pending' until the estimator keeps or rejects them.
type RowDecision = 'pending' | 'kept' | 'rejected'

export function TakeoffAiTakeoffReview({ companySlug }: { companySlug: string }) {
  void companySlug
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  const nav = useNavFamily(projectId)

  const draftId = useReviewDraftId(projectId)
  const mode = useReviewMode()
  const resultQuery = useTakeoffDraftResult(draftId)
  const promote = usePromoteCapturedQuantities(projectId, draftId)

  // Async-capture poll states (2026-06-12). While 'processing' the hook keeps
  // refetching on an interval; 'failed' carries the provider error and ZERO
  // fabricated rows; 'ready' is the reviewable state below.
  const captureStatus = draftResultStatus(resultQuery.data)
  const isProcessing = captureStatus === 'processing'
  const isFailed = captureStatus === 'failed'
  const captureError = resultQuery.data?.error ?? null

  // Demo-vs-live: prefer the server's honest provenance discriminator
  // ('stub-dry-run' = demo rows, '*-live' = real provider read); fall back to
  // the navigation-state capture mode for processing / pre-migration drafts
  // (which defaults to the conservative demo badge).
  const provenanceIsLive = isLiveProvenance(resultQuery.data?.provenance)
  const isLive = provenanceIsLive ?? mode === 'live'

  // Failed-capture retry: re-running is a fresh POST /capture → fresh draft.
  // Swap the review target to the new draft in place (replace: the broken
  // draft shouldn't stay on the Back stack).
  const retry = useRunAutoTakeoff(projectId, (id, retryMode) =>
    navigate(nav.toReview(), { state: { draftId: id, mode: retryMode }, replace: true }),
  )

  const quantities = useMemo<CapturedQuantity[]>(
    () => resultQuery.data?.takeoff_result?.quantities ?? [],
    [resultQuery.data],
  )

  // Real local keep/reject decisions, keyed by quantity id. High-confidence (ok)
  // rows default to kept; flagged/review rows wait for an explicit decision.
  const [decisions, setDecisions] = useState<Record<string, RowDecision>>({})
  const decisionForId = (id: string, status: ReviewStatus): RowDecision =>
    decisions[id] ?? (status === 'ok' ? 'kept' : 'pending')

  // EDIT — per-quantity service_item_code override, keyed by quantity id. Empty /
  // absent means "use what the AI derived". A non-empty trimmed value that differs
  // from the AI-derived code is sent as `service_item_code_overrides[id]` so the
  // operator can re-route a mis-classified line onto the company's curated catalog
  // code WITHOUT mutating the immutable captured result. The server runs the
  // override through the same catalog gate as a manual takeoff write (uncurated
  // codes come back as a 422 `rejected[]`).
  const [codeEdits, setCodeEdits] = useState<Record<string, string>>({})
  const editForId = (q: CapturedQuantity): string => codeEdits[q.id] ?? aiDerivedCode(q)

  // Diagnostics surfaced after a promote attempt: `skipped` from a 2xx body (rows
  // the server couldn't promote, e.g. missing unit), `rejected` from a 422 body
  // (operator-typed codes not in the curated catalog). Both let the estimator see
  // exactly which rows didn't land instead of a silent partial commit.
  const [skipped, setSkipped] = useState<PromoteResponse['skipped']>([])

  // Any edit/decision change invalidates the previous attempt's skip diagnostics
  // (the operator is acting on them); clear so the footer doesn't show stale rows.
  const setDecision = (id: string, decision: RowDecision) => {
    setDecisions((prev) => ({ ...prev, [id]: decision }))
    setSkipped((prev) => (prev.length > 0 ? [] : prev))
  }
  const setCodeEdit = (id: string, code: string) => {
    setCodeEdits((prev) => ({ ...prev, [id]: code }))
    setSkipped((prev) => (prev.length > 0 ? [] : prev))
  }
  const rejections = useMemo(() => promoteRejectionsFromError(promote.error), [promote.error])
  const rejectedCodeIds = useMemo(() => new Set(rejections.map((r) => r.quantity_id)), [rejections])

  const counts = useMemo(
    () =>
      quantities.reduce(
        (acc, q) => {
          acc[statusForConfidence(q.confidence)] += 1
          return acc
        },
        { ok: 0, review: 0, flag: 0 } as Record<ReviewStatus, number>,
      ),
    [quantities],
  )
  const needsReview = counts.review + counts.flag

  const keptQuantities = quantities.filter((q) => decisionForId(q.id, statusForConfidence(q.confidence)) === 'kept')
  const keptIds = keptQuantities.map((q) => q.id)
  const keptCount = keptIds.length

  // Build the `service_item_code_overrides` map for the promote call: only kept
  // rows whose edited code is non-empty AND differs from what the AI derived.
  // (An edit equal to the AI code is a no-op — don't send it, so it bypasses the
  // override-only catalog gate the same way an un-edited AI proposal does.)
  const buildOverrides = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const q of keptQuantities) {
      const edited = (codeEdits[q.id] ?? '').trim()
      if (edited.length > 0 && edited !== aiDerivedCode(q)) out[q.id] = edited
    }
    return out
  }

  const accept = () => {
    if (!draftId || keptCount === 0 || promote.isPending) return
    const overrides = buildOverrides()
    // Promote only the kept rows into committed `takeoff_measurements` (carrying
    // any per-row code overrides), then route on (desktop → the project's
    // estimate; mobile → the takeoff surface). A 2xx body may still report
    // `skipped` rows; surface them instead of navigating away so the estimator
    // sees what didn't land.
    promote.mutate(
      {
        quantity_ids: keptIds,
        ...(Object.keys(overrides).length > 0 ? { service_item_code_overrides: overrides } : {}),
      },
      {
        onSuccess: (res) => {
          if (res.skipped_count > 0) {
            setSkipped(res.skipped)
            return
          }
          setSkipped([])
          navigate(nav.afterAccept())
        },
      },
    )
  }
  const accepting = promote.isPending

  // Desktop DataTable columns.
  type DesktopRow = { id: string; item: string; qty: string; confidence: 'HIGH' | 'MED' | 'LOW'; status: ReviewStatus }
  const desktopRows = useMemo<DesktopRow[]>(
    () =>
      quantities.map((q) => ({
        id: q.id,
        item: q.description || q.masterformatCode || q.uniformatCode || q.id,
        qty: formatQty(q.value, q.unit),
        confidence: confidenceLabel(q.confidence),
        status: statusForConfidence(q.confidence),
      })),
    [quantities],
  )
  const quantityById = useMemo(() => {
    const map = new Map<string, CapturedQuantity>()
    for (const q of quantities) map.set(q.id, q)
    return map
  }, [quantities])
  const columns: Array<DColumn<DesktopRow>> = [
    {
      key: 'status',
      header: '',
      render: (r) => (
        <span
          style={{ display: 'inline-block', width: 8, height: 28, background: statusBarDesktop(r.status) }}
          aria-hidden
        />
      ),
    },
    {
      key: 'item',
      header: 'Item',
      render: (r) => (
        <span
          className="d-table-cell-strong"
          style={
            decisionForId(r.id, r.status) === 'rejected'
              ? { textDecoration: 'line-through', color: 'var(--m-ink-3)' }
              : undefined
          }
        >
          {r.item}
        </span>
      ),
    },
    {
      key: 'confidence',
      header: 'Confidence',
      render: (r) => (
        <MPill tone={confidenceTone(r.confidence)} dot>
          {r.confidence === 'HIGH' ? 'High' : r.confidence === 'MED' ? 'Medium' : 'Low'}
        </MPill>
      ),
    },
    {
      key: 'code',
      header: 'Service item code',
      render: (r) => {
        const q = quantityById.get(r.id)
        if (!q) return null
        const derived = aiDerivedCode(q)
        const rejected = rejectedCodeIds.has(r.id)
        const needsCode = derived === '' && editForId(q).trim() === ''
        return (
          <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3, minWidth: 150 }}>
            <MInput
              value={editForId(q)}
              onChange={(e) => setCodeEdit(q.id, e.target.value)}
              placeholder={derived || 'Add a catalog code'}
              aria-label={`Service item code for ${r.item}`}
              aria-invalid={rejected || undefined}
              style={
                rejected || needsCode
                  ? { borderColor: 'var(--m-red)', fontFamily: 'var(--m-num)', fontSize: 12 }
                  : { fontFamily: 'var(--m-num)', fontSize: 12 }
              }
            />
            {rejected ? (
              <span style={{ fontFamily: 'var(--m-num)', fontSize: 9, fontWeight: 700, color: 'var(--m-red)' }}>
                Not in catalog
              </span>
            ) : needsCode ? (
              <span style={{ fontFamily: 'var(--m-num)', fontSize: 9, fontWeight: 700, color: 'var(--m-red)' }}>
                No AI code — required
              </span>
            ) : null}
          </span>
        )
      },
    },
    { key: 'qty', header: 'Qty', numeric: true, render: (r) => r.qty },
    {
      key: 'action',
      header: '',
      numeric: true,
      render: (r) => {
        const decision = decisionForId(r.id, r.status)
        return (
          <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
            <MButton
              size="sm"
              variant={decision === 'kept' ? 'primary' : 'ghost'}
              onClick={() => setDecision(r.id, 'kept')}
            >
              Keep
            </MButton>
            <MButton
              size="sm"
              variant={decision === 'rejected' ? 'primary' : 'ghost'}
              onClick={() => setDecision(r.id, 'rejected')}
            >
              Reject
            </MButton>
          </span>
        )
      },
    },
  ]

  return (
    <>
      {/* MOBILE layout (default, hidden ≥lg). Drop-toggle list per row. */}
      <div className="lg:hidden" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <TakeoffAppBar title="DRAFT REVIEW" onBack={() => navigate(nav.reviewBack())} />

        <div style={{ padding: 20, borderBottom: '2px solid var(--m-ink)' }}>
          <span
            className="m-topbar-eyebrow"
            style={{
              display: 'inline-block',
              background: isProcessing
                ? 'var(--m-amber)'
                : isFailed
                  ? 'var(--m-red)'
                  : isLive
                    ? 'var(--m-green)'
                    : 'var(--m-amber)',
              color: 'var(--m-ink)',
              padding: '3px 8px',
            }}
          >
            {isProcessing ? 'AI READ · IN PROGRESS' : isFailed ? 'AI READ · FAILED' : isLive ? 'AI READ' : 'DEMO'} ·{' '}
            {resultQuery.data?.source ? resultQuery.data.source.toUpperCase() : 'AI DRAFT'}
          </span>
          <h2
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 28,
              letterSpacing: '-0.02em',
              marginTop: 12,
              color: 'var(--m-ink)',
            }}
          >
            {resultQuery.isLoading
              ? 'Loading draft…'
              : isProcessing
                ? 'Reading your blueprint…'
                : isFailed
                  ? 'AI read failed.'
                  : quantities.length > 0
                    ? `${quantities.length} detected ${quantities.length === 1 ? 'quantity' : 'quantities'}.`
                    : 'No quantities detected.'}
          </h2>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 12,
              marginTop: 10,
              color: 'var(--m-ink-2)',
              fontWeight: 600,
            }}
          >
            {counts.ok} OK · {counts.review} NEEDS REVIEW · {counts.flag} FLAGGED
          </div>
        </div>

        <div style={{ padding: '14px 20px 0' }}>
          {/* Poll states render INSTEAD of the demo/live badge — there are no
              quantities to label while processing, and a failed read must show
              the provider error + retry, never a badge over fabricated rows. */}
          {isProcessing ? (
            <MBanner
              tone="attention"
              icon={<MI.FileText size={18} />}
              title={PROCESSING_TITLE}
              body={PROCESSING_BODY}
            />
          ) : isFailed ? (
            <>
              <MBanner
                tone="warn"
                icon={<MI.AlertTri size={18} />}
                title={FAILED_TITLE}
                body={captureError ?? 'The AI provider returned an error. No quantities were produced.'}
              />
              <div style={{ marginTop: 10 }}>
                <MButton variant="primary" onClick={retry.runTakeoff} disabled={retry.isPending}>
                  {retry.isPending ? 'Re-running…' : 'Run AI read again'}
                </MButton>
                {retry.errorMessage ? (
                  <div
                    style={{
                      marginTop: 8,
                      fontFamily: 'var(--m-num)',
                      fontSize: 11,
                      fontWeight: 700,
                      color: 'var(--m-red)',
                    }}
                  >
                    ● {retry.errorMessage}
                  </div>
                ) : null}
              </div>
            </>
          ) : isLive ? (
            <MBanner
              tone="attention"
              icon={<MI.FileText size={18} />}
              title={LIVE_BADGE_TITLE}
              body={LIVE_BADGE_BODY}
            />
          ) : (
            <MBanner tone="warn" icon={<MI.AlertTri size={18} />} title={DEMO_BADGE_TITLE} body={DEMO_BADGE_BODY} />
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {resultQuery.isError ? (
            <div
              style={{ padding: 20, fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-red)', fontWeight: 600 }}
            >
              Couldn&apos;t load the draft result. {resultQuery.error.message}
            </div>
          ) : null}
          {!resultQuery.isLoading && !resultQuery.isError && !isProcessing && !isFailed && quantities.length === 0 ? (
            <div
              style={{
                padding: 20,
                fontFamily: 'var(--m-num)',
                fontSize: 12,
                color: 'var(--m-ink-3)',
                fontWeight: 600,
              }}
            >
              {draftId
                ? 'This draft has no detected quantities to review.'
                : 'Run the auto-takeoff to produce a draft.'}
            </div>
          ) : null}
          {quantities.map((q) => {
            const status = statusForConfidence(q.confidence)
            const isKept = decisionForId(q.id, status) === 'kept'
            const derived = aiDerivedCode(q)
            const rowRejected = rejectedCodeIds.has(q.id)
            const needsCode = derived === '' && editForId(q).trim() === ''
            return (
              <div
                key={q.id}
                style={{
                  padding: '14px 20px',
                  borderBottom: '1px solid var(--m-line-2)',
                }}
              >
                {/* Keep/reject toggle — tap the row header to flip the decision. */}
                <button
                  type="button"
                  onClick={() => setDecision(q.id, isKept ? 'rejected' : 'kept')}
                  aria-pressed={isKept}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    opacity: isKept ? 1 : 0.4,
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ width: 8, alignSelf: 'stretch', background: statusColor(status) }} aria-hidden />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: 'var(--m-font-display)',
                        fontWeight: 700,
                        fontSize: 15,
                        textDecoration: isKept ? 'none' : 'line-through',
                      }}
                    >
                      {q.description || q.masterformatCode || q.uniformatCode || q.id}
                    </div>
                    <div style={{ marginTop: 4 }}>
                      <MPill tone={status === 'ok' ? 'green' : status === 'review' ? 'amber' : 'red'} dot>
                        {confidenceLabel(q.confidence)} · {isKept ? 'KEEPING' : 'DROPPED'}
                      </MPill>
                    </div>
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--m-num)',
                      fontSize: 14,
                      fontWeight: 700,
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatQty(q.value, q.unit)}
                  </div>
                </button>

                {/* EDIT — service item code override. Only relevant for kept rows
                    (a dropped row never reaches the promote endpoint), so hide it
                    when the row is dropped to keep the list calm. */}
                {isKept ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, paddingLeft: 22 }}>
                    <label
                      htmlFor={`code-${q.id}`}
                      style={{
                        fontFamily: 'var(--m-num)',
                        fontSize: 9,
                        fontWeight: 700,
                        color: 'var(--m-ink-3)',
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        flexShrink: 0,
                      }}
                    >
                      Code
                    </label>
                    <MInput
                      id={`code-${q.id}`}
                      value={editForId(q)}
                      onChange={(e) => setCodeEdit(q.id, e.target.value)}
                      placeholder={derived || 'Add a catalog code'}
                      aria-label={`Service item code for ${q.description || q.id}`}
                      aria-invalid={rowRejected || undefined}
                      style={
                        rowRejected || needsCode
                          ? { borderColor: 'var(--m-red)', fontFamily: 'var(--m-num)', fontSize: 12, flex: 1 }
                          : { fontFamily: 'var(--m-num)', fontSize: 12, flex: 1 }
                      }
                    />
                    {rowRejected ? (
                      <span style={{ fontFamily: 'var(--m-num)', fontSize: 9, fontWeight: 700, color: 'var(--m-red)' }}>
                        NOT IN CATALOG
                      </span>
                    ) : needsCode ? (
                      <span style={{ fontFamily: 'var(--m-num)', fontSize: 9, fontWeight: 700, color: 'var(--m-red)' }}>
                        REQUIRED
                      </span>
                    ) : null}
                  </div>
                ) : null}
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
            ●{' '}
            {rejections.length > 0
              ? rejectionSummary(rejections)
              : promote.error.message || 'Promote failed — try again.'}
          </div>
        ) : null}
        {skipped.length > 0 ? (
          <div
            style={{
              padding: '10px 20px',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--m-amber)',
              borderTop: '2px solid var(--m-ink)',
            }}
          >
            ● {skippedSummary(skipped)}
          </div>
        ) : null}
        <div style={{ padding: '14px 20px', borderTop: '2px solid var(--m-ink)', display: 'flex', gap: 8 }}>
          <MButton variant="ghost" onClick={() => navigate(nav.reviewBack())} style={{ flex: 1 }}>
            Review {needsReview}
          </MButton>
          <MButton
            variant="primary"
            onClick={accept}
            disabled={accepting || keptCount === 0 || !draftId}
            style={{ flex: 2 }}
          >
            {accepting ? 'Promoting…' : `Accept ${keptCount} kept`}
          </MButton>
        </div>
      </div>

      {/* DESKTOP layout (≥lg only) — DataTable + KPI strip. */}
      <div className="hidden lg:block d-content">
        <div className="d-stack">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <DEyebrow>
                {resultQuery.data?.source ? `Source · ${resultQuery.data.source}` : 'AI auto-takeoff'} ·{' '}
                {isProcessing ? 'AI read in progress' : isFailed ? 'AI read failed' : isLive ? 'AI read' : 'Demo'} ·{' '}
                {quantities.length} items
              </DEyebrow>
              <DH1>Review draft</DH1>
            </div>
            <MButton variant="primary" onClick={accept} disabled={accepting || keptCount === 0 || !draftId}>
              {accepting ? 'Promoting…' : `Accept ${keptCount} kept`}
            </MButton>
          </div>

          {promote.isError ? (
            <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700, color: 'var(--m-red)' }}>
              ●{' '}
              {rejections.length > 0
                ? rejectionSummary(rejections)
                : promote.error.message || 'Promote failed — try again.'}
            </div>
          ) : null}
          {skipped.length > 0 ? (
            <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700, color: 'var(--m-amber)' }}>
              ● {skippedSummary(skipped)}
            </div>
          ) : null}

          {/* Poll states render INSTEAD of the demo/live badges (no quantities
              exist to label while processing; a failed read surfaces the
              provider error + retry, never fabricated rows). */}
          {isProcessing ? (
            <MBanner
              tone="attention"
              icon={<MI.FileText size={18} />}
              title={PROCESSING_TITLE}
              body={PROCESSING_BODY}
            />
          ) : null}
          {isFailed ? (
            <>
              <MBanner
                tone="warn"
                icon={<MI.AlertTri size={18} />}
                title={FAILED_TITLE}
                body={captureError ?? 'The AI provider returned an error. No quantities were produced.'}
              />
              <div>
                <MButton variant="primary" onClick={retry.runTakeoff} disabled={retry.isPending}>
                  {retry.isPending ? 'Re-running…' : 'Run AI read again'}
                </MButton>
                {retry.errorMessage ? (
                  <div
                    style={{
                      marginTop: 8,
                      fontFamily: 'var(--m-num)',
                      fontSize: 11,
                      fontWeight: 700,
                      color: 'var(--m-red)',
                    }}
                  >
                    ● {retry.errorMessage}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
          {!isProcessing && !isFailed ? (
            isLive ? (
              <MBanner
                tone="attention"
                icon={<MI.FileText size={18} />}
                title={LIVE_BADGE_TITLE}
                body={LIVE_BADGE_BODY}
              />
            ) : (
              <MBanner tone="warn" icon={<MI.AlertTri size={18} />} title={DEMO_BADGE_TITLE} body={DEMO_BADGE_BODY} />
            )
          ) : null}

          {!isProcessing && !isFailed ? (
            isLive ? (
              <MAiStripe
                tone="good"
                eyebrow="AI auto-takeoff · LIVE"
                title="AI-read quantities — review before you bid"
                attribution="AI sheet read · review required"
              >
                These rows were measured from your blueprint by the AI sheet read — a starting point, not a finished
                takeoff. The confidence buckets below flag where the AI was unsure. Nothing is committed until you
                accept the draft; verify every line against the drawing first.
              </MAiStripe>
            ) : (
              <MAiStripe
                tone="warn"
                eyebrow="AI auto-takeoff · DEMO"
                title="Demo quantities — not a real AI sheet read"
                attribution="Demo data · stub · review required"
              >
                This draft is demo/stub output — these rows are placeholder quantities, not measured from your
                blueprint. The confidence buckets below are illustrative only. Nothing is committed until you accept the
                draft; do not accept demo data into a real bid.
              </MAiStripe>
            )
          ) : null}

          {/* AI confidence triage (design dsg__54: OK / REVIEW / FLAGGED). */}
          <DKpiStrip>
            <DKpi
              label="OK"
              value={String(counts.ok)}
              meta="High-confidence"
              metaTone={counts.ok > 0 ? 'good' : undefined}
            />
            <DKpi
              label="Review"
              value={String(counts.review)}
              tone={counts.review > 0 ? 'accent' : undefined}
              meta={counts.review > 0 ? 'Needs a closer look' : 'None flagged'}
            />
            <DKpi
              label="Flagged"
              value={String(counts.flag)}
              meta={counts.flag > 0 ? 'Low-confidence' : 'None'}
              metaTone={counts.flag > 0 ? 'bad' : undefined}
            />
          </DKpiStrip>

          {accepting ? (
            <DLoadingState label="Promoting accepted quantities…" />
          ) : resultQuery.isLoading ? (
            <DLoadingState label="Loading captured draft…" />
          ) : isProcessing ? (
            <DLoadingState label="AI is reading your blueprint — this screen updates automatically…" />
          ) : isFailed ? (
            <DataTable<DesktopRow>
              title="AI takeoff draft"
              columns={columns}
              rows={[]}
              rowKey={(r) => r.id}
              empty={`AI read failed: ${captureError ?? 'provider error'}. No quantities were produced — run the AI read again.`}
            />
          ) : resultQuery.isError ? (
            <DataTable<DesktopRow>
              title="AI takeoff draft"
              columns={columns}
              rows={[]}
              rowKey={(r) => r.id}
              empty={`Couldn't load the draft result. ${resultQuery.error.message}`}
            />
          ) : (
            <DataTable<DesktopRow>
              title="AI takeoff draft"
              columns={columns}
              rows={desktopRows}
              rowKey={(r) => r.id}
              empty={
                draftId
                  ? 'This draft has no detected quantities.'
                  : 'No detected quantities. Run the auto-takeoff to populate this draft.'
              }
            />
          )}
        </div>
      </div>
    </>
  )
}
