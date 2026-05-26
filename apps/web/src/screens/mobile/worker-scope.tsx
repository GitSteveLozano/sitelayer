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
import { MAvatar, MBody, MButton, MI, MLargeHead, MTopBar, initialsFor } from '../../components/m/index.js'
import { useProjectBriefs } from '../../lib/api/projects.js'
import type { ProjectBriefStep } from '../../lib/api/project-briefs.js'
import { timeOfDay, todayIso } from './format.js'
import { deriveStepStatuses, sumStepSqftDone, type ScopeStepStatus } from './worker-scope-steps.js'

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

  const stepStatuses = useMemo<ScopeStepStatus[]>(() => deriveStepStatuses(steps), [steps])
  const doneCount = stepStatuses.filter((s) => s === 'done').length

  // Today's goal target (SF) comes from the project's target throughput;
  // reported progress prefers per-step `sqft_done`. The percentage is
  // SF-done over target when both are present, otherwise the share of
  // completed steps so the bar still reflects real progress.
  const targetSqft = useMemo(() => {
    const raw = project?.target_sqft_per_hr
    const n = raw == null ? NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  }, [project?.target_sqft_per_hr])
  const sqftDone = useMemo(() => sumStepSqftDone(steps), [steps])
  const progressPct = useMemo(() => {
    if (sqftDone !== null && targetSqft) return Math.min(100, Math.round((sqftDone / targetSqft) * 100))
    if (steps.length > 0) return Math.round((doneCount / steps.length) * 100)
    return 0
  }, [sqftDone, targetSqft, steps.length, doneCount])

  const foreman = useMemo(
    () => bootstrap?.workers.find((w) => /lead|foreman/i.test(w.role ?? '')) ?? null,
    [bootstrap?.workers],
  )
  const scopedAt = brief?.created_at ? timeOfDay(brief.created_at) : null

  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  return (
    <>
      <MTopBar back title="Scope" onBack={() => navigate('/today')} />
      <MBody pad>
        <MLargeHead
          eyebrow="TODAY'S SCOPE"
          title={project?.division_code ?? 'Awaiting brief'}
          sub={project?.name ?? 'Foreman has not sent today’s brief yet.'}
        />
        {/* Today's goal — dark accent-tinted card with the SF target
            right-aligned and a real progress bar. */}
        <div
          style={{
            marginTop: 8,
            padding: 14,
            borderRadius: 14,
            background: 'var(--m-accent-soft)',
            border: '1px solid var(--m-accent-soft-2)',
          }}
        >
          <div
            className="m-topbar-eyebrow"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}
          >
            <span>TODAY'S GOAL</span>
            {targetSqft ? (
              <span className="num" style={{ color: 'var(--m-accent-ink)', textTransform: 'none', fontWeight: 600 }}>
                {targetSqft.toLocaleString('en-US')} sf
              </span>
            ) : null}
          </div>
          <div style={{ fontSize: 15, fontWeight: 500, marginTop: 8, lineHeight: 1.45 }}>
            {brief?.goal
              ? brief.goal
              : project
                ? 'Continue scope per yesterday’s plan. Foreman brief loads here when sent.'
                : 'No active project. Check with your foreman.'}
          </div>
          {targetSqft || steps.length > 0 ? (
            <div style={{ marginTop: 14 }}>
              <div
                className="num"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 10,
                  color: 'var(--m-ink-3)',
                  letterSpacing: '0.04em',
                  marginBottom: 6,
                }}
              >
                <span>
                  {sqftDone !== null ? `${sqftDone.toLocaleString('en-US')} SF DONE` : `${doneCount} STEPS DONE`}
                </span>
                <span>{progressPct}% OF TODAY</span>
              </div>
              <div className="m-progress">
                <div className="m-progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
            </div>
          ) : null}
          {foreman ? (
            <div
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: '1px solid var(--m-line)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <MAvatar initials={initialsFor(foreman.name)} size="sm" />
              <span className="m-quiet-sm">
                Scoped by <strong style={{ color: 'var(--m-ink-2)' }}>{foreman.name}</strong>
                {scopedAt ? ` · ${scopedAt}` : ''}
              </span>
            </div>
          ) : null}
        </div>
        <div style={{ marginTop: 16 }}>
          <div className="m-section-h">Steps</div>
          {steps.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {steps.map((step, idx) => (
                <StepRow
                  key={step.id ?? idx}
                  index={idx}
                  step={step}
                  status={stepStatuses[idx] ?? 'upcoming'}
                  expanded={expandedIdx === idx}
                  onToggle={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
                />
              ))}
            </div>
          ) : (
            <div className="m-quiet-sm" style={{ padding: '4px 2px' }}>
              No steps in today’s brief yet. Your foreman adds them in the morning brief.
            </div>
          )}
        </div>
        <div style={{ padding: '16px 0' }}>
          <MButton variant="ghost" onClick={() => navigate('/issue?category=scope_question')}>
            Question this scope
          </MButton>
        </div>
      </MBody>
    </>
  )
}

/**
 * One scope step, rendered as a dark card matching `wk-scope`. The status
 * marker is a 26px disc: green check when done, accent dot when in
 * progress, an outlined index number when upcoming. Active steps tint the
 * whole card accent and show a "NOW" tag. Tapping expands inline notes.
 */
function StepRow({
  index,
  step,
  status,
  expanded,
  onToggle,
}: {
  index: number
  step: ProjectBriefStep
  status: ScopeStepStatus
  expanded: boolean
  onToggle: () => void
}) {
  const isDone = status === 'done'
  const isActive = status === 'in_progress'
  const title = step.title || `Step ${index + 1}`
  return (
    <div
      style={{
        borderRadius: 12,
        background: isActive ? 'var(--m-accent-soft)' : 'var(--m-card)',
        border: isActive ? '1px solid var(--m-accent-soft-2)' : '1px solid var(--m-line)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          textAlign: 'left',
          color: 'inherit',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 26,
            height: 26,
            borderRadius: 13,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: isDone ? 'var(--m-green)' : isActive ? 'var(--m-accent)' : 'transparent',
            border: isDone || isActive ? 'none' : '1.5px solid var(--m-line-2)',
            color: '#fff',
          }}
        >
          {isDone ? (
            <MI.Check size={15} />
          ) : (
            <span
              className="num"
              style={{ fontSize: 11, fontWeight: 700, color: isActive ? '#fff' : 'var(--m-ink-3)' }}
            >
              {index + 1}
            </span>
          )}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: 'block',
              fontSize: 13,
              fontWeight: isActive ? 600 : 500,
              color: isDone ? 'var(--m-ink-3)' : 'var(--m-ink)',
              textDecoration: isDone ? 'line-through' : 'none',
            }}
          >
            {title}
          </span>
          <span className="m-quiet-sm num" style={{ display: 'block', marginTop: 2 }}>
            {describeStep(step)}
          </span>
        </span>
        {isActive ? (
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--m-accent)', letterSpacing: '0.06em' }}>NOW</span>
        ) : null}
      </button>
      {expanded && (step.notes || step.materials) ? (
        <div style={{ padding: '0 12px 12px 50px', color: 'var(--m-ink-2)', fontSize: 13, lineHeight: 1.5 }}>
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
}

function describeStep(step: ProjectBriefStep): string {
  const parts: string[] = []
  if (step.duration_min) parts.push(`${step.duration_min} min`)
  if (step.materials) parts.push(step.materials)
  return parts.join(' · ') || 'Tap to expand'
}
