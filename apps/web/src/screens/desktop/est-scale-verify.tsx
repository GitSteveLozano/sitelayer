/**
 * Estimator desktop screen — EST · SCALE VERIFY (Desktop v2, dsg__31).
 *
 * Surfaces every sheet (PAGE) of a project's plan set with its detected /
 * calibrated drawing scale so the estimator can CONFIRM each one before takeoff
 * quantities are trusted. Each row carries a persisted VERIFIED state
 * (`blueprint_pages.scale_verified_at`, migration 123) — the per-row CHECK
 * action POSTs `/api/blueprint-pages/:id/verify` so the sign-off sticks across
 * reloads instead of being mere navigation. The right rail shows the design's
 * "N / total VERIFIED · M to review" progress and the "quantities aren't
 * trusted until all sheets are verified" warning.
 *
 * Sheets are the pages of the project's plan set (a 22-page plan PDF = 22
 * independently verifiable sheets). We read the pages of the primary blueprint
 * document (the same per-doc `useBlueprintPages` the canvas + mobile cross-link
 * use); confidence (HIGH/MED/LOW) is derived from the page's calibration +
 * detected scale until a real detector-confidence score lands.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MButton, MPill } from '@/components/m'
import {
  useBlueprintPages,
  useProjectBlueprints,
  useVerifyPage,
  type BlueprintDocument,
  type BlueprintPage,
} from '@/lib/api/takeoff'

type Confidence = 'high' | 'med' | 'low'

type SheetRow = {
  pageId: string
  name: string
  scale: string | null
  confidence: Confidence
  verified: boolean
}

/** A page is calibrated once it carries a saved two-point reference. */
function isCalibrated(p: BlueprintPage): boolean {
  return Boolean(p.calibration_set_at)
}

/**
 * Derived confidence — there is no detector confidence score in the API yet,
 * so we tier off the page calibration + the document's title-block scale
 * (matches the design's HIGH / MED / LOW spec on EST · SCALE VERIFY):
 *   HIGH  — a declared `sheet_scale` AND a completed two-point calibration.
 *   MED   — a declared `sheet_scale` but calibration not yet confirmed.
 *   LOW   — no readable scale at all (NTS / detail sheet / missing title block).
 * // TODO: replace with a real scale-detection confidence once the
 * //       scale-verify pipeline lands.
 */
function deriveConfidence(p: BlueprintPage, doc: BlueprintDocument | null): Confidence {
  if (!doc?.sheet_scale) return 'low'
  return isCalibrated(p) ? 'high' : 'med'
}

function sheetName(p: BlueprintPage, doc: BlueprintDocument | null): string {
  const base = (doc?.file_name ?? 'Sheet').replace(/\.[a-z0-9]+$/i, '')
  // Single-page documents read by name; multi-page sets read "<name> · pg N".
  return `${base} · pg ${p.page_number}`
}

function toRow(p: BlueprintPage, doc: BlueprintDocument | null): SheetRow {
  return {
    pageId: p.id,
    name: sheetName(p, doc),
    scale: doc?.sheet_scale ?? null,
    confidence: deriveConfidence(p, doc),
    verified: Boolean(p.scale_verified_at),
  }
}

const CONFIDENCE_TONE: Record<Confidence, 'green' | 'amber' | 'red'> = {
  high: 'green',
  med: 'amber',
  low: 'red',
}
const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: 'High',
  med: 'Med',
  low: 'Low',
}

