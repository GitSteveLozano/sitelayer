/**
 * Mobile takeoff entry — lists this project's blueprints and opens the
 * NATIVE mobile takeoff surface (`mb-takeoff`, see takeoff-mobile.tsx)
 * instead of linking out to the heavy desktop `takeoff-canvas`.
 *
 * Audit fix (finish-mobile-to-design): the old behaviour navigated to the
 * full-viewport `/projects/:id/takeoff-canvas` route declared in App.tsx,
 * which lives OUTSIDE the mobile shell. A phone user dropped into the
 * desktop polygon canvas. Now every "open takeoff" affordance routes to
 * the in-shell `projects/:projectId/takeoff-mobile` screen, which lets the
 * user manage drafts, browse blueprint pages, and add real measurements
 * (manual quantity + tap-to-draw) without leaving the mobile experience.
 *
 * NOTE FOR INTEGRATOR: the `projects/:projectId/takeoff-mobile` route must
 * be declared in mobile-shell.tsx (see report). Until then these
 * navigations 404. The blueprint thumbnail rows pass `?blueprint=<id>`
 * which the mobile screen reads to preselect the drawing.
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet } from '@/lib/api'
import { MBody, MButton, MI, MListInset, MListRow, MSectionH, MTopBar } from '../../components/m/index.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'
import { shortDate } from './format.js'

// Mirrors the response from `GET /api/projects/:id/blueprints`. The API
// uses `file_name` / `created_at`; do not rename to camel-case here —
// callers compare straight against the persisted shape.
type BlueprintRow = {
  id: string
  project_id: string
  file_name: string
  storage_path: string
  created_at: string
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
      <MTopBar back title="Blueprints" onBack={() => navigate(`/projects/${projectId}`)} />
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
            body="You can still run a takeoff: enter manual quantities per scope item, or upload a drawing to trace polygons and compute square footage."
            primaryLabel="Start takeoff"
            onPrimary={() => navigate(`/projects/${projectId}/takeoff-mobile`)}
          />
        ) : (
          <>
            <MSectionH link="Open takeoff" onLinkClick={() => navigate(`/projects/${projectId}/takeoff-mobile`)}>
              {blueprints.length} {blueprints.length === 1 ? 'drawing' : 'drawings'}
            </MSectionH>
            <MListInset>
              {blueprints.map((b) => (
                <MListRow
                  key={b.id}
                  leading={<MI.Layers size={18} />}
                  leadingTone="accent"
                  headline={b.file_name}
                  supporting={`Uploaded ${shortDate(b.created_at)}`}
                  trailing={b.replaces_blueprint_document_id ? <span style={{ fontSize: 11 }}>v2+</span> : null}
                  chev
                  onTap={() => navigate(`/projects/${projectId}/takeoff-mobile?blueprint=${b.id}`)}
                />
              ))}
            </MListInset>
            <div style={{ padding: '16px' }}>
              <MButton variant="primary" onClick={() => navigate(`/projects/${projectId}/takeoff-mobile`)}>
                Open mobile takeoff
              </MButton>
            </div>
          </>
        )}
      </MBody>
    </>
  )
}
