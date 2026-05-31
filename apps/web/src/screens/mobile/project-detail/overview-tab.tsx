import type { ProjectRow } from '@/lib/api'
import type { ProjectLifecycleState } from '@/lib/api/project-lifecycle'
import { MButton, MI, MListInset, MListRow, MSectionH } from '../../../components/m/index.js'
import { MAiStripe } from '../../../components/m/ai.js'
import { BidAccuracyCard } from '../../projects/bid-accuracy-card.js'
import { LifecycleBanner } from '../../../components/lifecycle/banner.js'
import { CloseoutBanner } from '../../../components/closeout/banner.js'
import { getActiveCompanySlug } from '../../../lib/api/client.js'
import { useProjectLifecycle } from '../../../machines/project-lifecycle.js'
import { formatDecimalHours, formatMoney } from '../format.js'

export function Overview({
  project,
  totalHours,
  bid,
  spent,
  pctSpent,
  navigate,
}: {
  project: ProjectRow
  totalHours: number
  bid: number
  spent: number
  pctSpent: number
  navigate: (path: string) => void
}) {
  const summary = `${project.name}, ${formatMoney(bid)} ${project.division_code} job for ${project.customer_name}.`

  // Single source for the pipeline state of the per-state CTA card below:
  // the project_lifecycle workflow snapshot (NOT the legacy `status`
  // regex). The LifecycleBanner above owns the advance-pipeline actions;
  // this lifted instance feeds ProjectStatePanel's contextual copy so the
  // two never diverge. Falls back to the row's lifecycle_state, then
  // 'draft', while the snapshot loads.
  const lifecycle = useProjectLifecycle(project.id, getActiveCompanySlug())
  const lifecycleState: ProjectLifecycleState =
    (lifecycle.snapshot?.state as ProjectLifecycleState | undefined) ??
    ((project.lifecycle_state as ProjectLifecycleState | undefined) ?? 'draft')

  return (
    <div style={{ paddingTop: 8 }}>
      {/* Project-lifecycle workflow banner — server-truth state +
          next_events from the project-lifecycle reducer
          (packages/workflows/src/project-lifecycle.ts) consumed via
          the headless useProjectLifecycle XState machine
          (apps/web/src/machines/project-lifecycle.ts). See
          docs/DETERMINISTIC_WORKFLOWS.md. */}
      <div style={{ padding: '0 16px 12px' }}>
        <LifecycleBanner projectId={project.id} />
      </div>
      {/* Project-closeout workflow banner — server-truth state +
          next_events from the project-closeout reducer
          (packages/workflows/src/project-closeout.ts) consumed via
          the headless useProjectCloseoutMachine XState machine
          (apps/web/src/machines/project-closeout.ts). Self-hides
          while the project is still active with no pending events
          so the Overview tab stays calm for early-stage projects. */}
      <div style={{ padding: '0 16px 12px' }}>
        <CloseoutBanner projectId={project.id} />
      </div>
      <ProjectStatePanel state={lifecycleState} projectId={project.id} navigate={navigate} />
      {/* Bid-accuracy keystone (mirrors the desktop overview hero per
          `/tmp/sitelayer_design_stuff/ai-keystone.jsx`). Self-hides
          when no comparable cohort exists yet. */}
      <div style={{ padding: '0 16px 12px' }}>
        <BidAccuracyCard projectId={project.id} />
      </div>
      {pctSpent > 75 ? (
        <div style={{ padding: '0 16px 12px' }}>
          <MAiStripe
            tone="warn"
            eyebrow="Budget watch"
            title={`${pctSpent}% of bid spent — keep an eye on materials`}
            attribution={
              <>
                Based on <strong>logged labor + materials</strong>.
              </>
            }
          >
            Labor pace {formatDecimalHours(totalHours, 1)}; remaining budget {formatMoney(bid - spent)}.
          </MAiStripe>
        </div>
      ) : null}
      <div style={{ padding: '0 20px 14px', fontSize: 14, color: 'var(--m-ink-2)', lineHeight: 1.5 }}>{summary}</div>
      <MSectionH>Drill in</MSectionH>
      <MListInset>
        <MListRow
          leading={<MI.Layers size={18} />}
          leadingTone="accent"
          headline="Blueprints / takeoff"
          supporting="Drawings + measurements"
          chev
          onTap={() => navigate(`/projects/${project.id}/takeoff`)}
        />
        <MListRow
          leading={<MI.FileText size={18} />}
          headline="Estimate"
          supporting="Line items + send"
          chev
          onTap={() => navigate(`/projects/${project.id}/estimate`)}
        />
        <MListRow
          leading={<MI.Users size={18} />}
          headline="Crew & hours"
          supporting={`${formatDecimalHours(totalHours, 1)} logged`}
          chev
        />
        <MListRow
          leading={<MI.Truck size={18} />}
          headline="Materials & costs"
          supporting="Bills + rental dispatch"
          chev
          onTap={() => navigate('/rentals/dispatch')}
        />
        <MListRow
          leading={<MI.Clock size={18} />}
          headline="Schedule"
          supporting="Slot in 4-week planner"
          chev
          onTap={() => navigate('/schedule')}
        />
        <MListRow
          leading={<MI.FileText size={18} />}
          headline="Daily log"
          supporting="From foreman"
          chev
          onTap={() => navigate('/log')}
        />
      </MListInset>
      <MSectionH>Change &amp; risk</MSectionH>
      <MListInset>
        <MListRow
          leading={<MI.FileText size={18} />}
          leadingTone="accent"
          headline="Change orders"
          supporting="Scope addendums + value delta"
          chev
          onTap={() => navigate(`/projects/${project.id}/change-orders`)}
        />
        <MListRow
          leading={<MI.AlertTri size={18} />}
          leadingTone="red"
          headline="Recovery plan"
          supporting="At-risk guardrails + actions"
          chev
          onTap={() => navigate(`/projects/${project.id}/recovery`)}
        />
        <MListRow
          leading={<MI.X size={18} />}
          headline="Mark lost"
          supporting="Capture the lost reason"
          chev
          onTap={() => navigate(`/projects/${project.id}/lost`)}
        />
      </MListInset>
    </div>
  )
}

