/**
 * Mobile takeoff entry — lists this project's blueprints with thumbnail
 * links to the full takeoff canvas. Phase 5 stops here; a native mobile
 * takeoff canvas with pinch-to-zoom + polygon gestures is a follow-up.
 *
 * For now the canvas itself uses the existing /takeoffs/:projectId desktop
 * route — opening it on mobile works but isn't optimized. The mobile entry
 * surfaces blueprint metadata, lineage, and an "Open in canvas" CTA.
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet } from '../../api-v1-compat.js'
import { MBody, MButton, MI, MListInset, MListRow, MSectionH, MTopBar } from '../../components/m/index.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'
import { shortDate } from './format.js'

type BlueprintRow = {
  id: string
  project_id: string
  filename: string
  storage_path: string
  uploaded_at: string
  page_count: number | null
  deleted_at: string | null
  replaces_blueprint_document_id?: string | null
}

export function MobileTakeoffList({ companySlug }: { companySlug: string }) {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  const [blueprints, setBlueprints] = useState<readonly BlueprintRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    apiGet<{ blueprints: BlueprintRow[] }>(`/api/projects/${projectId}/blueprints`, companySlug)
      .then((res) => {
        if (cancelled) return
        setBlueprints(res.blueprints.filter((b) => !b.deleted_at))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, companySlug])

  return (
    <>
      <MTopBar back title="Blueprints" onBack={() => navigate(`/m/projects/${projectId}`)} />
      <MBody>
        {error ? (
          <div style={{ padding: 24, color: 'var(--m-red)', fontSize: 13 }}>{error}</div>
        ) : blueprints === null ? (
          <>
            <MSectionH>Loading…</MSectionH>
            <MSkeletonList count={3} />
          </>
        ) : blueprints.length === 0 ? (
          <MEmptyState
            title="No drawings yet"
            body="Upload a PDF or image to start the takeoff. Sitelayer will help you trace polygons and compute square footage."
            primaryLabel="Upload drawing"
            onPrimary={() => navigate(`/takeoffs/${projectId}`)}
          />
        ) : (
          <>
            <MSectionH link="Open canvas" onLinkClick={() => navigate(`/takeoffs/${projectId}`)}>
              {blueprints.length} {blueprints.length === 1 ? 'drawing' : 'drawings'}
            </MSectionH>
            <MListInset>
              {blueprints.map((b) => (
                <MListRow
                  key={b.id}
                  leading={<MI.Layers size={18} />}
                  leadingTone="accent"
                  headline={b.filename}
                  supporting={`${b.page_count ?? 1} ${(b.page_count ?? 1) === 1 ? 'page' : 'pages'} · uploaded ${shortDate(b.uploaded_at)}`}
                  trailing={b.replaces_blueprint_document_id ? <span style={{ fontSize: 11 }}>v2+</span> : null}
                  chev
                  onTap={() => navigate(`/takeoffs/${projectId}?blueprint=${b.id}`)}
                />
              ))}
            </MListInset>
            <div style={{ padding: '16px' }}>
              <MButton variant="primary" onClick={() => navigate(`/takeoffs/${projectId}`)}>
                Open takeoff canvas
              </MButton>
            </div>
          </>
        )}
      </MBody>
    </>
  )
}