export function EstScaleVerify() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const blueprints = useProjectBlueprints(projectId)

  // Sheets are the pages of the project's plan set. We verify against the
  // primary (first non-deleted) blueprint document's pages — a multi-page plan
  // PDF is the common pilot shape (one set = N sheets). The canvas + mobile
  // cross-link resolve sheets the same way.
  const primaryDoc = useMemo<BlueprintDocument | null>(() => {
    const docs = (blueprints.data?.blueprints ?? []).filter((b) => !b.deleted_at)
    return docs[0] ?? null
  }, [blueprints.data?.blueprints])

  const pagesQuery = useBlueprintPages(primaryDoc?.id)
  const verifyPage = useVerifyPage()
  const [verifyError, setVerifyError] = useState<string | null>(null)

  const rows = useMemo<SheetRow[]>(() => {
    const pages = pagesQuery.data?.pages ?? []
    return pages.map((p) => toRow(p, primaryDoc))
  }, [pagesQuery.data?.pages, primaryDoc])

  const { total, verified, needsReview, confidencePct } = useMemo(() => {
    const total = rows.length
    const verified = rows.filter((r) => r.verified).length
    const high = rows.filter((r) => r.confidence === 'high').length
    return {
      total,
      verified,
      needsReview: total - verified,
      confidencePct: total === 0 ? 0 : Math.round((high / total) * 100),
    }
  }, [rows])

  const allVerified = total > 0 && needsReview === 0

  // Per-row CHECK now genuinely persists the sign-off (POST .../verify) so it
  // sticks across reloads, rather than only navigating to the canvas.
  const handleVerify = (row: SheetRow) => {
    setVerifyError(null)
    verifyPage.mutate(
      { pageId: row.pageId, verified: true },
      { onError: (err) => setVerifyError(err instanceof Error ? err.message : 'Could not verify the sheet.') },
    )
  }

  // Toggling a VERIFIED sheet back to review (e.g. a calibration was wrong).
  const handleUnverify = (row: SheetRow) => {
    setVerifyError(null)
    verifyPage.mutate(
      { pageId: row.pageId, verified: false },
      { onError: (err) => setVerifyError(err instanceof Error ? err.message : 'Could not update the sheet.') },
    )
  }

  const columns: Array<DColumn<SheetRow>> = [
    { key: 'name', header: 'Sheet', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    {
      key: 'scale',
      header: 'Scale',
      // LOW-confidence sheets read in red to flag an unreadable / NTS scale,
      // matching the design's red "NTS" treatment.
      render: (r) => (
        <span style={{ color: r.confidence === 'low' ? 'var(--m-red)' : undefined }}>{r.scale ?? 'NTS'}</span>
      ),
    },
    {
      key: 'confidence',
      header: 'Confidence',
      render: (r) => (
        <MPill tone={CONFIDENCE_TONE[r.confidence]} dot>
          {CONFIDENCE_LABEL[r.confidence]}
        </MPill>
      ),
    },
    {
      // VERIFY column (design): a green "● VERIFIED" pill once signed off (click
      // to re-review), else a black CHECK action that persists the sign-off.
      key: 'verify',
      header: 'Verify',
      render: (r) =>
        r.verified ? (
          <button
            type="button"
            onClick={() => handleUnverify(r)}
            disabled={verifyPage.isPending}
            title="Verified — click to send back for review"
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
          >
            <MPill tone="green" dot>
              Verified
            </MPill>
          </button>
        ) : (
          <MButton size="sm" variant="primary" onClick={() => handleVerify(r)} disabled={verifyPage.isPending}>
            {verifyPage.isPending ? 'Saving…' : 'Check'}
          </MButton>
        ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>● AI autoscale · Review required</DEyebrow>
          <DH1>Verify scales</DH1>
        </div>

        <DKpiStrip>
          <DKpi label="Sheets" value={String(total)} meta={total === 1 ? '1 drawing' : `${total} drawings`} />
          <DKpi
            label="Verified"
            value={String(verified)}
            meta={`${verified} of ${total} signed off`}
            metaTone={allVerified ? 'good' : undefined}
          />
          <DKpi
            label="To review"
            value={String(needsReview)}
            tone={needsReview > 0 ? 'accent' : undefined}
            meta="Awaiting sign-off"
          />
          <DKpi
            label="Confidence"
            value={String(confidencePct)}
            unit="%"
            meta="Derived"
            metaTone={confidencePct >= 100 ? 'good' : undefined}
          />
        </DKpiStrip>

        {/* Progress + "not trusted until all verified" warning (design right rail). */}
        <div
          style={{
            border: '2px solid var(--m-ink)',
            background: allVerified ? 'var(--m-green-soft, var(--m-card-soft))' : 'var(--m-accent)',
            color: allVerified ? 'var(--m-ink)' : 'var(--m-accent-ink)',
            padding: '12px 16px',
            fontFamily: 'var(--m-num)',
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.02em',
          }}
        >
          {allVerified
            ? `All ${total} sheets verified — takeoff quantities are trusted.`
            : `Takeoff quantities aren't trusted until all ${total || ''} sheets are verified · ${verified} / ${total} done.`}
        </div>
        {verifyError ? <div style={{ fontSize: 12, color: 'var(--m-red)' }}>{verifyError}</div> : null}

        <DataTable<SheetRow>
          title="Sheets"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.pageId}
          empty={
            blueprints.isPending || pagesQuery.isPending
              ? 'Loading sheets…'
              : blueprints.isError || pagesQuery.isError
                ? 'Could not load sheets. Try again shortly.'
                : 'No sheets uploaded yet. Drawings land here once a blueprint is added.'
          }
        />

        <MButton variant="ghost" onClick={() => projectId && navigate(`/desktop/canvas/${projectId}`)}>
          Open takeoff · {needsReview} left
        </MButton>
      </div>
    </div>
  )
}
