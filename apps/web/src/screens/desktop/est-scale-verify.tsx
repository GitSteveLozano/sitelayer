/**
 * Estimator desktop screen — EST · SCALE VERIFY (Desktop v2).
 *
 * Surfaces every blueprint sheet on a project with its detected drawing scale
 * so the estimator can confirm calibration before takeoff. Reuses the same
 * `useProjectBlueprints` resource as the mobile Files tab — there is no
 * dedicated scale-verify API yet, so confidence (HIGH/MED/LOW) is *derived*
 * from the `sheet_scale` + calibration fields already on `BlueprintDocument`,
 * and the per-row "Check" action opens the canvas scale overlay to calibrate.
 * See d-content + '@/components/d' primitives (mirrors owner-dashboard.tsx).
 */
import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MButton, MPill } from '@/components/m'
import { useProjectBlueprints, type BlueprintDocument } from '@/lib/api/takeoff'

type Confidence = 'high' | 'med' | 'low'

type SheetRow = {
  id: string
  name: string
  scale: string | null
  confidence: Confidence
  verified: boolean
}

/** A sheet is "verified" once it carries a calibration length + unit. */
function isVerified(b: BlueprintDocument): boolean {
  return Boolean(b.calibration_length && b.calibration_unit)
}

/**
 * Derived confidence — there is no detector confidence score in the API yet,
 * so we tier off the calibration/scale fields already on the document
 * (matches the design's HIGH / MED / LOW spec on EST · SCALE VERIFY):
 *   HIGH  — a declared `sheet_scale` AND a completed two-point calibration.
 *   MED   — a declared `sheet_scale` but calibration not yet confirmed.
 *   LOW   — no readable scale at all (NTS / detail sheet / missing title block).
 * // TODO: replace with a real scale-detection confidence once the
 * //       scale-verify pipeline lands.
 */
function deriveConfidence(b: BlueprintDocument): Confidence {
  if (!b.sheet_scale) return 'low'
  return isVerified(b) ? 'high' : 'med'
}

function toRow(b: BlueprintDocument): SheetRow {
  return {
    id: b.id,
    name: b.file_name || 'Untitled sheet',
    scale: b.sheet_scale,
    confidence: deriveConfidence(b),
    verified: isVerified(b),
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
  const query = useProjectBlueprints(projectId)

  const rows = useMemo<SheetRow[]>(() => {
    const blueprints = (query.data?.blueprints ?? []).filter((b) => !b.deleted_at)
    return blueprints.map(toRow)
  }, [query.data?.blueprints])

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

  // No dedicated scale-verify endpoint yet, so a per-row CHECK opens the canvas
  // scale-calibration overlay for the sheet — the real "set scale" flow — rather
  // than persisting a one-click confirmation from here.
  // TODO: wire a one-click POST /api/blueprints/:id verification once the
  //       scale-verify pipeline ships, so CHECK can confirm in place.
  const handleVerify = (_row: SheetRow) => {
    if (projectId) navigate(`/desktop/canvas/${projectId}`)
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
      // VERIFY column (design): a green "● VERIFIED" pill once calibrated, else
      // a black CHECK action that opens the canvas scale overlay for the sheet.
      key: 'verify',
      header: 'Verify',
      render: (r) =>
        r.verified ? (
          <MPill tone="green" dot>
            Verified
          </MPill>
        ) : (
          <MButton size="sm" variant="primary" onClick={() => handleVerify(r)}>
            Check
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
            meta={verified > 0 ? 'Calibrated' : 'None yet'}
            metaTone={verified > 0 ? 'good' : undefined}
          />
          <DKpi
            label="Needs review"
            value={String(needsReview)}
            tone={needsReview > 0 ? 'accent' : undefined}
            meta="Awaiting calibration"
          />
          <DKpi
            label="Confidence"
            value={String(confidencePct)}
            unit="%"
            meta="Derived"
            metaTone={confidencePct >= 100 ? 'good' : undefined}
          />
        </DKpiStrip>

        <DataTable<SheetRow>
          title="Sheets"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty={
            query.isPending
              ? 'Loading sheets…'
              : query.isError
                ? 'Could not load sheets. Try again shortly.'
                : 'No sheets uploaded yet. Drawings land here once a blueprint is added.'
          }
        />
      </div>
    </div>
  )
}
