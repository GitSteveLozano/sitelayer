import type { ProjectLifecycleState } from '@/lib/api/project-lifecycle'

/**
 * Lifecycle stepper (design M03: horizontal DRAFT·SENT·ACCEPTED·PROGRESS·PAID
 * track highlighting the current stage). A PURE derivation of the
 * project_lifecycle snapshot.state — no business state, no fetch. The
 * fixed display track collapses the 8 reducer states onto 5 visual
 * columns; `declined` is rendered as an off-track red "Lost" terminal
 * (the track greyed). Keyed on the typed union so the map stays
 * exhaustive (a new reducer state without a mapping is a compile error).
 */
const TRACK = ['DRAFT', 'SENT', 'ACCEPTED', 'PROGRESS', 'PAID'] as const
type TrackStep = (typeof TRACK)[number]

// lifecycle_state → highlighted step index (estimating is a sub-phase of
// the DRAFT column visually; done/archived both read as PAID).
const STATE_TO_STEP: Record<ProjectLifecycleState, TrackStep | 'lost'> = {
  draft: 'DRAFT',
  estimating: 'DRAFT',
  sent: 'SENT',
  accepted: 'ACCEPTED',
  in_progress: 'PROGRESS',
  done: 'PAID',
  archived: 'PAID',
  declined: 'lost',
}

export function lifecycleStepIndex(state: ProjectLifecycleState): number {
  const step = STATE_TO_STEP[state]
  if (step === 'lost') return -1
  return TRACK.indexOf(step)
}

export function LifecycleStepper({ state }: { state: ProjectLifecycleState }) {
  const activeIndex = lifecycleStepIndex(state)
  const isLost = activeIndex === -1

  return (
    <div data-testid="lifecycle-stepper" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {TRACK.map((label, idx) => {
        const reached = !isLost && idx <= activeIndex
        const current = !isLost && idx === activeIndex
        return (
          <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              data-step={label}
              data-current={current ? 'true' : undefined}
              className="num"
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: isLost
                  ? 'var(--m-ink-3)'
                  : current
                    ? 'var(--m-ink)'
                    : reached
                      ? 'var(--m-green)'
                      : 'var(--m-ink-3)',
              }}
            >
              {label}
            </span>
            {idx < TRACK.length - 1 ? <span style={{ color: 'var(--m-ink-3)', fontSize: 10 }}>·</span> : null}
          </span>
        )
      })}
      {isLost ? (
        <span
          data-testid="lifecycle-stepper-lost"
          className="num"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--m-red)',
            marginLeft: 4,
          }}
        >
          Lost
        </span>
      ) : null}
    </div>
  )
}
