/**
 * Today's scope — `wk-scope`. Read-only view of what the foreman scoped
 * for today: goal + steps. Pulls today's most-recent brief via
 * `useProjectBriefs` (apps/web/src/lib/api/projects.ts) and renders
 * each step as an expand-on-tap row. Falls back to a placeholder when
 * the foreman hasn't sent a brief yet.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
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
import { useProjectBriefs } from '../../lib/api/projects.js'
import type { ProjectBriefStep } from '../../lib/api/project-briefs.js'
import { todayIso } from './format.js'

export function WorkerScope({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const project = bootstrap?.projects.find((p) => /progress|active/i.test(p.status))
  const today = todayIso()

  const briefQuery = useProjectBriefs(project?.id ?? null, today)
  const brief = useMemo(() => {
    const list = briefQuery.data?.briefs ?? []
    return list[0] ?? null
  }, [briefQuery.data?.briefs])

  const steps: ProjectBriefStep[] = useMemo(() => {
    if (!brief) return []
    return Array.isArray(brief.steps) ? (brief.steps as ProjectBriefStep[]) : []
  }, [brief])

  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  return (
    <>
      <MTopBar back title="Scope" onBack={() => navigate('/today')} />
      <MBody pad>
        <MLargeHead
          eyebrow="TODAY'S SCOPE"
          title={brief?.goal ? truncateGoalForTitle(brief.goal) : (project?.division_code ?? 'Awaiting brief')}
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
            {brief?.goal
              ? brief.goal
              : project
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
          {steps.length > 0 ? (
            <MListInset>
              {steps.map((step, idx) => {
                const isExpanded = expandedIdx === idx
                return (
                  <div key={step.id ?? idx}>
                    <MListRow
                      leading={<MI.Layers size={18} />}
                      headline={step.title || `Step ${idx + 1}`}
                      supporting={describeStep(step)}
                      chev
                      onTap={() => setExpandedIdx(isExpanded ? null : idx)}
                    />
                    {isExpanded ? (
                      <div
                        style={{
                          padding: '4px 16px 14px',
                          color: 'var(--m-ink-2)',
                          fontSize: 13,
                          lineHeight: 1.5,
                        }}
                      >
                        {step.notes ? <div>{step.notes}</div> : null}
                        {step.materials ? (
                          <div className="m-quiet-sm" style={{ marginTop: 4 }}>
                            Materials: {step.materials}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </MListInset>
          ) : (
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
          )}
        </div>
        <div style={{ padding: 16 }}>
          <MButton variant="ghost" onClick={() => navigate('/issue?category=scope_question')}>
            Question this scope
          </MButton>
        </div>
      </MBody>
    </>
  )
}

function describeStep(step: ProjectBriefStep): string {
  const parts: string[] = []
  if (step.duration_min) parts.push(`${step.duration_min} min`)
  if (step.materials) parts.push(step.materials)
  return parts.join(' · ') || 'Tap to expand'
}

function truncateGoalForTitle(goal: string): string {
  if (goal.length <= 64) return goal
  return goal.slice(0, 60).trim() + '…'
}
