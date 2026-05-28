/**
 * PROJECT · AT RISK → RECOVERY PLAN (v2 brutalist).
 *
 * Routed at `/projects/:projectId/recovery-plan`. When a project trips one
 * or more guardrails (margin / schedule / safety), this screen is the
 * owner's "what do we do about it" surface:
 *
 *   - AT RISK hero — big-number margin variance in red (MKpi, display font).
 *   - One card per *triggered* guardrail (label + detail + threshold vs
 *     current) with Snooze (~24h) / Mute / Clear actions wired straight to
 *     useGuardrailAction().
 *   - RECOMMENDED ACTIONS — static, per-guardrail-type recovery copy
 *     surfaced through the AI surface atoms (MAiStripe / MAiAgent).
 *
 * Pure renderer over useProjectGuardrails + useProjectCloseoutSummary.
 * No business state lives here beyond the per-guardrail pending action.
 */
import { useNavigate, useParams } from 'react-router-dom'
import type { Guardrail, GuardrailType } from '../../lib/api/guardrails.js'
import { useGuardrailAction, useProjectGuardrails } from '../../lib/api/guardrails.js'
import { useProjectCloseoutSummary } from '../../lib/api/closeout-summary.js'
import {
  MAiAgent,
  MAiStripe,
  MBanner,
  MBody,
  MButton,
  MButtonRow,
  MKpi,
  MSectionH,
  MTopBar,
} from '../../components/m/index.js'
import { formatMoney } from './format.js'

/** Static recovery copy keyed by guardrail type. Steve-approved phrasing. */
const RECOVERY_STEPS: Record<GuardrailType, { eyebrow: string; title: string; body: string }> = {
  margin: {
    eyebrow: 'MARGIN RECOVERY',
    title: 'Trim crew on the next dispatch',
    body: 'Margin is below the floor. Pull a body off the next dispatch and re-price any open change orders before they post.',
  },
  schedule: {
    eyebrow: 'SCHEDULE RECOVERY',
    title: 'Add a Saturday shift',
    body: "You're past the schedule threshold. Add a Saturday shift or pull a crew forward to claw back the slip before the next milestone.",
  },
  safety: {
    eyebrow: 'SAFETY RECOVERY',
    title: 'Stop work and re-brief the crew',
    body: 'A safety guardrail tripped. Pause the affected scope, run a toolbox talk, and document the corrective action before resuming.',
  },
}

const TYPE_LABEL: Record<GuardrailType, string> = {
  margin: 'MARGIN',
  schedule: 'SCHEDULE',
  safety: 'SAFETY',
}

