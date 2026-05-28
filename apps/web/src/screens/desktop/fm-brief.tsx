/**
 * Foreman desktop — FM · BRIEF CREW · AUTHOR + LIVE PREVIEW (Desktop v2).
 *
 * Reuses the SAME hook surface as the mobile brief composer
 * (screens/mobile/foreman-brief.tsx): goal + numbered steps over local
 * state, submitted through `useSubmitForm` + `useCreateProjectBrief`
 * (POST /api/projects/:id/briefs). This is a dense desktop composition:
 * a `.d-split` with the author on the left and a sticky live preview of
 * the brief — exactly as the crew will see it — on the right.
 */
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useSubmitForm } from '@/machines/submit-form'
import { useCreateProjectBrief, type ProjectBriefStep } from '@/lib/api/project-briefs'
import { DEyebrow, DH1 } from '@/components/d'
import { MButton, MInput, MTextarea } from '@/components/m'
import { todayIso } from '../mobile/format.js'

const MONO_LABEL: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--m-ink-3)',
}

export function FmBrief() {
  const navigate = useNavigate()
  const params = useParams<{ projectId?: string }>()
  const projectId = params.projectId ?? ''

  const [goal, setGoal] = useState('')
  const [steps, setSteps] = useState<ProjectBriefStep[]>([])

  const createBrief = useCreateProjectBrief(projectId)
  const { submit, isSubmitting, error } = useSubmitForm<{ goal: string; steps: ProjectBriefStep[] }, unknown>(
    async ({ goal: g, steps: s }) => {
      if (!projectId) return null
      const res = await createBrief.mutateAsync({
        effective_date: todayIso(),
        goal: g,
        steps: s.filter((step) => step.title.trim().length > 0),
      })
      navigate('/desktop/fm/today')
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

  const previewSteps = steps.filter((s) => s.title.trim().length > 0)
  const canPush = Boolean(projectId) && goal.trim().length > 0 && !isSubmitting

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Foreman · Brief</DEyebrow>
          <DH1>Brief the crew</DH1>
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
                <div style={MONO_LABEL}>TODAY&apos;S GOAL</div>
                <MTextarea
                  value={goal}
                  onChange={(e) => setGoal(e.currentTarget.value)}
                  placeholder="What's the crew building today, in plain words?"
                  maxLength={280}
                  style={{
                    width: '100%',
                    minHeight: 110,
                    marginTop: 8,
                    background: 'var(--m-card-soft)',
                    border: '2px solid var(--m-ink)',
                    fontSize: 16,
                    lineHeight: 1.45,
                  }}
                />
                <div style={{ ...MONO_LABEL, marginTop: 6, textAlign: 'right' }}>{goal.length} / 280</div>
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
                  <div style={MONO_LABEL}>STEP PLAN · {steps.length}</div>
                  <MButton size="sm" variant="ghost" onClick={addStep}>
                    + Add step
                  </MButton>
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
                          placeholder={`Step ${idx + 1}`}
                          style={{ flex: 1 }}
                        />
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
                      </div>
                    ))
                  )}
                </div>
              </div>

              {error ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}

              <div>
                <MButton variant="primary" onClick={handlePush} disabled={!canPush}>
                  {isSubmitting ? 'Pushing…' : 'Push to crew'}
                </MButton>
              </div>
            </div>

            {/* RIGHT — live preview (sticky) */}
            <div className="d-card" style={{ position: 'sticky', top: 24 }}>
              <div style={MONO_LABEL}>Live preview</div>

              {/* Goal slab — the headline the crew sees first. */}
              <div
                style={{
                  marginTop: 12,
                  padding: '14px 16px',
                  background: 'var(--m-ink)',
                  color: 'var(--m-card)',
                }}
              >
                <div style={{ ...MONO_LABEL, color: 'var(--m-accent)' }}>TODAY&apos;S GOAL</div>
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
              <div style={{ ...MONO_LABEL, marginTop: 16 }}>STEP PLAN</div>
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
    </div>
  )
}
