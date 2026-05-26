/**
 * Files tab — native mobile view of the project's drawings / blueprints.
 *
 * Per the v3.3.0 estimator design (prj-detail "Files" sub-nav: "drawings,
 * contracts, signed estimates, photos" + the "Site & blueprint" card in
 * prj-drafting), this lists the uploaded blueprint documents with their
 * file name + calibration state, and taps through to the takeoff canvas
 * where they're measured. No more bare desktop link-out.
 *
 * Sources GET /api/projects/:id/blueprints via `useProjectBlueprints`.
 * Loading renders skeleton rows; empty offers the "Open blueprints /
 * takeoff" CTA so the estimator can drop the first drawing.
 */
import type { ProjectRow } from '@/lib/api'
import { MButton, MI, MListInset, MListRow, MPill, MSectionH } from '../../../components/m/index.js'
import { MSkeletonList } from '../../../components/m-states/index.js'
import { useProjectBlueprints, type BlueprintDocument } from '../../../lib/api/takeoff.js'

export function FilesTab({ project, navigate }: { project: ProjectRow; navigate: (path: string) => void }) {
  const query = useProjectBlueprints(project.id)

  if (query.isPending) {
    return (
      <div style={{ paddingTop: 8 }}>
        <MSectionH>Drawings</MSectionH>
        <MSkeletonList count={3} />
      </div>
    )
  }

  if (query.isError) {
    return (
      <div style={{ paddingTop: 8 }}>
        <div style={{ padding: '0 16px' }}>
          <div
            style={{
              padding: '14px 16px',
              border: '1px solid var(--m-line)',
              borderRadius: 12,
              fontSize: 13,
              color: 'var(--m-red)',
            }}
          >
            Could not load drawings. Try again shortly.
          </div>
        </div>
      </div>
    )
  }

  const blueprints = (query.data?.blueprints ?? []).filter((b) => !b.deleted_at)

  if (blueprints.length === 0) {
    return (
      <div style={{ paddingTop: 8 }}>
        <div style={{ padding: '0 16px 12px' }}>
          <div
            style={{
              padding: '14px 16px',
              border: '1px solid var(--m-line)',
              borderRadius: 12,
              background: 'var(--m-card-soft)',
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--m-ink-3)',
                marginBottom: 4,
              }}
            >
              Files
            </div>
            <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.45, marginBottom: 12 }}>
              No drawings yet. Drop a PDF or photo of the elevations and Sitelayer will help you measure scope on the
              takeoff canvas.
            </div>
            <MButton variant="primary" size="sm" onClick={() => navigate(`/projects/${project.id}/takeoff`)}>
              Open takeoff
            </MButton>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ paddingTop: 8 }}>
      <MSectionH>{`${blueprints.length} ${blueprints.length === 1 ? 'drawing' : 'drawings'}`}</MSectionH>
      <MListInset>
        {blueprints.map((b) => (
          <MListRow
            key={b.id}
            leading={<MI.Layers size={18} />}
            leadingTone="accent"
            headline={b.file_name || 'Untitled drawing'}
            supporting={blueprintSupporting(b)}
            trailing={
              isCalibrated(b) ? (
                <MPill tone="green" dot>
                  Scaled
                </MPill>
              ) : (
                <MPill tone="amber" dot>
                  Set scale
                </MPill>
              )
            }
            chev
            onTap={() => navigate(`/projects/${project.id}/takeoff`)}
          />
        ))}
      </MListInset>
      <div style={{ padding: '12px 16px 16px' }}>
        <MButton variant="ghost" onClick={() => navigate(`/projects/${project.id}/takeoff`)}>
          Open takeoff canvas
        </MButton>
      </div>
    </div>
  )
}

function isCalibrated(b: BlueprintDocument): boolean {
  return Boolean(b.calibration_length && b.calibration_unit)
}

function blueprintSupporting(b: BlueprintDocument): string {
  const parts: string[] = []
  if (b.preview_type) parts.push(b.preview_type.toUpperCase())
  if (b.calibration_length && b.calibration_unit) {
    parts.push(`${b.calibration_length} ${b.calibration_unit} scale`)
  }
  if (b.replaces_blueprint_document_id) parts.push('revision')
  return parts.join(' · ') || 'Drawing'
}
