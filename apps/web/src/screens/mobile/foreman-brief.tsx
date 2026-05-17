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
import { useNavigate, useParams } from 'react-router-dom'
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
import { MAiAgent } from '../../components/m/ai.js'
import { useCreateProjectBrief, type ProjectBriefStep } from '../../lib/api/project-briefs.js'
import { useProjectBriefs } from '../../lib/api/projects.js'
import { useScopeVsBid } from '../../lib/api/estimate.js'
import { todayIso } from './format.js'

function yesterdayIso(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function ForemanBrief({
  bootstrap,
  companySlug: _companySlug,
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
  // The project list comes from bootstrap which can land after first
  // render. Tracking the *user's* explicit pick separately from the
  // *fallback* (= first active project) means the default updates as
  // soon as data arrives — without overwriting an explicit pick later.
  const [pickedId, setPickedId] = useState<string | null>(params.projectId ?? null)
  const projectId = pickedId ?? projects[0]?.id ?? ''
  const setProjectId = (id: string) => setPickedId(id)
  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId])

  const [goal, setGoal] = useState('')
  const [steps, setSteps] = useState<ProjectBriefStep[]>([])
  const [materials, setMaterials] = useState<{ description: string; quantity?: string }[]>([])
  // Tracks whether the user has manually touched the form so we don't
  // clobber their edits when the prefill query lands later.
  const [dirty, setDirty] = useState(false)

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
    navigate('/today')
    return res
  })

  const handleSend = () => {
    if (!project) return
    const trimmed = goal.trim()
    if (!trimmed) return
    submit({ projectId: project.id, goal: trimmed, steps, materials })
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

  return (
    <>
      <MTopBar back title="Brief crew" sub={project?.name} onBack={() => navigate('/today')} />
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
            <MSectionH>Today's scope</MSectionH>
            <MListInset>
              {steps.length === 0 ? (
                <MListRow
                  leading={<MI.Layers size={18} />}
                  headline="No steps yet"
                  supporting="Add the first step below"
                />
              ) : (
                steps.map((step, idx) => (
                  <div key={step.id ?? idx} style={{ padding: '8px 12px', borderBottom: '1px solid var(--m-line)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--m-red)',
                          padding: 4,
                          cursor: 'pointer',
                        }}
                      >
                        <MI.X size={16} />
                      </button>
                    </div>
                    {step.materials ? (
                      <div className="m-quiet-sm" style={{ marginTop: 4, marginLeft: 60 }}>
                        Materials: {step.materials}
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
            <MSectionH>Today's goal</MSectionH>
            <MTextarea
              value={goal}
              onChange={(e) => {
                setDirty(true)
                setGoal(e.currentTarget.value)
              }}
              style={{ width: '100%', minHeight: 110 }}
              placeholder="What's the crew building today, in plain words?"
              maxLength={280}
            />
            <div className="m-quiet-sm" style={{ marginTop: 4, textAlign: 'right' }}>
              {goal.length} / 280
            </div>
            <MSectionH>Materials & deliveries</MSectionH>
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
                style={{ border: 'none', background: 'transparent', color: 'var(--m-red)', cursor: 'pointer' }}
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

function reorderBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 26,
    height: 22,
    border: '1px solid var(--m-line)',
    borderRadius: 6,
    background: 'var(--m-card)',
    color: disabled ? 'var(--m-ink-4)' : 'var(--m-ink)',
    fontSize: 10,
    cursor: disabled ? 'not-allowed' : 'pointer',
    padding: 0,
  }
}
