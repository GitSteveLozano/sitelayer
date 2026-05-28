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
import { MButton, MPill, MSectionH } from '../../../components/m/index.js'
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
              border: '2px solid var(--m-line)',
              fontFamily: 'var(--m-num)',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.02em',
              textTransform: 'uppercase',
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
              padding: '18px 16px',
              border: '2px solid var(--m-line)',
              boxShadow: 'var(--m-shadow-offset)',
              background: 'var(--m-card-soft)',
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--m-ink-3)',
                fontFamily: 'var(--m-num)',
                marginBottom: 6,
              }}
            >
              No plan set
            </div>
            <div
              style={{
                fontSize: 14,
                fontFamily: 'var(--m-font-display)',
                fontWeight: 600,
                color: 'var(--m-ink)',
                lineHeight: 1.4,
                marginBottom: 14,
              }}
            >
              Drop a PDF or photo of the elevations and Sitelayer will help you measure scope on the takeoff canvas.
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
      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {blueprints.map((b) => (
          <BlueprintRow key={b.id} b={b} onTap={() => navigate(`/projects/${project.id}/takeoff`)} />
        ))}
      </div>
      <div style={{ padding: '14px 16px 16px' }}>
        <MButton variant="ghost" onClick={() => navigate(`/projects/${project.id}/takeoff`)}>
          Open takeoff canvas
        </MButton>
      </div>
    </div>
  )
}

/**
 * Blueprint document row — v2 brutalist sheet. Square hatched-sheet thumbnail
 * (mirrors V2EstSheetNav's title-block + takeoff overlay) + filename in the
 * tight display face + mono meta line (type · revision · date) + status pill.
 */
function BlueprintRow({ b, onTap }: { b: BlueprintDocument; onTap: () => void }) {
  const calibrated = isCalibrated(b)
  return (
    <button
      type="button"
      onClick={onTap}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 0,
        width: '100%',
        textAlign: 'left',
        padding: 0,
        cursor: 'pointer',
        background: 'var(--m-card-soft)',
        border: '2px solid var(--m-line)',
        boxShadow: 'var(--m-shadow-offset)',
        fontFamily: 'var(--m-font)',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: 72,
          flexShrink: 0,
          background: 'var(--m-sand-2)',
          borderRight: '2px solid var(--m-line)',
        }}
      >
        <svg viewBox="0 0 140 80" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
          <rect x="8" y="8" width="124" height="64" fill="none" stroke="var(--m-line)" strokeWidth="1.5" />
          <rect x="14" y="20" width="80" height="44" fill="var(--m-accent)" opacity={calibrated ? 0.4 : 0} />
          <rect x="14" y="20" width="80" height="44" fill="none" stroke="var(--m-line)" strokeWidth="1.2" />
        </svg>
        {calibrated ? (
          <div
            style={{
              position: 'absolute',
              top: 4,
              left: 4,
              padding: '1px 5px',
              background: 'var(--m-line)',
              color: 'var(--m-accent)',
              fontFamily: 'var(--m-num)',
              fontSize: 9,
              fontWeight: 700,
            }}
          >
            ✓
          </div>
        ) : (
          <div
            style={{
              position: 'absolute',
              top: 5,
              right: 5,
              width: 8,
              height: 8,
              background: 'var(--m-amber)',
              border: '1.5px solid var(--m-line)',
            }}
          />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 700,
              fontSize: 14,
              letterSpacing: '-0.01em',
              color: 'var(--m-ink)',
              lineHeight: 1.2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {b.file_name || 'Untitled drawing'}
          </div>
          {calibrated ? (
            <MPill tone="green" dot>
              Scaled
            </MPill>
          ) : (
            <MPill tone="amber" dot>
              Set scale
            </MPill>
          )}
        </div>
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-3)',
          }}
        >
          {blueprintSupporting(b)}
        </div>
      </div>
    </button>
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
  if (b.replaces_blueprint_document_id) parts.push('rev')
  const date = formatBlueprintDate(b.created_at)
  if (date) parts.push(date)
  return parts.join(' · ') || 'Drawing'
}

function formatBlueprintDate(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase()
}
