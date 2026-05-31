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
 *   - AI · DO THESE THIS WEEK — ranked, numbered (1/2/3) recovery action
 *     cards (design msg 62/63), one per distinct triggered guardrail type,
 *     each with a square number chip, headline, projected margin delta,
 *     and a DO IT button. Copy is static per guardrail type.
 *
 * Pure renderer over useProjectGuardrails + useProjectCloseoutSummary.
 * No business state lives here beyond the per-guardrail pending action.
 */
import { useNavigate, useParams } from 'react-router-dom'
import type { Guardrail, GuardrailType } from '../../lib/api/guardrails.js'
import { useGuardrailAction, useProjectGuardrails } from '../../lib/api/guardrails.js'
import { useProjectCloseoutSummary } from '../../lib/api/closeout-summary.js'
import { MBanner, MBody, MButton, MButtonRow, MKpi, MSectionH, MTopBar } from '../../components/m/index.js'
import { formatMoney } from './format.js'

/**
 * Static recovery copy keyed by guardrail type, surfaced by the design's
 * "AI · DO THESE THIS WEEK" numbered cards (design msg 62/63). `marginDelta`
 * is the projected margin recovery the action buys back — a guardrail-type
 * heuristic, not a live read-model number (the guardrails API carries no
 * per-action savings figure), so it reads as the AI's recommendation. */
const RECOVERY_STEPS: Record<GuardrailType, { title: string; body: string; marginDelta: number }> = {
  margin: {
    title: 'Trim crew on the next dispatch',
    body: 'Margin is below the floor. Pull a body off the next dispatch and re-price any open change orders before they post.',
    marginDelta: 7,
  },
  schedule: {
    title: 'Add a Saturday shift',
    body: "You're past the schedule threshold. Add a Saturday shift or pull a crew forward to claw back the slip before the next milestone.",
    marginDelta: 3,
  },
  safety: {
    title: 'Stop work and re-brief the crew',
    body: 'A safety guardrail tripped. Pause the affected scope, run a toolbox talk, and document the corrective action before resuming.',
    marginDelta: 0,
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
          <div className="m-topbar-eyebrow" style={{ fontWeight: 800, color: 'var(--m-red)', letterSpacing: '0.08em' }}>
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
                  <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.4, marginTop: 6 }}>{g.detail}</div>
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

            {/* AI · DO THESE THIS WEEK — the design's ranked numbered
                action list (msg 62/63). Each distinct triggered guardrail
                type yields one ordered card: a square accent number chip,
                the action headline, EST. MARGIN recovery, and a DO IT
                button. Recovery copy is keyed by guardrail type. */}
            <div style={{ marginTop: 18, marginBottom: 10 }}>
              <span
                className="num"
                style={{
                  display: 'inline-block',
                  background: 'var(--m-accent)',
                  color: 'var(--m-accent-ink)',
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: '0.08em',
                  padding: '5px 10px',
                }}
              >
                AI · DO THESE THIS WEEK
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {recommendedTypes.map((type, i) => {
                const step = RECOVERY_STEPS[type]
                return <RecoveryActionCard key={type} rank={i + 1} step={step} onDoIt={() => navigate(-1)} />
              })}
            </div>
          </>
        )}
      </MBody>
    </>
  )
}

/**
 * One ranked recovery action card (design msg 62/63). A leading square
 * accent number chip, the action headline, an EST. MARGIN recovery mono
 * line, and a black "DO IT" button on the right.
 */
function RecoveryActionCard({
  rank,
  step,
  onDoIt,
}: {
  rank: number
  step: { title: string; body: string; marginDelta: number }
  onDoIt: () => void
}) {
  return (
    <div className="m-card" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', borderColor: 'var(--m-ink)' }}>
      <span
        className="num"
        style={{
          flexShrink: 0,
          width: 28,
          height: 28,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--m-accent)',
          color: 'var(--m-accent-ink)',
          fontSize: 14,
          fontWeight: 800,
        }}
      >
        {rank}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 700,
            fontSize: 15,
            lineHeight: 1.15,
            color: 'var(--m-ink)',
          }}
        >
          {step.title}
        </div>
        <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.4, marginTop: 4 }}>{step.body}</div>
        {step.marginDelta > 0 ? (
          <div
            className="num"
            style={{
              marginTop: 8,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              color: 'var(--m-green)',
            }}
          >
            MARGIN +{step.marginDelta}%
          </div>
        ) : null}
      </div>
      <MButton size="sm" variant="primary" onClick={onDoIt}>
        Do it
      </MButton>
    </div>
  )
}
