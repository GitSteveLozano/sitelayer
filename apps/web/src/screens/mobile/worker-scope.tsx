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
import { MBody, MButton, MI, MLargeHead, MTopBar } from '../../components/m/index.js'
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

  const goalText = brief?.goal
    ? brief.goal
    : project
      ? 'Continue scope per yesterday’s plan. Foreman brief loads here when sent.'
      : 'No active project. Check with your foreman.'

  return (
    <>
      <MTopBar back title="Scope" onBack={() => navigate('/today')} />
      <MBody>
        <MLargeHead
          eyebrow="SCOPE · TODAY"
          title={project?.division_code ?? 'Awaiting brief'}
          sub={project?.name ?? 'Foreman has not sent today’s brief yet.'}
        />
        {/* Goal slab — accent eyebrow tag + a big tight-font statement of
            today's goal, sitting on the dark shell. */}
        <div style={{ padding: 20, borderBottom: '2px solid var(--m-sand-2)' }}>
          <div className="m-topbar-eyebrow" data-tone="accent" style={{ display: 'inline-block' }}>
            {scopedAt ? `FROM ${(foreman?.name ?? 'FOREMAN').toUpperCase()} · ${scopedAt}` : "TODAY'S GOAL"}
          </div>
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 700,
              fontSize: 24,
              lineHeight: 1.1,
              letterSpacing: '-0.015em',
              marginTop: 12,
              color: 'var(--m-ink)',
            }}
          >
            {goalText}
          </div>
        </div>
        {/* Progress slab — mono SF-done / % row over a thick bar. */}
        {targetSqft || steps.length > 0 ? (
          <div
            style={{
              padding: '18px 20px',
              borderBottom: '2px solid var(--m-sand-2)',
              background: 'var(--m-card-soft)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div className="m-topbar-eyebrow" style={{ color: 'var(--m-ink-4)' }}>
                {sqftDone !== null ? `${sqftDone.toLocaleString('en-US')} SF DONE` : `${doneCount} STEPS DONE`}
                {targetSqft ? ` / ${targetSqft.toLocaleString('en-US')} SF` : ''}
              </div>
              <div className="num" style={{ color: 'var(--m-accent)', fontWeight: 700, letterSpacing: '0.04em' }}>
                {progressPct}% TODAY
              </div>
            </div>
            <div className="m-progress" style={{ height: 8, marginTop: 10 }}>
              <div className="m-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        ) : null}
        {/* Numbered step list. */}
        {steps.length > 0 ? (
          <div>
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
          <div className="m-quiet-sm" style={{ padding: '16px 20px' }}>
            No steps in today’s brief yet. Your foreman adds them in the morning brief.
          </div>
        )}
        <div style={{ padding: '20px' }}>
          <MButton variant="ghost" onClick={() => navigate('/issue?category=scope_question')}>
            Question this scope
          </MButton>
        </div>
      </MBody>
    </>
  )
}

/**
 * One scope step, rendered as a full-bleed brutalist list row mirroring
 * `V2WorkerScopeToday`. The status marker is a 36px square: green ✓ when
 * done, an ink square w/ index when active, an outlined index when queued.
 * The active row fills with accent and shows a "NOW" tag; done rows strike
 * the title through. Tapping expands inline notes.
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
  const rowText = isActive ? 'var(--m-accent-ink)' : 'var(--m-ink)'
  const subColor = isActive ? 'var(--m-accent-ink)' : 'var(--m-ink-4)'
  return (
    <div
      style={{
        borderBottom: '1px solid var(--m-line-2)',
        background: isActive ? 'var(--m-accent)' : 'transparent',
        color: rowText,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: '16px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          textAlign: 'left',
          color: 'inherit',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 36,
            height: 36,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: isDone ? 'var(--m-green)' : isActive ? 'var(--m-sand)' : 'transparent',
            border: isDone || isActive ? '2px solid var(--m-sand)' : '2px solid var(--m-sand-2)',
            color: isDone || isActive ? '#fff' : 'var(--m-ink-4)',
            fontFamily: 'var(--m-font-display)',
            fontWeight: 800,
            fontSize: 16,
          }}
        >
          {isDone ? <MI.Check size={20} /> : <span className="num">{index + 1}</span>}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: 'block',
              fontFamily: 'var(--m-font-display)',
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: '-0.005em',
              color: isDone ? 'var(--m-ink-4)' : rowText,
              textDecoration: isDone ? 'line-through' : 'none',
            }}
          >
            {title}
          </span>
          <span
            className="num"
            style={{ display: 'block', marginTop: 3, fontSize: 11, fontWeight: 600, color: subColor }}
          >
            {describeStep(step)}
          </span>
        </span>
        {isActive ? (
          <span className="num" style={{ fontWeight: 800, color: 'var(--m-accent-ink)', letterSpacing: '0.06em' }}>
            NOW
          </span>
        ) : null}
      </button>
      {expanded && (step.notes || step.materials) ? (
        <div style={{ padding: '0 20px 16px 70px', color: subColor, fontSize: 13, lineHeight: 1.5 }}>
          {step.notes ? <div>{step.notes}</div> : null}
          {step.materials ? (
            <div className="num" style={{ marginTop: 4, fontSize: 11, fontWeight: 600, color: subColor }}>
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
