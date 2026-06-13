/**
 * Brief the crew — `fm-brief`. Morning composer the foreman uses to push
 * today's plan to workers. The output is the source of truth for
 * `wk-today` + `wk-scope`.
 *
 * Pre-fill behaviour:
 *   1. If yesterday has a brief on this project, copy its goal + steps.
 *   2. Otherwise, seed steps from the project's estimate lines (via
 *      useScopeVsBid) so the foreman starts with the contract scope and
 *      edits down to today's slice.
 *
 * Submits via `useCreateProjectBrief` -> POST /api/projects/:id/briefs.
 * Reorder uses simple up/down arrows — no DnD library; the design
 * pattern explicitly accepts that for the morning-brief surface.
 */
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { useSubmitForm } from '../../machines/submit-form.js'
import {
  MBody,
  MButton,
  MI,
  MInput,
  MListInset,
  MListRow,
  MSectionH,
  MSelect,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'
import { DEyebrow, DH1, DModal } from '../../components/d/index.js'
import { MAiAgent } from '../../components/m/ai.js'
import { useCreateProjectBrief, type ProjectBriefStep } from '../../lib/api/project-briefs.js'
import { useProjectBriefs } from '../../lib/api/projects.js'
import { useScopeVsBid } from '../../lib/api/estimate.js'
import { useIsDesktop } from '../../lib/use-is-desktop.js'
import { resolveForemanNav } from '../foreman-nav.js'
import { todayIso } from './format.js'

/**
 * Responsive Foreman Brief composer. Mounts the dense desktop author + sticky
 * live-preview split (the former `screens/desktop/fm-brief.tsx`,
 * `ForemanBriefDesktop`, with its edit-mode + send-reminders modal) at >=1024px
 * and the richer mobile composer below it. Both submit through the SAME
 * `useSubmitForm` + `useCreateProjectBrief` (POST /api/projects/:id/briefs); the
 * mobile composer additionally prefills from yesterday's brief / the estimate
 * scope, edits per-step time/crew/materials, and has a dedicated preview screen.
 * Only ONE render mounts at a time. Navigation is resolved via
 * `resolveForemanNav` so each surface returns to its own Today board.
 */
export function ForemanBrief(props: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const isDesktop = useIsDesktop()
  return isDesktop ? <ForemanBriefDesktop /> : <ForemanBriefMobile {...props} />
}

/** Desktop-route alias — kept so desktop-workspace.tsx can keep importing
 *  `FmBrief` after the desktop twin file was deleted. */
export const FmBrief = ForemanBriefDesktop

function yesterdayIso(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function ForemanBriefMobile({
  bootstrap,
  companySlug: _companySlug,
}: {
  bootstrap: BootstrapResponse | null
  companySlug: string
}) {
  const navigate = useNavigate()
  const nav = resolveForemanNav(useLocation().pathname)
  const params = useParams<{ projectId?: string }>()
  const projects = useMemo(
    () => bootstrap?.projects.filter((p) => /progress|active/i.test(p.status)) ?? [],
    [bootstrap?.projects],
  )
  // The project list comes from bootstrap which can land after first
  // render. Tracking the *user's* explicit pick separately from the
  // *fallback* (= first active project) means the default updates as
  // soon as data arrives — without overwriting an explicit pick later.
  const [pickedId, setPickedId] = useState<string | null>(params.projectId ?? null)
  const projectId = pickedId ?? projects[0]?.id ?? ''
  const setProjectId = (id: string) => setPickedId(id)
  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId])

  // Recipient count for the footer reach-bar ("N crew will see this on Scope").
  // The crew on a project is whoever logged labor there today; this is the
  // same proxy fm-crew uses until a live roster join is wired.
  const crewCount = useMemo(() => {
    if (!projectId) return 0
    const today = todayIso()
    const ids = new Set<string>()
    for (const l of bootstrap?.laborEntries ?? []) {
      if (l.occurred_on === today && !l.deleted_at && l.project_id === projectId && l.worker_id) {
        ids.add(l.worker_id)
      }
    }
    return ids.size
  }, [bootstrap?.laborEntries, projectId])

  const [goal, setGoal] = useState('')
  const [steps, setSteps] = useState<ProjectBriefStep[]>([])
  const [materials, setMaterials] = useState<{ description: string; quantity?: string }[]>([])
  // Tracks whether the user has manually touched the form so we don't
  // clobber their edits when the prefill query lands later.
  const [dirty, setDirty] = useState(false)
  // BRIEF · PREVIEW — "Preview" shows the crew-facing read-only render
  // first; only "Push to crew" actually sends. This flag flips the
  // composer into that preview surface. (Previously both buttons shared
  // `handleSend`, so "Preview" pushed immediately — the v2 drift this
  // fixes.)
  const [previewing, setPreviewing] = useState(false)

  // Pre-fill sources.
  const yesterdayBrief = useProjectBriefs(projectId || null, yesterdayIso())
  const scopeVsBid = useScopeVsBid(projectId || null)
  const yesterdayPrefill = useMemo(() => {
    const b = yesterdayBrief.data?.briefs?.[0]
    if (!b) return null
    const ySteps = Array.isArray(b.steps) ? (b.steps as ProjectBriefStep[]) : []
    return { goal: b.goal as string, steps: ySteps }
  }, [yesterdayBrief.data?.briefs])

  // Apply pre-fills when the project changes — yesterday's brief wins
  // over the estimate seed if both are available. The dirty guard means
  // an in-flight late response from the previous project doesn't blow
  // away current edits.
  useEffect(() => {
    if (!project || dirty) return
    if (yesterdayPrefill) {
      setGoal(yesterdayPrefill.goal)
      setSteps(yesterdayPrefill.steps)
      return
    }
    if (scopeVsBid.data?.lines?.length) {
      setGoal(`Continue ${project.division_code} per the contract scope.`)
      setSteps(
        scopeVsBid.data.lines.slice(0, 6).map((line, idx) => ({
          id: `seed-${idx}`,
          title: line.service_item_code,
          materials: line.quantity ? `${line.quantity} ${line.unit}` : null,
        })),
      )
    } else if (!goal) {
      setGoal(`Continue ${project.division_code} per yesterday's plan.`)
    }
  }, [project, dirty, yesterdayPrefill, scopeVsBid.data, goal])

  // Mutation — POST /api/projects/:id/briefs via useCreateProjectBrief.
  const createBrief = useCreateProjectBrief(projectId || '')
  const { submit, isSubmitting, error } = useSubmitForm<
    {
      projectId: string
      goal: string
      steps: ProjectBriefStep[]
      materials: { description: string; quantity?: string | null }[]
    },
    unknown
  >(async ({ goal: g, steps: s, materials: m }) => {
    if (!projectId) return null
    const res = await createBrief.mutateAsync({
      effective_date: todayIso(),
      goal: g,
      steps: s,
      materials: m.map((row) => ({ description: row.description, quantity: row.quantity ?? null })),
    })
    navigate(nav.today)
    return res
  })

  // Push — the only path that actually sends the brief to the crew.
  const handleSend = () => {
    if (!project) return
    const trimmed = goal.trim()
    if (!trimmed) return
    submit({ projectId: project.id, goal: trimmed, steps, materials })
  }
  // Preview — read-only crew-facing render, no send. Requires a project +
  // a non-empty goal (same gate as send) so the preview reflects a
  // pushable brief.
  const handlePreview = () => {
    if (!project) return
    if (!goal.trim()) return
    setPreviewing(true)
  }
  const busy = isSubmitting

  const moveStep = (idx: number, dir: -1 | 1) => {
    setDirty(true)
    setSteps((cur) => {
      const next = [...cur]
      const target = idx + dir
      if (target < 0 || target >= next.length) return cur
      const a = next[idx]
      const b = next[target]
      if (!a || !b) return cur
      next[idx] = b
      next[target] = a
      return next
    })
  }

  const updateStep = (idx: number, patch: Partial<ProjectBriefStep>) => {
    setDirty(true)
    setSteps((cur) => cur.map((s, i) => (i === idx ? { ...s, ...patch } : s)))
  }

  const addStep = () => {
    setDirty(true)
    setSteps((cur) => [...cur, { id: `local-${Date.now()}`, title: '' }])
  }

  const removeStep = (idx: number) => {
    setDirty(true)
    setSteps((cur) => cur.filter((_, i) => i !== idx))
  }

  // BRIEF · PREVIEW — read-only crew-facing render. Reached only via the
  // "Preview" button; "Back to edit" returns to the composer, "Push to
  // crew" runs the same `handleSend` so there is exactly one send path.
  if (previewing) {
    return (
      <BriefPreview
        projectName={project?.name ?? null}
        goal={goal.trim()}
        steps={steps}
        materials={materials}
        busy={busy}
        error={error}
        onBack={() => setPreviewing(false)}
        onPush={handleSend}
      />
    )
  }

  return (
    <>
      <MTopBar back title="Brief crew" sub={project?.name} onBack={() => navigate(nav.today)} />
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
                  onChange={(e) => {
                    setDirty(false)
                    setProjectId(e.currentTarget.value)
                  }}
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

            {/* GOAL — the headline the crew sees first. Brutalist field:
                hard ink border on sand, mono micro-label + char counter. */}
            <div style={{ marginBottom: 4 }}>
              <div className={MONO_LABEL} style={monoLabelStyle}>
                TODAY'S GOAL
              </div>
              <MTextarea
                value={goal}
                onChange={(e) => {
                  setDirty(true)
                  setGoal(e.currentTarget.value)
                }}
                style={{
                  width: '100%',
                  minHeight: 96,
                  marginTop: 8,
                  background: 'var(--m-card-soft)',
                  border: '2px solid var(--m-ink)',
                  fontSize: 16,
                  lineHeight: 1.45,
                }}
                placeholder="What's the crew building today, in plain words?"
                maxLength={280}
              />
              <div className={MONO_LABEL} style={{ ...monoLabelStyle, marginTop: 6, textAlign: 'right' }}>
                {goal.length} / 280
              </div>
            </div>

            {/* STEP PLAN — numbered, reorderable rows under a section bar. */}
            <MSectionH
              link={
                <>
                  <MI.Plus size={12} /> ADD
                </>
              }
              onLinkClick={addStep}
            >
              STEP PLAN · {steps.length}
            </MSectionH>
            <MListInset>
              {steps.length === 0 ? (
                <MListRow
                  leading={<MI.Layers size={18} />}
                  headline="No steps yet"
                  supporting="Add the first step below"
                />
              ) : (
                steps.map((step, idx) => (
                  <div key={step.id ?? idx} style={{ padding: '10px 12px', borderBottom: '1px solid var(--m-line)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {/* Step ordinal — the numbered marker that mirrors the
                          worker-facing preview. */}
                      <div
                        aria-hidden
                        style={{
                          width: 28,
                          height: 28,
                          flexShrink: 0,
                          border: '2px solid var(--m-ink)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontFamily: 'var(--m-font-display)',
                          fontWeight: 800,
                          fontSize: 13,
                        }}
                      >
                        {idx + 1}
                      </div>
                      <button
                        type="button"
                        aria-label="Move step up"
                        onClick={() => moveStep(idx, -1)}
                        disabled={idx === 0}
                        style={reorderBtnStyle(idx === 0)}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        aria-label="Move step down"
                        onClick={() => moveStep(idx, 1)}
                        disabled={idx === steps.length - 1}
                        style={reorderBtnStyle(idx === steps.length - 1)}
                      >
                        ▼
                      </button>
                      <MInput
                        value={step.title}
                        onChange={(e) => updateStep(idx, { title: e.currentTarget.value })}
                        placeholder={`Step ${idx + 1}`}
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        aria-label="Remove step"
                        onClick={() => removeStep(idx)}
                        style={{
                          // Match the reorder targets so the row reads as
                          // three equal 44×44 controls.
                          width: 44,
                          height: 44,
                          flexShrink: 0,
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--m-red)',
                          padding: 0,
                          cursor: 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <MI.X size={16} />
                      </button>
                    </div>
                    {/* Per-step time window + crew — the design shows each step
                        with a start→end range and a "WHO · …" assignment. */}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, marginLeft: 96 }}>
                      <MInput
                        type="time"
                        aria-label={`Step ${idx + 1} start time`}
                        value={step.start_time ?? ''}
                        onChange={(e) => updateStep(idx, { start_time: e.currentTarget.value || null })}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <span aria-hidden style={{ color: 'var(--m-ink-3)', fontWeight: 700 }}>
                        →
                      </span>
                      <MInput
                        type="time"
                        aria-label={`Step ${idx + 1} end time`}
                        value={step.end_time ?? ''}
                        onChange={(e) => updateStep(idx, { end_time: e.currentTarget.value || null })}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, marginLeft: 96 }}>
                      <span className={MONO_LABEL} style={{ ...monoLabelStyle, flexShrink: 0 }}>
                        WHO
                      </span>
                      <MInput
                        aria-label={`Step ${idx + 1} crew`}
                        value={step.crew ?? ''}
                        onChange={(e) => updateStep(idx, { crew: e.currentTarget.value || null })}
                        placeholder="All"
                        style={{ flex: 1, minWidth: 0 }}
                      />
                    </div>
                    {step.materials ? (
                      <div className={MONO_LABEL} style={{ ...monoLabelStyle, marginTop: 4, marginLeft: 96 }}>
                        MATERIALS · {step.materials}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </MListInset>
            <div style={{ padding: '8px 0 16px' }}>
              <MButton size="sm" variant="ghost" onClick={addStep}>
                <MI.Plus size={14} /> Add step
              </MButton>
            </div>

            <MSectionH>MATERIALS &amp; DELIVERIES</MSectionH>
            <MaterialsList
              materials={materials}
              onChange={(m) => {
                setDirty(true)
                setMaterials(m)
              }}
            />
            {yesterdayPrefill ? (
              <div style={{ marginTop: 16 }}>
                <MAiAgent
                  attribution={
                    <>
                      Drafted from <strong>yesterday's brief</strong>.
                    </>
                  }
                >
                  Pre-filled goal + {yesterdayPrefill.steps.length} step
                  {yesterdayPrefill.steps.length === 1 ? '' : 's'} from yesterday. Edit before sending.
                </MAiAgent>
              </div>
            ) : null}
            {error ? <div style={{ marginTop: 12, color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}

            {/* Footer reach-bar: who-will-see + PREVIEW / PUSH primaries. */}
            <div
              className={MONO_LABEL}
              style={{
                ...monoLabelStyle,
                marginTop: 16,
                padding: '12px 14px',
                background: 'var(--m-ink)',
                color: 'var(--m-card)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span style={{ width: 8, height: 8, background: 'var(--m-accent)', flexShrink: 0 }} />
              {project
                ? crewCount > 0
                  ? `${crewCount} CREW WILL SEE THIS ON SCOPE TAB`
                  : 'CREW WILL SEE THIS ON SCOPE TAB'
                : 'PICK A PROJECT TO BRIEF'}
            </div>
            <div className="m-btn-row" style={{ marginTop: 12 }}>
              <MButton
                variant="ghost"
                onClick={handlePreview}
                disabled={busy || !project || !goal.trim()}
                style={{ flex: 1 }}
              >
                Preview
              </MButton>
              <MButton variant="primary" onClick={handleSend} disabled={busy || !project} style={{ flex: 2 }}>
                {busy ? 'Pushing…' : 'Push to crew'}
              </MButton>
            </div>
          </>
        )}
      </MBody>
    </>
  )
}

/**
 * BRIEF · PREVIEW (`V2ForemanBriefPreview`). A read-only render of the
 * brief as the crew will see it on `wk-scope` — the goal slab, numbered
 * step list, and materials — so the foreman can sanity-check before it
 * goes out. This surface NEVER sends on its own; the only send is the
 * explicit "Push to crew" button, which calls the same `handleSend` the
 * composer uses (one send path, no drift).
 */
function BriefPreview({
  projectName,
  goal,
  steps,
  materials,
  busy,
  error,
  onBack,
  onPush,
}: {
  projectName: string | null
  goal: string
  steps: ProjectBriefStep[]
  materials: { description: string; quantity?: string }[]
  busy: boolean
  error: string | null
  onBack: () => void
  onPush: () => void
}) {
  return (
    <>
      <MTopBar back title="Preview brief" sub={projectName ?? undefined} onBack={onBack} />
      <MBody>
        {/* PREVIEW eyebrow strip — makes the read-only / not-yet-sent
            state unmistakable. */}
        <div
          style={{
            ...monoLabelStyle,
            margin: '16px 20px 0',
            padding: '10px 12px',
            background: 'var(--m-sand-2)',
            border: '1px solid var(--m-line)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <MI.FileText size={14} />
          PREVIEW · NOT SENT YET
        </div>

        {/* Goal slab — mirrors wk-scope's crew-facing goal treatment. */}
        <div style={{ padding: 20, borderBottom: '2px solid var(--m-sand-2)' }}>
          <div className="m-topbar-eyebrow" data-tone="accent" style={{ display: 'inline-block' }}>
            TODAY'S GOAL
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
            {goal || 'No goal set yet.'}
          </div>
        </div>

        {/* Numbered step list — same ordinal markers the worker sees. */}
        <MSectionH>{`STEP PLAN · ${steps.length}`}</MSectionH>
        {steps.length === 0 ? (
          <div className="m-quiet-sm" style={{ padding: '12px 20px' }}>
            No steps yet. Go back and add the morning plan.
          </div>
        ) : (
          <div>
            {steps.map((step, idx) => (
              <div
                key={step.id ?? idx}
                style={{
                  borderBottom: '1px solid var(--m-line-2)',
                  padding: '16px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
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
                    border: '2px solid var(--m-sand-2)',
                    color: 'var(--m-ink-4)',
                    fontFamily: 'var(--m-font-display)',
                    fontWeight: 800,
                    fontSize: 16,
                  }}
                >
                  <span className="num">{idx + 1}</span>
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: 'block',
                      fontFamily: 'var(--m-font-display)',
                      fontSize: 15,
                      fontWeight: 600,
                      letterSpacing: '-0.005em',
                      color: 'var(--m-ink)',
                    }}
                  >
                    {step.title || `Step ${idx + 1}`}
                  </span>
                  {stepTimeRange(step) || step.crew ? (
                    <span
                      className="num"
                      style={{ display: 'block', marginTop: 3, fontSize: 11, fontWeight: 600, color: 'var(--m-ink-4)' }}
                    >
                      {[stepTimeRange(step), step.crew ? `WHO · ${step.crew.toUpperCase()}` : null]
                        .filter(Boolean)
                        .join('  ·  ')}
                    </span>
                  ) : null}
                  {step.materials ? (
                    <span
                      className="num"
                      style={{ display: 'block', marginTop: 3, fontSize: 11, fontWeight: 600, color: 'var(--m-ink-4)' }}
                    >
                      {step.materials}
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Materials & deliveries — read-only echo of the composer list. */}
        {materials.length > 0 ? (
          <>
            <MSectionH>MATERIALS &amp; DELIVERIES</MSectionH>
            <MListInset>
              {materials.map((m, idx) => (
                <MListRow
                  key={idx}
                  leading={<MI.Truck size={18} />}
                  headline={m.description || 'Material'}
                  supporting={m.quantity || undefined}
                />
              ))}
            </MListInset>
            {/* Site-readiness status strip — tells the crew the materials are
                staged. Location isn't a typed field yet, so we surface the
                staged status generically (design msg__36). */}
            <div
              style={{
                margin: '16px 20px 0',
                padding: '10px 12px',
                background: 'var(--m-green, #1f9d55)',
                color: '#fffaf2',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >
              <span aria-hidden style={{ width: 8, height: 8, background: '#fffaf2', flexShrink: 0 }} />
              Materials staged
            </div>
          </>
        ) : null}

        {error ? <div style={{ margin: '12px 20px 0', color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}

        <div style={{ padding: 20 }}>
          <div className="m-btn-row">
            <MButton variant="ghost" onClick={onBack} disabled={busy} style={{ flex: 1 }}>
              Back to edit
            </MButton>
            <MButton variant="primary" onClick={onPush} disabled={busy} style={{ flex: 2 }}>
              {busy ? 'Pushing…' : 'Push to crew'}
            </MButton>
          </div>
        </div>
      </MBody>
    </>
  )
}

function MaterialsList({
  materials,
  onChange,
}: {
  materials: { description: string; quantity?: string }[]
  onChange: (m: { description: string; quantity?: string }[]) => void
}) {
  const update = (idx: number, patch: Partial<{ description: string; quantity?: string }>) => {
    onChange(materials.map((m, i) => (i === idx ? { ...m, ...patch } : m)))
  }
  const remove = (idx: number) => onChange(materials.filter((_, i) => i !== idx))
  const add = () => onChange([...materials, { description: '' }])
  return (
    <>
      <MListInset>
        {materials.length === 0 ? (
          <MListRow
            leading={<MI.Truck size={18} />}
            headline="No deliveries listed"
            supporting="Add what's expected today"
          />
        ) : (
          materials.map((m, idx) => (
            <div
              key={idx}
              style={{
                padding: '8px 12px',
                borderBottom: '1px solid var(--m-line)',
                display: 'flex',
                gap: 6,
                alignItems: 'center',
              }}
            >
              <MInput
                placeholder="What"
                value={m.description}
                onChange={(e) => update(idx, { description: e.currentTarget.value })}
                style={{ flex: 2 }}
              />
              <MInput
                placeholder="How much"
                value={m.quantity ?? ''}
                onChange={(e) => update(idx, { quantity: e.currentTarget.value })}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                aria-label="Remove material"
                onClick={() => remove(idx)}
                style={{
                  width: 44,
                  height: 44,
                  flexShrink: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--m-red)',
                  cursor: 'pointer',
                  padding: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <MI.X size={16} />
              </button>
            </div>
          ))
        )}
      </MListInset>
      <div style={{ padding: '8px 0 16px' }}>
        <MButton size="sm" variant="ghost" onClick={add}>
          <MI.Plus size={14} /> Add material
        </MButton>
      </div>
    </>
  )
}

// Mono micro-label — JetBrains Mono, uppercase, tracked. Mirrors the v2
// `.v2-mono` / eyebrow treatment using the design-system `--m-num` font
// token so the look stays in sync with styles/m.css.
/** "7:00 → 9:30" from a step's start/end times, or '' when not both set. */
function stepTimeRange(step: ProjectBriefStep): string {
  const start = step.start_time?.trim()
  const end = step.end_time?.trim()
  if (start && end) return `${start} → ${end}`
  if (start) return start
  if (end) return `→ ${end}`
  return ''
}

const MONO_LABEL = 'm-quiet-sm'
const monoLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--m-ink-3)',
}

function reorderBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    // 44×44 minimum tap target (WCAG 2.1) — primary reorder control on a
    // gloved-hand interface. Visible chrome stays compact via inner padding.
    width: 44,
    height: 44,
    flexShrink: 0,
    border: '2px solid var(--m-ink)',
    background: 'var(--m-card)',
    color: disabled ? 'var(--m-ink-4)' : 'var(--m-ink)',
    fontSize: 14,
    lineHeight: 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
    padding: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  }
}

// ---------------------------------------------------------------------------
// Desktop composition — the former screens/desktop/fm-brief.tsx, folded in
// verbatim (data + behavior preserved) with navigation resolved through
// resolveForemanNav. Local helpers are suffixed `_DESKTOP` where they would
// otherwise collide with the mobile composer's same-named locals.
// ---------------------------------------------------------------------------

// Presentational crew roster for the Send-reminders panel. The brief composer
// does not load the crew roster, so these rows are a clearly-labeled sample —
// the real send wiring lands when a crew/notification hook is threaded in.
interface ReminderRecipient {
  id: string
  name: string
  role: string
}
const DEMO_CREW: ReminderRecipient[] = [
  { id: 'crew-1', name: 'Carlos M.', role: 'Lead' },
  { id: 'crew-2', name: 'Devon R.', role: 'Plaster' },
  { id: 'crew-3', name: 'Sam P.', role: 'Apprentice' },
]

const MONO_LABEL_DESKTOP: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--m-ink-3)',
}

function ForemanBriefDesktop() {
  const navigate = useNavigate()
  const nav = resolveForemanNav(useLocation().pathname)
  const params = useParams<{ projectId?: string }>()
  const projectId = params.projectId ?? ''

  const [goal, setGoal] = useState('')
  const [steps, setSteps] = useState<ProjectBriefStep[]>([])

  // Edit mode (DBriefEdit): the author form is read-only until the foreman
  // taps EDIT, then SAVE + PUSH / CANCEL frame the edit session.
  const [editing, setEditing] = useState(true)
  const [draftBackup, setDraftBackup] = useState<{ goal: string; steps: ProjectBriefStep[] } | null>(null)

  // Send-reminders modal (DSendReminders): crew rows with per-recipient send
  // toggles. Defaults all recipients on.
  const [remindersOpen, setRemindersOpen] = useState(false)
  const [selectedCrew, setSelectedCrew] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(DEMO_CREW.map((c) => [c.id, true])),
  )

  const createBrief = useCreateProjectBrief(projectId)
  const { submit, isSubmitting, error } = useSubmitForm<{ goal: string; steps: ProjectBriefStep[] }, unknown>(
    async ({ goal: g, steps: s }) => {
      if (!projectId) return null
      const res = await createBrief.mutateAsync({
        effective_date: todayIso(),
        goal: g,
        steps: s.filter((step) => step.title.trim().length > 0),
      })
      navigate(nav.today)
      return res
    },
  )

  const handlePush = () => {
    const trimmed = goal.trim()
    if (!projectId || !trimmed) return
    submit({ goal: trimmed, steps })
  }

  const addStep = () => setSteps((cur) => [...cur, { id: `local-${Date.now()}`, title: '' }])
  const removeStep = (idx: number) => setSteps((cur) => cur.filter((_, i) => i !== idx))
  const updateStep = (idx: number, title: string) =>
    setSteps((cur) => cur.map((s, i) => (i === idx ? { ...s, title } : s)))

  // Enter edit mode, stashing a backup so CANCEL can roll the draft back.
  const startEditing = () => {
    setDraftBackup({ goal, steps })
    setEditing(true)
  }
  const cancelEditing = () => {
    if (draftBackup) {
      setGoal(draftBackup.goal)
      setSteps(draftBackup.steps)
    }
    setDraftBackup(null)
    setEditing(false)
  }
  // SAVE + PUSH commits the edit and pushes to the crew in one action.
  const saveAndPush = () => {
    setDraftBackup(null)
    setEditing(false)
    handlePush()
  }

  const toggleCrew = (id: string) => setSelectedCrew((cur) => ({ ...cur, [id]: !cur[id] }))
  const selectedCount = DEMO_CREW.filter((c) => selectedCrew[c.id]).length

  const previewSteps = steps.filter((s) => s.title.trim().length > 0)
  const canPush = Boolean(projectId) && goal.trim().length > 0 && !isSubmitting

  return (
    <div className="d-content">
      <div className="d-stack">
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <DEyebrow>Foreman · Brief{editing ? ' · editing' : ''}</DEyebrow>
            <DH1>Brief the crew</DH1>
          </div>
          {projectId ? (
            <div style={{ display: 'flex', gap: 8 }}>
              {editing ? (
                <MButton size="sm" variant="quiet" onClick={cancelEditing}>
                  Cancel
                </MButton>
              ) : (
                <MButton size="sm" variant="quiet" onClick={startEditing}>
                  Edit brief
                </MButton>
              )}
              <MButton size="sm" variant="ghost" onClick={() => setRemindersOpen(true)}>
                Send reminders
              </MButton>
            </div>
          ) : null}
        </div>

        {!projectId ? (
          <div className="d-card" style={{ color: 'var(--m-ink-3)', fontSize: 14 }}>
            No project selected. Open a project to brief its crew.
          </div>
        ) : (
          <div className="d-split">
            {/* LEFT — author */}
            <div className="d-stack" style={{ gap: 20 }}>
              <div>
                <div style={MONO_LABEL_DESKTOP}>TODAY&apos;S GOAL</div>
                <MTextarea
                  value={goal}
                  onChange={(e) => setGoal(e.currentTarget.value)}
                  readOnly={!editing}
                  placeholder="What's the crew building today, in plain words?"
                  maxLength={280}
                  style={{
                    width: '100%',
                    minHeight: 110,
                    marginTop: 8,
                    background: 'var(--m-card-soft)',
                    border: editing ? '2px solid var(--m-accent)' : '2px solid var(--m-ink)',
                    fontSize: 16,
                    lineHeight: 1.45,
                  }}
                />
                <div style={{ ...MONO_LABEL_DESKTOP, marginTop: 6, textAlign: 'right' }}>
                  {goal.length} / 280{editing ? ' CHARS · INLINE EDIT · ESC TO CANCEL' : ''}
                </div>
              </div>

              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 8,
                  }}
                >
                  <div style={MONO_LABEL_DESKTOP}>STEP PLAN · {steps.length}</div>
                  {editing ? (
                    <MButton size="sm" variant="ghost" onClick={addStep}>
                      + Add step
                    </MButton>
                  ) : null}
                </div>

                <div className="d-card" style={{ padding: 0 }}>
                  {steps.length === 0 ? (
                    <div style={{ padding: '16px 18px', color: 'var(--m-ink-3)', fontSize: 13 }}>
                      No steps yet. Add the first step to build the plan.
                    </div>
                  ) : (
                    steps.map((step, idx) => (
                      <div
                        key={step.id ?? idx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '10px 14px',
                          borderBottom: idx === steps.length - 1 ? 'none' : '1px solid var(--m-line)',
                        }}
                      >
                        <div
                          aria-hidden
                          style={{
                            width: 28,
                            height: 28,
                            flexShrink: 0,
                            border: '2px solid var(--m-ink)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontFamily: 'var(--m-font-display)',
                            fontWeight: 800,
                            fontSize: 13,
                          }}
                        >
                          {idx + 1}
                        </div>
                        <MInput
                          value={step.title}
                          onChange={(e) => updateStep(idx, e.currentTarget.value)}
                          readOnly={!editing}
                          placeholder={`Step ${idx + 1}`}
                          style={{ flex: 1 }}
                        />
                        {editing ? (
                          <button
                            type="button"
                            aria-label="Remove step"
                            onClick={() => removeStep(idx)}
                            style={{
                              width: 36,
                              height: 36,
                              flexShrink: 0,
                              border: 'none',
                              background: 'transparent',
                              color: 'var(--m-red)',
                              cursor: 'pointer',
                              fontSize: 18,
                              lineHeight: 1,
                              padding: 0,
                            }}
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {error ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}

              <div style={{ display: 'flex', gap: 8 }}>
                {editing ? (
                  <>
                    <MButton variant="primary" onClick={saveAndPush} disabled={!canPush}>
                      {isSubmitting ? 'Pushing…' : 'Save + push'}
                    </MButton>
                    <MButton variant="quiet" onClick={cancelEditing} disabled={isSubmitting}>
                      Cancel
                    </MButton>
                  </>
                ) : (
                  <MButton variant="primary" onClick={handlePush} disabled={!canPush}>
                    {isSubmitting ? 'Pushing…' : 'Push to crew'}
                  </MButton>
                )}
              </div>
            </div>

            {/* RIGHT — live preview (sticky) */}
            <div className="d-card" style={{ position: 'sticky', top: 24 }}>
              <div style={MONO_LABEL_DESKTOP}>Live preview</div>

              {/* Goal slab — the headline the crew sees first. */}
              <div
                style={{
                  marginTop: 12,
                  padding: '14px 16px',
                  background: 'var(--m-ink)',
                  color: 'var(--m-card)',
                }}
              >
                <div style={{ ...MONO_LABEL_DESKTOP, color: 'var(--m-accent)' }}>TODAY&apos;S GOAL</div>
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: 'var(--m-font-display)',
                    fontWeight: 800,
                    fontSize: 20,
                    lineHeight: 1.25,
                    letterSpacing: '-0.02em',
                  }}
                >
                  {goal.trim() || 'Your goal shows up here.'}
                </div>
              </div>

              {/* Numbered steps as the crew will read them. */}
              <div style={{ ...MONO_LABEL_DESKTOP, marginTop: 16 }}>STEP PLAN</div>
              <ol style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
                {previewSteps.length === 0 ? (
                  <li style={{ color: 'var(--m-ink-3)', fontSize: 13, padding: '6px 0' }}>
                    Steps appear here as you add them.
                  </li>
                ) : (
                  previewSteps.map((step, idx) => (
                    <li
                      key={step.id ?? idx}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 10,
                        padding: '8px 0',
                        borderBottom: idx === previewSteps.length - 1 ? 'none' : '1px solid var(--m-line)',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--m-num)',
                          fontWeight: 700,
                          fontSize: 13,
                          color: 'var(--m-ink-3)',
                          flexShrink: 0,
                        }}
                      >
                        {String(idx + 1).padStart(2, '0')}
                      </span>
                      <span style={{ fontSize: 15, lineHeight: 1.35 }}>{step.title.trim()}</span>
                    </li>
                  ))
                )}
              </ol>
            </div>
          </div>
        )}
      </div>

      {/* DSendReminders — bulk crew reminder modal with per-recipient toggles. */}
      <DModal
        open={remindersOpen}
        onClose={() => setRemindersOpen(false)}
        title={`Send reminders · ${selectedCount} selected`}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <MButton size="sm" variant="quiet" onClick={() => setRemindersOpen(false)}>
              Cancel
            </MButton>
            <MButton
              size="sm"
              variant="primary"
              disabled={selectedCount === 0}
              onClick={() => {
                // TODO: wire to a crew/notification send hook. Closes for now.
                setRemindersOpen(false)
              }}
            >
              {`Send ${selectedCount} ${selectedCount === 1 ? 'reminder' : 'reminders'}`}
            </MButton>
          </div>
        }
      >
        <div style={{ ...MONO_LABEL_DESKTOP, marginBottom: 10 }}>SAMPLE CREW · TOGGLE WHO GETS THE BRIEF</div>
        <div className="d-stack" style={{ gap: 8 }}>
          {DEMO_CREW.map((c) => {
            const on = Boolean(selectedCrew[c.id])
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggleCrew(c.id)}
                aria-pressed={on}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 14px',
                  border: '2px solid var(--m-ink)',
                  background: on ? 'transparent' : 'var(--m-card-soft)',
                  opacity: on ? 1 : 0.6,
                  cursor: 'pointer',
                  textAlign: 'left',
                  width: '100%',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 18,
                    height: 18,
                    flexShrink: 0,
                    border: '2px solid var(--m-ink)',
                    background: on ? 'var(--m-accent)' : 'transparent',
                  }}
                />
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontWeight: 700, fontSize: 14, color: 'var(--m-ink)' }}>
                    {c.name}
                  </span>
                  <span style={{ ...MONO_LABEL_DESKTOP, marginTop: 3 }}>{c.role}</span>
                </span>
              </button>
            )
          })}
        </div>
      </DModal>
    </div>
  )
}
