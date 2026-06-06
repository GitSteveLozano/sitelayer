import { useNavigate } from 'react-router-dom'
import type { ProjectRow } from '@/lib/api'
import type { ProjectCloseoutSnapshot } from '../../../lib/api/projects.js'
import { MI, MKpi, MKpiRow, MPill, MQuickAction, MQuickActionGrid } from '../../../components/m/index.js'
import { getActiveCompanySlug } from '../../../lib/api/client.js'
import { useProjectCloseoutMachine } from '../../../machines/project-closeout.js'
import { useProjectGuardrails } from '../../../lib/api/guardrails.js'
import { useProjectLostReason } from '../../../lib/api/project-lost-reasons.js'
import { LifecycleStepper } from '../../../components/lifecycle/stepper.js'
import type { ProjectLifecycleState } from '../../../lib/api/project-lifecycle.js'
import { formatMoney, shortDate } from '../format.js'

// Pipeline pill driven by the project_lifecycle workflow state
// (lifecycle_state on the row), NOT the legacy free-text `status`. Same
// label/tone table the LifecycleBanner uses (banner.tsx) so the hero pill
// and the banner never disagree. Falls back to 'draft' for a legacy row
// that predates the lifecycle column.
const LIFECYCLE_PILL: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | undefined }> = {
  draft: { label: 'Drafting', tone: undefined },
  estimating: { label: 'Estimating', tone: undefined },
  sent: { label: 'Sent', tone: 'amber' },
  accepted: { label: 'Accepted', tone: 'green' },
  declined: { label: 'Lost', tone: 'red' },
  in_progress: { label: 'In progress', tone: 'green' },
  done: { label: 'Done', tone: 'green' },
  archived: { label: 'Archived', tone: undefined },
}

// Pre-acceptance lifecycle states render the design's full-width STATUS
// HERO (design msg 53/54/55/56): a big word headline + supporting copy
// instead of the in-progress "% DONE" number hero. The `tone` selects the
// brutalist treatment — `accent` fills the hero yellow (SENT · AWAITING
// RESPONSE), `red` fills it for the lost banner, the rest are plain.
const STATUS_HERO: Partial<
  Record<
    ProjectLifecycleState,
    { dot: string; eyebrow: string; title: string; body: string; tone: 'plain' | 'accent' | 'red' }
  >
> = {
  draft: {
    dot: 'DRAFTING',
    eyebrow: 'DRAFTING',
    title: 'TAKEOFF + PRICE',
    body: 'No proposal sent yet. Finish the takeoff, set your margin, send it.',
    tone: 'plain',
  },
  estimating: {
    dot: 'ESTIMATING',
    eyebrow: 'ESTIMATING',
    title: 'TAKEOFF + PRICE',
    body: 'Building the takeoff and pricing. Finish the line items, then send.',
    tone: 'plain',
  },
  sent: {
    dot: 'SENT',
    eyebrow: 'SENT',
    title: 'AWAITING RESPONSE',
    body: 'The proposal is out with the client. Watch read status before nudging.',
    tone: 'accent',
  },
  accepted: {
    dot: 'ACCEPTED',
    eyebrow: 'ACCEPTED',
    title: 'CONTRACT SIGNED',
    body: 'Contract signed. Assign a foreman and lock the start date to kick off.',
    tone: 'plain',
  },
}