export function MobileRecoveryPlan() {
  const navigate = useNavigate()
  const { projectId = '' } = useParams<{ projectId: string }>()

  const guardrailsQuery = useProjectGuardrails(projectId)
  const closeoutQuery = useProjectCloseoutSummary(projectId)
  const { snooze, mute, clear } = useGuardrailAction()

  const guardrails = guardrailsQuery.data?.guardrails ?? []
  // Only guardrails that have actually fired need a recovery card. Armed /
  // already-snoozed / already-muted rows aren't actionable here.
  const triggered = guardrails.filter((g) => g.status === 'triggered')

  // Hero number: prefer the closeout margin variance (estimate vs actual).
  // Fall back to the most negative margin guardrail variance if the
  // closeout summary hasn't loaded.
  const closeout = closeoutQuery.data ?? null
  const marginGuardrail = triggered.find((g) => g.type === 'margin') ?? null
  const heroVariance = closeout
    ? closeout.margin
    : marginGuardrail
      ? marginGuardrail.current_value - marginGuardrail.threshold
      : null
  const heroPct = closeout ? closeout.margin_pct : null

  // Distinct triggered types drive the recommended-actions list so we don't
  // repeat the same "trim crew" copy for two margin guardrails.
  const recommendedTypes = Array.from(new Set(triggered.map((g) => g.type)))

  const busy = snooze.isPending || mute.isPending || clear.isPending

  const handleSnooze = (g: Guardrail) => {
    const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    snooze.mutate({ id: g.id, snoozedUntil })
  }
  const handleMute = (g: Guardrail) => {
    mute.mutate({ id: g.id, mutedReason: 'Acknowledged from recovery plan' })
  }
  const handleClear = (g: Guardrail) => {
    clear.mutate(g.id)
  }

  return (
    <>
      <MTopBar back title="Recovery plan" sub={closeout?.project.name} onBack={() => navigate(-1)} />
      <MBody pad>
        {/* AT RISK hero — big-number variance in red. */}
        <div className="m-card" data-tone="accent" style={{ marginTop: 8, borderColor: 'var(--m-red)' }}>
          <div
            className="m-topbar-eyebrow"
            style={{ fontWeight: 800, color: 'var(--m-red)', letterSpacing: '0.08em' }}
          >
            ● AT RISK
          </div>
          <div style={{ marginTop: 12 }}>
            <MKpi
              label="Margin variance"
              value={
                <span
                  style={{
                    fontFamily: 'var(--m-font-display)',
                    fontWeight: 800,
                    fontSize: 44,
                    lineHeight: 1,
                    color: 'var(--m-red)',
                    letterSpacing: '-0.02em',
                  }}
                >
                  {heroVariance === null ? '—' : formatMoney(heroVariance)}
                </span>
              }
              meta={
                heroPct === null
                  ? `${triggered.length} guardrail${triggered.length === 1 ? '' : 's'} triggered`
                  : `${heroPct.toFixed(1)}% margin · ${triggered.length} guardrail${triggered.length === 1 ? '' : 's'} triggered`
              }
              metaTone="red"
            />
          </div>
        </div>

        {guardrailsQuery.isLoading ? (
          <div className="m-topbar-eyebrow" style={{ margin: '24px 0', textAlign: 'center', color: 'var(--m-ink-3)' }}>
            LOADING GUARDRAILS…
          </div>
        ) : guardrailsQuery.isError ? (
          <MBanner
            tone="error"
            title="Couldn't load guardrails"
            body="The at-risk monitors for this project failed to load. Pull back and try again."
          />
        ) : triggered.length === 0 ? (
          <MBanner
            tone="ok"
            title="No triggered guardrails"
            body="Nothing is tripping the margin, schedule, or safety floors right now. This project is on track."
          />
        ) : (
          <>
            <MSectionH>Triggered guardrails</MSectionH>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {triggered.map((g) => (
                <div key={g.id} className="m-card">
                  <div
                    className="m-topbar-eyebrow"
                    style={{ fontWeight: 800, color: 'var(--m-red)', letterSpacing: '0.08em' }}
                  >
                    ● {TYPE_LABEL[g.type]} · TRIGGERED
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--m-font-display)',
                      fontWeight: 700,
                      fontSize: 18,
                      lineHeight: 1.15,
                      marginTop: 10,
                      color: 'var(--m-ink)',
                    }}
                  >
                    {g.label}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.4, marginTop: 6 }}>
                    {g.detail}
                  </div>
                  <div
                    className="m-topbar-eyebrow"
                    style={{ marginTop: 10, color: 'var(--m-ink-3)', display: 'flex', gap: 14, flexWrap: 'wrap' }}
                  >
                    <span>
                      THRESHOLD <span className="num">{g.threshold}</span>
                    </span>
                    <span style={{ color: 'var(--m-red)' }}>
                      CURRENT <span className="num">{g.current_value}</span>
                    </span>
                  </div>
                  <div style={{ marginTop: 14 }}>
                    <MButtonRow>
                      <MButton size="sm" variant="ghost" onClick={() => handleSnooze(g)} disabled={busy}>
                        Snooze 24h
                      </MButton>
                      <MButton size="sm" variant="ghost" onClick={() => handleMute(g)} disabled={busy}>
                        Mute
                      </MButton>
                      <MButton size="sm" variant="quiet" onClick={() => handleClear(g)} disabled={busy}>
                        Clear
                      </MButton>
                    </MButtonRow>
                  </div>
                </div>
              ))}
            </div>

            <MSectionH>Recommended actions</MSectionH>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {recommendedTypes.map((type, i) => {
                const step = RECOVERY_STEPS[type]
                // Lead with the standard intelligence stripe; the safety
                // step gets the agent-draft surface so it reads as an
                // explicit "review before acting" recommendation.
                if (type === 'safety') {
                  return (
                    <MAiAgent
                      key={type}
                      attribution={
                        <>
                          Derived from the <strong>{TYPE_LABEL[type].toLowerCase()}</strong> guardrail.
                        </>
                      }
                    >
                      <div
                        style={{
                          fontFamily: 'var(--m-font-display)',
                          fontWeight: 700,
                          fontSize: 15,
                          marginBottom: 4,
                        }}
                      >
                        {step.title}
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.4 }}>{step.body}</div>
                    </MAiAgent>
                  )
                }
                return (
                  <MAiStripe
                    key={type}
                    tone="warn"
                    eyebrow={step.eyebrow}
                    title={step.title}
                    attribution={
                      <>
                        Derived from the <strong>{TYPE_LABEL[type].toLowerCase()}</strong> guardrail.
                      </>
                    }
                    action={
                      i === 0 ? (
                        <MButton size="sm" variant="primary" onClick={() => navigate(-1)}>
                          Back to project
                        </MButton>
                      ) : undefined
                    }
                  >
                    {step.body}
                  </MAiStripe>
                )
              })}
            </div>
          </>
        )}
      </MBody>
    </>
  )
}
