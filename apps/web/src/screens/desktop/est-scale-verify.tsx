/**
 * Estimator desktop screen — EST · SCALE VERIFY (Desktop v2).
 *
 * Surfaces every blueprint sheet on a project with its detected drawing scale
 * so the estimator can confirm calibration before takeoff. Reuses the same
 * `useProjectBlueprints` resource as the mobile Files tab — there is no
 * dedicated scale-verify API yet, so confidence / status are *derived* from
 * the `sheet_scale` + calibration fields already on `BlueprintDocument`, and
 * the per-row "Verify" action is a no-op placeholder. See d-content +
 * '@/components/d' primitives (mirrors owner-dashboard.tsx).
 */
import { useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MButton, MPill } from '@/components/m'
import { useProjectBlueprints, type BlueprintDocument } from '@/lib/api/takeoff'

type SheetRow = {
  id: string
  name: string
  scale: string | null
  confidence: 'high' | 'low'
  verified: boolean
}

/** A sheet is "verified" once it carries a calibration length + unit. */
function isVerified(b: BlueprintDocument): boolean {
  return Boolean(b.calibration_length && b.calibration_unit)
}

/**
 * Derived confidence — there is no detector confidence score in the API yet.
 * A sheet with both a declared `sheet_scale` and a completed calibration is
 * treated as high-confidence; anything missing one is low.
 * // TODO: replace with a real scale-detection confidence once the
 * //       scale-verify pipeline lands.
 */
function deriveConfidence(b: BlueprintDocument): 'high' | 'low' {
  return b.sheet_scale && isVerified(b) ? 'high' : 'low'
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

export function EstScaleVerify() {
  const { projectId } = useParams<{ projectId: string }>()
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

  // No scale-verify API yet — accepting a detected scale is a no-op for now.
  // TODO: wire to POST /api/blueprints/:id scale-verify once the endpoint ships.
  const handleVerify = (_row: SheetRow) => {
    /* no-op placeholder */
  }

  const columns: Array<DColumn<SheetRow>> = [
    { key: 'name', header: 'Sheet', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'scale', header: 'Detected scale', render: (r) => r.scale ?? '—' },
    {
      key: 'confidence',
      header: 'Confidence',
      render: (r) => (
        <MPill tone={r.confidence === 'high' ? 'green' : 'amber'} dot>
          {r.confidence === 'high' ? 'High' : 'Low'}
        </MPill>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone={r.verified ? 'green' : 'amber'} dot>
          {r.verified ? 'Verified' : 'Needs review'}
        </MPill>
      ),
    },
    {
      key: 'verify',
      header: '',
      render: (r) => (
        <MButton size="sm" variant="ghost" onClick={() => handleVerify(r)}>
          Verify
        </MButton>
      ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Estimator · Scale</DEyebrow>
          <DH1>Verify scale</DH1>
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