export function ProjectHero({
  project,
  pctSpent,
  onTrack,
  spent,
  bid,
  scheduleCount,
  scheduleTotal,
}: {
  project: ProjectRow
  pctSpent: number
  onTrack: boolean
  spent: number
  bid: number
  scheduleCount?: number
  scheduleTotal?: number
}) {
  const navigate = useNavigate()
  // Spend-progress drives the big number. Margin is derived from the same
  // bid-vs-spent pair the screen already computes; no new data wiring.
  const pctDone = Math.min(100, Math.max(0, pctSpent))
  const marginPct = bid > 0 ? Math.round(((bid - spent) / bid) * 100) : 0
  const barColor = onTrack ? 'var(--m-accent)' : 'var(--m-amber)'
  const state = (project.lifecycle_state as ProjectLifecycleState | undefined) ?? 'draft'
  const lifecyclePill = LIFECYCLE_PILL[state] ?? LIFECYCLE_PILL.draft!

  // Closed/Paid terminal hero (design msg 64): when the project-closeout
  // workflow has reached a terminal state, render the PAID variant over
  // the snapshot instead of the live "% SPENT" hero. Thin renderer — no
  // business state mirrored; state/closed_at/ack read straight off the
  // snapshot. The GET is cheap + cached (admin/office only; 403s silently
  // for other roles → snapshot stays null → live hero renders).
  const closeout = useProjectCloseoutMachine(project.id, getActiveCompanySlug())
  const closeoutSnap = closeout.snapshot
  // At-risk monitors (design msg 62): a triggered guardrail promotes the
  // in-progress hero to the red AT RISK variant. Only fetched for live
  // (in-progress) jobs; armed/snoozed/muted rows don't count.
  const guardrailsQuery = useProjectGuardrails(state === 'in_progress' ? project.id : undefined)
  const triggeredGuardrails = (guardrailsQuery.data?.guardrails ?? []).filter((g) => g.status === 'triggered')
  // Saved lost-reason note for the declined hero (design msg 55). Only
  // fetched once a project is actually declined to avoid a stray request
  // on every detail open.
  const lostQuery = useProjectLostReason(state === 'declined' ? project.id : undefined)
  if (closeoutSnap && (closeoutSnap.state === 'completed' || closeoutSnap.state === 'post_mortem')) {
    return <TerminalHero project={project} marginPct={marginPct} snapshot={closeoutSnap} />
  }

  // VALUE + EST. MARGIN KPI row shared by the pre-acceptance status heroes.
  const valueMarginKpis = (
    <MKpiRow>
      <MKpi label="Value" value={formatMoney(bid)} />
      <MKpi
        label="Est. margin"
        value={marginPct}
        unit="%"
        meta={`${marginPct >= 0 ? '+' : ''}${marginPct}% of bid`}
        metaTone={marginPct >= 0 ? 'green' : 'red'}
      />
    </MKpiRow>
  )

  // Bid-lost hero (design msg 55): red full-width banner with the saved
  // reason + note inline, replacing the percent hero entirely.
  if (state === 'declined') {
    const lost = lostQuery.data?.lost_reason ?? null
    return (
      <>
        <div
          style={{
            padding: '20px 20px 22px',
            borderBottom: '2px solid var(--m-line)',
            background: 'var(--m-red)',
            color: '#fff',
          }}
        >
          <StatusDot label="LOST" color="#fff" />
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontSize: 44,
              fontWeight: 800,
              letterSpacing: '-0.03em',
              lineHeight: 0.95,
              margin: '10px 0 12px',
            }}
          >
            Bid lost.
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.45, opacity: 0.92 }}>
            {lost?.note
              ? lost.note
              : `Sent ${formatMoney(bid)}. Log the lost reason so the win-rate report stays honest.`}
          </div>
          {lost?.reason ? (
            <div
              className="num"
              style={{ marginTop: 12, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', opacity: 0.92 }}
            >
              REASON · {lost.reason.toUpperCase()}
            </div>
          ) : null}
        </div>
        <LifecycleRow state={state} />
        {valueMarginKpis}
      </>
    )
  }

  // Pre-acceptance status hero (draft / estimating / sent / accepted) —
  // the design's word headline instead of a percent number.
  const statusHero = STATUS_HERO[state]
  if (statusHero) {
    const accent = statusHero.tone === 'accent'
    return (
      <>
        <div
          style={{
            padding: '20px 20px 22px',
            borderBottom: '2px solid var(--m-line)',
            background: accent ? 'var(--m-accent)' : 'var(--m-card-soft)',
            color: accent ? 'var(--m-accent-ink, var(--m-ink))' : 'var(--m-ink)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <StatusDot label={statusHero.dot} color={accent ? 'var(--m-ink)' : statusDotColor(state)} />
          </div>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              opacity: 0.7,
            }}
          >
            {project.customer_name} · {project.division_code}
          </div>
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontSize: 44,
              fontWeight: 800,
              letterSpacing: '-0.03em',
              lineHeight: 0.95,
              margin: '6px 0 12px',
            }}
          >
            {statusHero.title}
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.45, opacity: 0.85 }}>{statusHero.body}</div>
        </div>
        <LifecycleRow state={state} />
        {valueMarginKpis}
      </>
    )
  }

  // In-progress / done / archived → percent number hero. Per design msg 60
  // an in-progress project reads "% DONE" with an "IN PROGRESS · D{n}/{total}"
  // pill and a QUICK ACTIONS block; the schedule-day pill self-hides when
  // there's no schedule data.
  const inProgress = state === 'in_progress'
  const heroLabel = inProgress ? '% DONE' : '% SPENT'
  const dayN = scheduleCount ?? 0
  const dayTotal = Math.max(scheduleTotal ?? 0, dayN)

  // AT RISK promotion (design msg 62): a live job with a triggered
  // guardrail flips the hero pill/status/bar to red and shows the
  // guardrail's headline banner above the percent number.
  const atRisk = inProgress && triggeredGuardrails.length > 0
  const leadGuardrail = triggeredGuardrails[0] ?? null
  const heroBarColor = atRisk ? 'var(--m-red)' : barColor

  return (
    <>
      {atRisk && leadGuardrail ? (
        <div
          style={{
            padding: '18px 20px 20px',
            borderBottom: '2px solid var(--m-line)',
            background: 'var(--m-red)',
            color: '#fff',
          }}
        >
          <StatusDot label={leadGuardrail.label.toUpperCase()} color="#fff" />
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: '-0.02em',
              lineHeight: 1.15,
              marginTop: 10,
            }}
          >
            {leadGuardrail.detail || 'Burn rate is outpacing the plan. Margin recoverable if addressed this week.'}
          </div>
        </div>
      ) : null}
      <div
        style={{
          padding: '20px 20px 22px',
          borderBottom: '2px solid var(--m-line)',
          background: 'var(--m-card-soft)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          {atRisk ? (
            <MPill tone="red" dot>
              AT RISK{dayN > 0 ? ` · D${dayN} / ${dayTotal}` : ''}
            </MPill>
          ) : inProgress && dayN > 0 ? (
            <MPill tone="green" dot>
              IN PROGRESS · D{dayN} / {dayTotal}
            </MPill>
          ) : (
            <MPill tone={lifecyclePill.tone} dot>
              {lifecyclePill.label}
            </MPill>
          )}
          <span
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: atRisk ? 'var(--m-red)' : onTrack ? 'var(--m-green)' : 'var(--m-amber)',
            }}
          >
            {atRisk ? 'AT RISK' : onTrack ? (inProgress ? 'HEALTHY' : 'ON TRACK') : 'WATCH'}
          </span>
        </div>

        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-3)',
          }}
        >
          {project.customer_name} · {project.division_code}
        </div>
        <div
          style={{
            fontFamily: 'var(--m-font-display)',
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            lineHeight: 1.1,
            margin: '4px 0 14px',
          }}
        >
          {project.name}
        </div>

        <div
          className="num"
          style={{
            fontFamily: 'var(--m-font-display)',
            fontSize: 80,
            fontWeight: 800,
            letterSpacing: '-0.04em',
            lineHeight: 0.85,
            color: 'var(--m-ink)',
          }}
        >
          {pctDone}
          <span style={{ fontSize: 24, fontWeight: 700, opacity: 0.55, marginLeft: 4 }}>{heroLabel}</span>
        </div>
        <div style={{ height: 8, background: 'var(--m-line)', marginTop: 18 }}>
          <div style={{ width: `${pctDone}%`, height: '100%', background: heroBarColor }} />
        </div>
        {/* Lifecycle stepper (design M03) — pure derivation of the
            project_lifecycle state on the row. */}
        <div style={{ marginTop: 16 }}>
          <LifecycleStepper state={state} />
        </div>
      </div>

      <MKpiRow>
        <MKpi
          label="Margin"
          value={marginPct}
          unit="%"
          meta={`${marginPct >= 0 ? '+' : ''}${marginPct}% of bid`}
          metaTone={marginPct >= 0 ? 'green' : 'red'}
        />
        <MKpi label="Spent" value={formatMoney(spent)} meta={`of ${formatMoney(bid)}`} />
      </MKpiRow>

      {/* QUICK ACTIONS block (design msg 60) — only for in-progress jobs. */}
      {inProgress ? (
        <div style={{ padding: '12px 16px 4px' }}>
          <div className="m-topbar-eyebrow" style={{ marginBottom: 10 }}>
            QUICK ACTIONS
          </div>
          <MQuickActionGrid>
            <MQuickAction Icon={MI.Users} label="Crew" onClick={() => navigate('/crew')} />
            <MQuickAction Icon={MI.FileText} label="Daily logs" onClick={() => navigate('/log')} />
            <MQuickAction Icon={MI.Layers} label="Photos" onClick={() => navigate(`/projects/${project.id}/takeoff`)} />
            <MQuickAction
              Icon={MI.AlertTri}
              label="Recovery"
              onClick={() => navigate(`/projects/${project.id}/recovery`)}
            />
          </MQuickActionGrid>
        </div>
      ) : null}
    </>
  )
}