type HeroConfig = {
  eyebrow: string
  title: string
  body: string
  primary: string
  primaryPath: string
  secondary: string
  secondaryPath: string
}

/**
 * Per-state contextual CTA copy, keyed on the typed 8-state lifecycle
 * union from @sitelayer/workflows. Declared as an exhaustive
 * `Record<ProjectLifecycleState, …>` so adding a reducer state without
 * copy is a COMPILE error — the structural guard against the old
 * `normalizeProjectState` bucket-collapse (which silently dropped
 * `estimating` and `declined` into `draft`). `:id` is interpolated by
 * the panel from `projectId`.
 */
const STATE_HERO: Record<ProjectLifecycleState, (id: string) => HeroConfig> = {
  draft: (id) => ({
    eyebrow: 'Drafting',
    title: 'Start with takeoff, then build the estimate.',
    body: 'Client and archetype are enough for now. Measurements and line items come next.',
    primary: 'Start takeoff',
    primaryPath: `/projects/${id}/takeoff`,
    secondary: 'Open estimate',
    secondaryPath: `/projects/${id}/estimate`,
  }),
  estimating: (id) => ({
    eyebrow: 'Estimating',
    title: 'Building the takeoff and pricing.',
    body: 'Finish the line items, then send the estimate to the customer.',
    primary: 'Open estimate',
    primaryPath: `/projects/${id}/estimate`,
    secondary: 'Takeoff',
    secondaryPath: `/projects/${id}/takeoff`,
  }),
  sent: (id) => ({
    eyebrow: 'Awaiting client',
    title: 'Estimate is out. Watch read status before nudging.',
    body: 'Signed portal activity and estimate push history live in the estimate workflow.',
    primary: 'Review send',
    primaryPath: `/projects/${id}/estimate`,
    secondary: 'Share link',
    secondaryPath: `/projects/${id}/estimate`,
  }),
  accepted: (id) => ({
    eyebrow: 'Accepted',
    title: 'Assign foreman and lock the start date.',
    body: 'Once scheduled, this appears in the foreman morning flow.',
    primary: 'Schedule',
    primaryPath: '/schedule',
    secondary: 'Crew',
    secondaryPath: '/crew',
  }),
  declined: (id) => ({
    eyebrow: 'Bid lost',
    title: 'This bid was declined.',
    body: 'Review the lost reason, or reopen it as a new bid. Archive when fully closed out.',
    primary: 'View reason',
    primaryPath: `/projects/${id}/lost`,
    secondary: 'Files',
    secondaryPath: `/projects/${id}/takeoff`,
  }),
  in_progress: (id) => ({
    eyebrow: 'In progress',
    title: 'Track budget, daily log, crew, and materials.',
    body: 'Foreman logs and worker evidence roll up here as the job moves.',
    primary: 'Budget',
    primaryPath: `/projects/${id}`,
    secondary: 'Brief crew',
    secondaryPath: `/brief/${id}`,
  }),
  done: (id) => ({
    eyebrow: 'Closing',
    title: 'Create final invoice and archive when paid.',
    body: 'Use logged scope, materials, and approved time as the closeout record.',
    primary: 'Invoice',
    primaryPath: '/invoice/new',
    secondary: 'Files',
    secondaryPath: `/projects/${id}/takeoff`,
  }),
  archived: (id) => ({
    eyebrow: 'Archived',
    title: 'Read-only job record.',
    body: 'Use this project for reports, bid accuracy, and historical comparisons.',
    primary: 'Files',
    primaryPath: `/projects/${id}/takeoff`,
    secondary: 'Projects',
    secondaryPath: '/projects',
  }),
}

export function ProjectStatePanel({
  state,
  projectId,
  navigate,
}: {
  state: ProjectLifecycleState
  projectId: string
  navigate: (path: string) => void
}) {
  const config = STATE_HERO[state](projectId)

  return (
    <div style={{ padding: '0 16px 12px' }}>
      <div className="m-card" style={{ background: 'var(--m-card-soft)' }}>
        <div className="m-topbar-eyebrow">{config.eyebrow}</div>
        <div style={{ fontSize: 17, fontWeight: 600, marginTop: 4 }}>{config.title}</div>
        <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.45, marginTop: 4 }}>{config.body}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <MButton variant="primary" size="sm" onClick={() => navigate(config.primaryPath)}>
            {config.primary}
          </MButton>
          <MButton variant="ghost" size="sm" onClick={() => navigate(config.secondaryPath)}>
            {config.secondary}
          </MButton>
        </div>
      </div>
    </div>
  )
}
