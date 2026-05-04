/**
 * Today's scope — `wk-scope`. Read-only view of what the foreman scoped
 * for today: goal + steps. Phase 7 renders a placeholder until the
 * briefs surface ships in Phase 8 (foreman brief composer).
 *
 * For now we surface the project name + a "scoped by" line and a Question
 * this scope CTA that routes to the issue flow.
 */
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '../../api.js'
import {
  MAvatar,
  MBody,
  MButton,
  MI,
  MLargeHead,
  MListInset,
  MListRow,
  MTopBar,
  initialsFor,
} from '../../components/m/index.js'

export function WorkerScope({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const project = bootstrap?.projects.find((p) => /progress|active/i.test(p.status))

  return (
    <>
      <MTopBar back title="Scope" onBack={() => navigate('/m/today')} />
      <MBody pad>
        <MLargeHead
          eyebrow="TODAY'S SCOPE"
          title={project?.division_code ?? 'Awaiting brief'}
          sub={project?.name ?? 'Foreman has not sent today’s brief yet.'}
        />
        <div className="m-card" style={{ marginTop: 8 }}>
          <div className="m-topbar-eyebrow" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>TODAY'S GOAL</span>
            {project?.target_sqft_per_hr ? (
              <span style={{ color: 'var(--m-accent-ink)' }}>{project.target_sqft_per_hr} sf/hr</span>
            ) : null}
          </div>
          <div style={{ fontSize: 16, fontWeight: 500, marginTop: 6, lineHeight: 1.4 }}>
            {project
              ? 'Continue scope per yesterday’s plan. Foreman brief loads here when sent.'
              : 'No active project. Check with your foreman.'}
          </div>
          <div className="m-quiet-sm" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <MAvatar
              initials={initialsFor(
                bootstrap?.workers.find((w) => /lead|foreman/i.test(w.role ?? ''))?.name ?? 'Foreman',
              )}
              tone="5"
              size="sm"
            />
            <span>
              Scoped by <strong style={{ color: 'var(--m-ink-2)' }}>your foreman</strong>
            </span>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <MListInset>
            <MListRow
              leading={<MI.Check size={18} />}
              leadingTone="green"
              headline="Step 1 — set up zone"
              supporting="Done"
            />
            <MListRow
              leading={<span className="m-statusdot" data-tone="accent" />}
              headline="Step 2 — install board"
              supporting="In progress"
            />
            <MListRow leading={<MI.Layers size={18} />} headline="Step 3 — plate fasteners" supporting="Up next" />
          </MListInset>
        </div>
        <div style={{ padding: 16 }}>
          <MButton variant="ghost" onClick={() => navigate('/m/issue?category=scope_question')}>
            Question this scope
          </MButton>
        </div>
      </MBody>
    </>
  )
}
