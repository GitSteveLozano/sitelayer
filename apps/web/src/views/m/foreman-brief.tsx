/**
 * Brief the crew — `fm-brief`. Morning composer the foreman uses to push
 * today's plan to workers. The output is the source of truth for
 * `wk-today` + `wk-scope`.
 *
 * Until a `briefs` table ships (open question deferred to Phase 8 server
 * follow-up), Phase 8's UI captures the brief locally and POSTs to a
 * temporary `/api/projects/:id/briefs` endpoint stub. If the endpoint
 * isn't there, the screen surfaces the error rather than silently
 * dropping the data.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiPost, type BootstrapResponse } from '../../api.js'
import {
  MBody,
  MButton,
  MI,
  MListInset,
  MListRow,
  MSectionH,
  MSelect,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'
import { MAiAgent } from '../../components/m/ai.js'

export function ForemanBrief({
  bootstrap,
  companySlug,
}: {
  bootstrap: BootstrapResponse | null
  companySlug: string
}) {
  const navigate = useNavigate()
  const params = useParams<{ projectId?: string }>()
  const projects = useMemo(
    () => bootstrap?.projects.filter((p) => /progress|active/i.test(p.status)) ?? [],
    [bootstrap?.projects],
  )
  const [projectId, setProjectId] = useState<string>(
    () => params.projectId ?? projects[0]?.id ?? '',
  )
  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId])

  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Default the goal to a reasonable starter once a project lands.
  useEffect(() => {
    if (project && !goal) {
      setGoal(`Continue ${project.division_code} per yesterday's plan. Leave the cornice for tomorrow.`)
    }
  }, [project, goal])

  const handleSend = async () => {
    if (!project) return
    setBusy(true)
    setError(null)
    try {
      await apiPost(
        `/api/projects/${project.id}/briefs`,
        {
          effective_date: new Date().toISOString().slice(0, 10),
          goal: goal.trim(),
          steps: [],
          crew: [],
          materials: [],
        },
        companySlug,
      )
      navigate('/m/today')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <MTopBar back title="Brief crew" sub={project?.name} onBack={() => navigate('/m/today')} />
      <MBody pad>
        {projects.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--m-ink-3)', fontSize: 13 }}>
            No active projects to brief. Once a project is in progress, it shows up here.
          </div>
        ) : (
          <>
            {projects.length > 1 ? (
              <div style={{ marginBottom: 12 }}>
                <MSelect
                  value={projectId}
                  onChange={(e) => setProjectId(e.currentTarget.value)}
                  style={{ width: '100%', height: 46 }}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </MSelect>
              </div>
            ) : null}
            <MSectionH>Today's scope</MSectionH>
            <MListInset>
              <MListRow leading={<MI.Layers size={18} />} leadingTone="accent" headline="East elevation" supporting="In progress · 56%" trailing={<MI.Check size={18} />} />
              <MListRow leading={<MI.Layers size={18} />} headline="West elevation" supporting="Not started" />
              <MListRow leading={<MI.Layers size={18} />} headline="Basecoat · East" supporting="Queued · needs EPS done" />
            </MListInset>
            <MSectionH>Today's goal</MSectionH>
            <MTextarea
              value={goal}
              onChange={(e) => setGoal(e.currentTarget.value)}
              style={{ width: '100%', minHeight: 110 }}
              placeholder="What's the crew building today, in plain words?"
              maxLength={280}
            />
            <div className="m-quiet-sm" style={{ marginTop: 4, textAlign: 'right' }}>
              {goal.length} / 280
            </div>
            <div style={{ marginTop: 16 }}>
              <MAiAgent attribution={<>Drafted from <strong>yesterday's progress</strong>.</>}>
                Yesterday's "Plate fasteners" wasn't completed — added it as Step 1 carryover.
              </MAiAgent>
            </div>
            {error ? (
              <div style={{ marginTop: 12, color: 'var(--m-red)', fontSize: 13 }}>{error}</div>
            ) : null}
            <div style={{ marginTop: 16 }}>
              <MButton variant="primary" onClick={handleSend} disabled={busy || !project}>
                {busy ? 'Sending…' : 'Send to crew'}
              </MButton>
            </div>
          </>
        )}
      </MBody>
    </>
  )
}