/** Mono dot + uppercase status label (● SENT). */
function StatusDot({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="num"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 999, background: color }} />
      {label}
    </span>
  )
}

function statusDotColor(state: ProjectLifecycleState): string {
  if (state === 'accepted') return 'var(--m-green)'
  if (state === 'declined') return 'var(--m-red)'
  return 'var(--m-ink-3)'
}

/** Lifecycle stepper row, padded to align under the hero. */
function LifecycleRow({ state }: { state: ProjectLifecycleState }) {
  return (
    <div style={{ padding: '14px 20px', borderBottom: '2px solid var(--m-line)' }}>
      <div className="m-topbar-eyebrow" style={{ marginBottom: 8 }}>
        LIFECYCLE
      </div>
      <LifecycleStepper state={state} />
    </div>
  )
}

/**
 * Closed/Paid terminal hero variant (design msg 64). Renders the green ●
 * PAID dot, the closed date, the final margin big-number (reused from the
 * live hero's bid-vs-spent computation), and an active → completed →
 * post-mortem lifecycle strip derived from the closeout snapshot. The
 * "Open post-mortem" affordance deep-links to the mobile post-mortem
 * route. Thin renderer — every fact is read off the snapshot.
 */
function TerminalHero({
  project,
  marginPct,
  snapshot,
}: {
  project: ProjectRow
  marginPct: number
  snapshot: ProjectCloseoutSnapshot
}) {
  const navigate = useNavigate()
  const closedAt = snapshot.context.closed_at
  const ackAt = snapshot.context.post_mortem_acknowledged_at
  const isPostMortem = snapshot.state === 'post_mortem'
  const steps: Array<{ label: string; done: boolean }> = [
    { label: 'Active', done: true },
    { label: 'Completed', done: true },
    { label: 'Post-mortem', done: isPostMortem },
  ]

  return (
    <div
      style={{
        padding: '20px 20px 22px',
        borderBottom: '2px solid var(--m-line)',
        background: 'var(--m-card-soft)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <MPill tone="green" dot>
          PAID
        </MPill>
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--m-green)',
          }}
        >
          {closedAt ? `CLOSED · ${shortDate(closedAt)}` : 'CLOSED'}
        </span>
      </div>

      <div
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--m-ink-3)',
        }}
      >
        {project.customer_name} · {project.division_code}
      </div>
      <div
        style={{
          fontFamily: 'var(--m-font-display)',
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: '-0.02em',
          lineHeight: 1.1,
          margin: '4px 0 14px',
        }}
      >
        {project.name}
      </div>

      <div
        className="num"
        style={{
          fontFamily: 'var(--m-font-display)',
          fontSize: 80,
          fontWeight: 800,
          letterSpacing: '-0.04em',
          lineHeight: 0.85,
          color: marginPct >= 0 ? 'var(--m-ink)' : 'var(--m-red)',
        }}
      >
        {marginPct}
        <span style={{ fontSize: 24, fontWeight: 700, opacity: 0.55, marginLeft: 4 }}>% FINAL MARGIN</span>
      </div>

      {/* Lifecycle strip: active → completed → post-mortem. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 18 }}>
        {steps.map((step, idx) => (
          <span key={step.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              className="num"
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: step.done ? 'var(--m-green)' : 'var(--m-ink-3)',
              }}
            >
              {step.label}
            </span>
            {idx < steps.length - 1 ? <span style={{ color: 'var(--m-ink-3)' }}>→</span> : null}
          </span>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        <button
          type="button"
          onClick={() => navigate(`/projects/${project.id}/post-mortem`)}
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--m-ink)',
            background: 'transparent',
            border: '1px solid var(--m-line)',
            borderRadius: 8,
            padding: '8px 14px',
            cursor: 'pointer',
          }}
        >
          {ackAt ? `Post-mortem · reviewed ${shortDate(ackAt)}` : 'Open post-mortem'}
        </button>
      </div>
    </div>
  )
}
