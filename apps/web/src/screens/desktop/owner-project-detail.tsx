/**
 * Owner desktop PROJECT DETAIL — split + budget aside + 6 tabs (Desktop v2 · 03).
 * Reuses the exact per-tab data hooks the mobile project-detail tabs use
 * (useProjectLaborVariance, useProjectCloseoutSummary, useDailyLogs,
 * useProjectBlueprints, useProjectChangeOrders, useProjectTimeline); just a
 * dense desktop composition. See docs/V2_DESKTOP_AND_REMAINING_PLAN.md and
 * /tmp/desktop_template.html "PROJECT DETAIL · SPLIT + BUDGET ASIDE".
 *
 * Parent (DesktopWorkspace) wires the route + passes bootstrap. Project
 * name/status/labor-rate come from the bootstrap projects list (no single
 * desktop project hook), found by :projectId; falls back to the projects
 * list hook so a deep-linked project that isn't in bootstrap still resolves,
 * else a graceful empty state.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import type { ProjectRow } from '@/lib/api'
import { DataTable, DDrawer, DEyebrow, DH1, DKpi, DKpiStrip, DTabBar, type DColumn } from '@/components/d'
import { MBanner, MButton, MChip, MChipRow, MInput, MPill, MTextarea } from '@/components/m'
import { useProjects } from '@/lib/api/projects'
import { useProjectTimeline, useProjectBriefs, type ProjectTimelineEvent } from '@/lib/api/projects'
import { useProjectLaborVariance } from '@/lib/api/labor-variance'
import { useProjectCloseoutSummary } from '@/lib/api/closeout-summary'
import { useDailyLogs, type DailyLog } from '@/lib/api/daily-logs'
import { useProjectBlueprints, type BlueprintDocument } from '@/lib/api/takeoff'
import { useProjectChangeOrders, type ChangeOrder } from '@/lib/api/change-orders'
import { useCreateProjectBrief, type ProjectBriefStep } from '@/lib/api/project-briefs'
import { useSendPaymentReminders } from '@/lib/api/payment-reminders'
import { ChangeOrderDrawer, InvoiceModal, PostMortemDrawer, RecoveryDrawer } from './project-drawers'
import { LifecycleBanner } from '@/components/lifecycle/banner'
import { formatMoney, formatStatusLabel, shortDate, timeOfDay, todayIso } from '../mobile/format.js'

type ProjectOverlay = 'recovery' | 'change-order' | 'post-mortem' | 'invoice' | 'brief' | 'reminders' | null

type TabKey = 'overview' | 'budget' | 'crew' | 'logs' | 'files' | 'activity'

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'budget', label: 'Budget' },
  { key: 'crew', label: 'Crew' },
  { key: 'logs', label: 'Logs' },
  { key: 'files', label: 'Files' },
  { key: 'activity', label: 'Activity' },
]

export function OwnerProjectDetail({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  const [tab, setTab] = useState<TabKey>('overview')
  const [overlay, setOverlay] = useState<ProjectOverlay>(null)

  // Project identity — prefer bootstrap (already in-memory for the desktop
  // shell). If a deep link lands on a project that isn't in the bootstrap
  // window, fall back to the projects list hook (only fetched when missing).
  const fromBootstrap = bootstrap?.projects.find((p) => p.id === projectId) ?? null
  const projectsQuery = useProjects({}, { enabled: !fromBootstrap && Boolean(projectId) })
  const fromList = projectsQuery.data?.projects.find((p) => p.id === projectId) ?? null

  const name = fromBootstrap?.name ?? fromList?.name ?? null
  // Pipeline state reads off the project_lifecycle workflow (lifecycle_state),
  // NOT the legacy free-text `status` column. lifecycle_state is the single
  // source for header label / billing gate / post-mortem gate. Falls back to
  // 'draft' for a legacy row that predates the column (matches the reducer's
  // initialState).
  const lifecycleState = fromBootstrap?.lifecycle_state ?? fromList?.lifecycle_state ?? 'draft'
  // Change Order + Invoice only make sense once a project is actually being
  // worked/billed — a project becomes billable when the customer accepts.
  const showBilling = ['accepted', 'in_progress', 'done', 'archived'].includes(lifecycleState)
  const customer = fromBootstrap?.customer_name ?? fromList?.customer_name ?? '—'
  const bidTotal = Number(fromBootstrap?.bid_total ?? fromList?.bid_total ?? 0)
  const laborRate = Number(fromBootstrap?.labor_rate ?? 0)

  // Labor scoped to this project, from bootstrap (same source the mobile
  // crew/budget tabs use). Drives spend, days-left, and the Crew table.
  const labor = useMemo(
    () => (bootstrap?.laborEntries ?? []).filter((l) => l.project_id === projectId && !l.deleted_at),
    [bootstrap?.laborEntries, projectId],
  )
  const workers = bootstrap?.workers ?? []
  const schedules = useMemo(
    () => (bootstrap?.schedules ?? []).filter((s) => s.project_id === projectId),
    [bootstrap?.schedules, projectId],
  )

  const totalHours = labor.reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
  const spent = totalHours * laborRate
  const pctSpent = bidTotal > 0 ? Math.round((spent / bidTotal) * 100) : 0
  const completePct = Math.min(100, pctSpent) // proxy: spend pace vs bid
  const dayCount = schedules.length
  const planDays = Math.max(dayCount, 14)
  const daysLeft = Math.max(0, planDays - dayCount)
  const onTrack = pctSpent <= 75

  // Loading / not-found: bootstrap absent and the fallback list still resolving.
  if (!name) {
    if (projectsQuery.isPending && !fromBootstrap) {
      return (
        <div className="d-content">
          <div style={{ color: 'var(--m-ink-3)' }}>Loading project…</div>
        </div>
      )
    }
    return (
      <div className="d-content">
        <div className="d-stack">
          <div>
            <DEyebrow>Project</DEyebrow>
            <DH1>Project not found</DH1>
          </div>
          <div className="d-card" style={{ color: 'var(--m-ink-2)' }}>
            This project may have been archived or you may not have access.
            <div style={{ marginTop: 14 }}>
              <MButton variant="primary" onClick={() => navigate('/desktop/projects')}>
                Back to projects
              </MButton>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const project = (fromBootstrap ?? fromList) as ProjectRow | null

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>
            {customer} · {formatStatusLabel(lifecycleState)} · D{dayCount}/{planDays}
          </DEyebrow>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
            <DH1>{name}</DH1>
            <MPill tone={onTrack ? 'green' : 'red'} dot>
              {onTrack ? 'On track' : 'At risk'}
            </MPill>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <MButton variant="primary" onClick={() => navigate(`/desktop/canvas/${projectId}`)}>
              Takeoff →
            </MButton>
            <MButton variant="ghost" onClick={() => setOverlay('brief')}>
              Edit brief
            </MButton>
            {!onTrack ? (
              <MButton variant="ghost" onClick={() => setOverlay('recovery')}>
                Recovery plan
              </MButton>
            ) : null}
            {showBilling ? (
              <>
                <MButton variant="ghost" onClick={() => setOverlay('change-order')}>
                  + Change order
                </MButton>
                <MButton variant="ghost" onClick={() => setOverlay('invoice')}>
                  Invoice
                </MButton>
                <MButton variant="ghost" onClick={() => setOverlay('reminders')}>
                  Send reminders
                </MButton>
              </>
            ) : null}
            {lifecycleState === 'done' || lifecycleState === 'archived' ? (
              <MButton variant="ghost" onClick={() => setOverlay('post-mortem')}>
                Post-mortem
              </MButton>
            ) : null}
          </div>
        </div>

        <DKpiStrip>
          <DKpi label="Complete" value={String(completePct)} unit="%" meta="Spend pace vs bid" />
          <DKpi
            label="Margin"
            value={bidTotal > 0 ? String(Math.round(((bidTotal - spent) / bidTotal) * 100)) : '—'}
            unit={bidTotal > 0 ? '%' : undefined}
            meta="Remaining of bid"
          />
          <DKpi
            label="Spent"
            value={formatMoney(spent)}
            tone={onTrack ? undefined : 'accent'}
            meta={`of ${formatMoney(bidTotal)} bid`}
          />
          <DKpi label="Days left" value={String(daysLeft)} meta={`Day ${dayCount} of ${planDays}`} />
        </DKpiStrip>

        <DTabBar tabs={[...TABS]} active={tab} onSelect={(k) => setTab(k as TabKey)} />

        <div className="d-split">
          <div className="d-stack">
            {tab === 'overview' && (
              <OverviewTab
                name={name}
                customer={customer}
                bid={bidTotal}
                division={project?.division_code}
                projectId={projectId}
                onOpenTab={setTab}
              />
            )}
            {tab === 'budget' && (
              <BudgetTab projectId={projectId} spent={spent} bid={bidTotal} pctSpent={pctSpent} laborRate={laborRate} />
            )}
            {tab === 'crew' && <CrewTab labor={labor} workers={workers} laborRate={laborRate} />}
            {tab === 'logs' && <LogsTab projectId={projectId} />}
            {tab === 'files' && <FilesTab projectId={projectId} navigate={navigate} />}
            {tab === 'activity' && <ActivityTab projectId={projectId} />}
          </div>

          <BudgetAside
            projectId={projectId}
            bid={bidTotal}
            spent={spent}
            pctSpent={pctSpent}
            totalHours={totalHours}
            laborRate={laborRate}
            navigate={navigate}
          />
        </div>
      </div>
      <RecoveryDrawer
        open={overlay === 'recovery'}
        onClose={() => setOverlay(null)}
        projectId={projectId}
        daysLeft={daysLeft}
        bidTotal={bidTotal}
        laborRate={laborRate}
        spent={spent}
      />
      <ChangeOrderDrawer open={overlay === 'change-order'} projectId={projectId} onClose={() => setOverlay(null)} />
      <PostMortemDrawer open={overlay === 'post-mortem'} onClose={() => setOverlay(null)} projectId={projectId} />
      <InvoiceModal
        open={overlay === 'invoice'}
        onClose={() => setOverlay(null)}
        projectId={projectId}
        projectName={name}
        customerName={customer}
        contractValue={bidTotal}
      />
      <BriefEditDrawer
        open={overlay === 'brief'}
        onClose={() => setOverlay(null)}
        projectId={projectId}
        projectName={name}
      />
      <SendRemindersDrawer
        open={overlay === 'reminders'}
        onClose={() => setOverlay(null)}
        projectId={projectId}
        projectName={name}
        customerName={customer}
      />
    </div>
  )
}

// ============================================================
// Brief Edit drawer (Desktop v2 · DBriefEdit, reachable from project detail).
// Reuses the same hook surface as fm-brief.tsx — goal + numbered steps over
// local state, submitted through useCreateProjectBrief (POST /briefs).
// ============================================================

const DRAWER_LABEL: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--m-ink-3)',
}

function BriefEditDrawer({
  open,
  onClose,
  projectId,
  projectName,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  projectName: string | null
}) {
  const createBrief = useCreateProjectBrief(projectId)
  const [goal, setGoal] = useState('')
  const [steps, setSteps] = useState<ProjectBriefStep[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const addStep = () => setSteps((cur) => [...cur, { id: `local-${Date.now()}`, title: '' }])
  const removeStep = (idx: number) => setSteps((cur) => cur.filter((_, i) => i !== idx))
  const updateStep = (idx: number, title: string) =>
    setSteps((cur) => cur.map((s, i) => (i === idx ? { ...s, title } : s)))

  const trimmedGoal = goal.trim()
  const canSave = Boolean(projectId) && trimmedGoal.length > 0 && !createBrief.isPending

  function save() {
    if (!canSave) return
    setError(null)
    setSaved(false)
    createBrief.mutate(
      {
        effective_date: todayIso(),
        goal: trimmedGoal,
        steps: steps.filter((s) => s.title.trim().length > 0),
      },
      {
        onSuccess: () => {
          setSaved(true)
          window.setTimeout(onClose, 700)
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not save the brief.'),
      },
    )
  }

  return (
    <DDrawer open={open} onClose={onClose} title={`✎ BRIEF · ${(projectName ?? 'PROJECT').toUpperCase()}`}>
      {error ? (
        <div style={{ marginBottom: 14 }}>
          <MBanner tone="error" title="Couldn't push the brief" body={error} />
        </div>
      ) : null}
      {saved ? (
        <div
          style={{
            marginBottom: 14,
            fontFamily: 'var(--m-num)',
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--m-green)',
          }}
        >
          ✓ Brief pushed to the crew.
        </div>
      ) : null}

      <div style={DRAWER_LABEL}>TODAY&apos;S GOAL</div>
      <MTextarea
        value={goal}
        onChange={(e) => setGoal(e.currentTarget.value)}
        placeholder="What's the crew building today, in plain words?"
        maxLength={280}
        style={{ width: '100%', minHeight: 96, marginTop: 8 }}
      />
      <div style={{ ...DRAWER_LABEL, marginTop: 6, textAlign: 'right' }}>{goal.length} / 280</div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 18,
          marginBottom: 8,
        }}
      >
        <div style={DRAWER_LABEL}>STEP PLAN · {steps.length}</div>
        <MButton size="sm" variant="ghost" onClick={addStep}>
          + Add step
        </MButton>
      </div>

      <div style={{ border: '2px solid var(--m-ink)' }}>
        {steps.length === 0 ? (
          <div style={{ padding: '14px 16px', color: 'var(--m-ink-3)', fontSize: 13 }}>
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
                borderBottom: idx === steps.length - 1 ? 'none' : '1px solid var(--m-line-2)',
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

      <MButton variant="primary" style={{ width: '100%', marginTop: 20 }} onClick={save} disabled={!canSave}>
        {createBrief.isPending ? 'Pushing…' : 'Save + push to crew'}
      </MButton>
    </DDrawer>
  )
}

// ============================================================
// Send Reminders drawer — POSTs /api/payment-reminders for THIS project
// (useSendPaymentReminders). A focused single-project adaptation of the
// bulk reminders modal in owner-money.tsx.
// ============================================================

function SendRemindersDrawer({
  open,
  onClose,
  projectId,
  projectName,
  customerName,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  projectName: string | null
  customerName: string
}) {
  const sendReminders = useSendPaymentReminders()
  const [error, setError] = useState<string | null>(null)
  const [sentCount, setSentCount] = useState<number | null>(null)

  function send() {
    if (!projectId || sendReminders.isPending) return
    setError(null)
    setSentCount(null)
    sendReminders.mutate(
      { project_ids: [projectId] },
      {
        onSuccess: (res) => {
          setSentCount(res.reminders_sent)
          window.setTimeout(onClose, 900)
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not send the reminder.'),
      },
    )
  }

  return (
    <DDrawer open={open} onClose={onClose} title={`● SEND REMINDER · ${(projectName ?? 'PROJECT').toUpperCase()}`}>
      {error ? (
        <div style={{ marginBottom: 14 }}>
          <MBanner tone="error" title="Couldn't send reminder" body={error} />
        </div>
      ) : null}
      {sentCount != null ? (
        <div
          style={{
            marginBottom: 14,
            fontFamily: 'var(--m-num)',
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--m-green)',
          }}
        >
          ✓ {sentCount} reminder{sentCount === 1 ? '' : 's'} queued.
        </div>
      ) : null}

      <div style={DRAWER_LABEL}>RECIPIENT</div>
      <div
        style={{
          marginTop: 8,
          padding: '14px 16px',
          border: '2px solid var(--m-ink)',
          background: 'var(--m-card-soft)',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700 }}>{projectName ?? 'This project'}</div>
        <div style={{ ...DRAWER_LABEL, marginTop: 4 }}>{customerName}</div>
      </div>

      <div style={{ ...DRAWER_LABEL, marginTop: 16, lineHeight: 1.6 }}>
        Queues a payment follow-up notification for this project to you. The worker drains it through the notification
        pipeline.
      </div>

      <MButton
        variant="primary"
        style={{ width: '100%', marginTop: 20 }}
        onClick={send}
        disabled={!projectId || sendReminders.isPending}
      >
        {sendReminders.isPending ? 'Sending…' : 'Send reminder'}
      </MButton>
    </DDrawer>
  )
}

// ---- Overview ------------------------------------------------------------
// A swatch palette for the recent-photos grid — the design shows solid
// colored tiles (the thumbnails aren't fetched on this surface), so we render
// stable per-key placeholders in the brand palette.
const PHOTO_SWATCHES = ['#E0A468', '#C97B4A', '#A85C32', '#7E8A5C', '#5B7FA6', '#E8B57A', '#C2693C', '#8C6B4A']

type NeedsYouAction = { id: string; label: string; tone: 'red' | 'amber' | 'accent'; onClick: () => void }

function OverviewTab({
  name,
  customer,
  bid,
  division,
  projectId,
  onOpenTab,
}: {
  name: string
  customer: string
  bid: number
  division?: string | null | undefined
  projectId: string
  onOpenTab: (tab: TabKey) => void
}) {
  const timeline = useProjectTimeline(projectId)
  const briefs = useProjectBriefs(projectId)
  const logs = useDailyLogs({ projectId })
  const changeOrders = useProjectChangeOrders(projectId)

  // Latest brief (the foreman's most-recent pushed plan).
  const brief = useMemo(() => {
    const all = briefs.data?.briefs ?? []
    return [...all].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0] ?? null
  }, [briefs.data?.briefs])
  const briefCrewCount = Array.isArray(brief?.crew) ? brief?.crew.length : 0

  // "Needs you" — real pending items that want an owner decision, surfaced
  // from the project's live data. Each row deep-links to the relevant tab.
  const needs = useMemo<NeedsYouAction[]>(() => {
    const out: NeedsYouAction[] = []
    const draftLogs = (logs.data?.dailyLogs ?? []).filter((l) => l.status === 'draft')
    for (const l of draftLogs.slice(0, 2)) {
      out.push({
        id: `log-${l.id}`,
        label: `Daily log from ${shortDate(l.occurred_on)} · approve`,
        tone: 'amber',
        onClick: () => onOpenTab('logs'),
      })
    }
    const proposed = (changeOrders.data?.change_orders ?? []).filter((c) => /propos|pending|draft|sent/i.test(c.status))
    for (const co of proposed.slice(0, 2)) {
      out.push({
        id: `co-${co.id}`,
        label: `Change order #${co.number} ${formatStatusLabel(co.status).toLowerCase()} · review`,
        tone: 'red',
        onClick: () => onOpenTab('budget'),
      })
    }
    if (!brief) {
      out.push({
        id: 'brief',
        label: 'No brief pushed yet · set the crew up',
        tone: 'accent',
        onClick: () => onOpenTab('overview'),
      })
    }
    return out
  }, [logs.data?.dailyLogs, changeOrders.data?.change_orders, brief, onOpenTab])

  // Recent photos — every photo key across the project's daily logs.
  const photoKeys = useMemo(() => {
    const all: string[] = []
    for (const l of logs.data?.dailyLogs ?? []) {
      if (Array.isArray(l.photo_keys)) all.push(...l.photo_keys)
    }
    return all
  }, [logs.data?.dailyLogs])

  return (
    <>
      {/* Project-lifecycle workflow banner — the advance-pipeline affordance
          (server-truth state + next_events buttons) on desktop, dispatching
          through the same headless useProjectLifecycle XState machine the
          mobile overview uses. This is the desktop banner's real home
          (the orphaned screens/projects/detail.tsx was deleted). See
          docs/DETERMINISTIC_WORKFLOWS.md. */}
      <div className="d-card" style={{ padding: 0, background: 'transparent', border: 'none' }}>
        <LifecycleBanner projectId={projectId} />
      </div>

      <div className="d-split" style={{ gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)' }}>
        {/* TODAY'S BRIEF card — the foreman's pushed plan, quote + author/crew. */}
        <div className="d-card">
          <span
            style={{
              display: 'inline-block',
              fontFamily: 'var(--m-num)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              background: 'var(--m-accent)',
              color: 'var(--m-accent-ink)',
              padding: '4px 8px',
            }}
          >
            {brief ? `Today's brief · pushed ${timeOfDay(brief.created_at)}` : "Today's brief"}
          </span>
          {brief ? (
            <>
              <div style={{ marginTop: 14, fontSize: 21, fontWeight: 700, lineHeight: 1.3, color: 'var(--m-ink)' }}>
                &ldquo;{brief.goal}&rdquo;
              </div>
              <div
                className="num"
                style={{
                  marginTop: 14,
                  fontSize: 11,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: 'var(--m-ink-3)',
                }}
              >
                {briefCrewCount > 0 ? `${briefCrewCount} crew on site` : `${name} · ${division ?? ''} for ${customer}`}
              </div>
            </>
          ) : (
            <div style={{ marginTop: 14, fontSize: 15, color: 'var(--m-ink-2)', lineHeight: 1.5 }}>
              No brief pushed yet — {name} is a {formatMoney(bid)} {division ?? ''} job for {customer}. Push a brief to
              set the crew up.
            </div>
          )}
        </div>

        {/* NEEDS YOU — action list, each row a color-barred deep link. */}
        <div className="d-card">
          <div className="d-eyebrow">Needs you</div>
          {needs.length === 0 ? (
            <div style={{ marginTop: 12, color: 'var(--m-ink-3)', fontSize: 13 }}>
              Nothing waiting on you right now.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
              {needs.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={a.onClick}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    width: '100%',
                    textAlign: 'left',
                    padding: '12px 14px',
                    background: 'var(--m-card-soft)',
                    border: '1px solid var(--m-line-2)',
                    borderLeft: `4px solid ${
                      a.tone === 'red' ? 'var(--m-red)' : a.tone === 'amber' ? 'var(--m-amber)' : 'var(--m-accent)'
                    }`,
                    cursor: 'pointer',
                    font: 'inherit',
                    color: 'var(--m-ink)',
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{a.label}</span>
                  <span aria-hidden style={{ color: 'var(--m-ink-3)', fontSize: 16 }}>
                    →
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* RECENT PHOTOS — swatch grid, count in the eyebrow. */}
      <div className="d-card">
        <div className="d-eyebrow">Recent photos · {photoKeys.length}</div>
        {photoKeys.length === 0 ? (
          <div style={{ marginTop: 12, color: 'var(--m-ink-3)', fontSize: 13 }}>
            No photos yet — they land here from the crew&apos;s daily logs.
          </div>
        ) : (
          <div
            style={{
              marginTop: 12,
              display: 'grid',
              gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
              gap: 10,
            }}
          >
            {photoKeys.slice(0, 8).map((key, i) => (
              <div
                key={key}
                aria-hidden
                style={{
                  aspectRatio: '1 / 1',
                  background: PHOTO_SWATCHES[i % PHOTO_SWATCHES.length],
                  border: '1px solid var(--m-line-2)',
                }}
              />
            ))}
          </div>
        )}
      </div>

      <ActivityList
        title="Recent activity"
        events={(timeline.data?.events ?? []).slice(0, 6)}
        pending={timeline.isPending}
        error={timeline.isError}
        compact
      />
    </>
  )
}

// ---- Budget --------------------------------------------------------------
/** Burn bar — a 2px-ruled fill on the sand track, tone-coded by burn %. */
function BurnBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct))
  const fill = pct > 100 ? 'var(--m-red)' : pct >= 90 ? 'var(--m-amber)' : 'var(--m-green)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 140 }}>
      <div
        aria-hidden
        style={{
          flex: 1,
          height: 8,
          background: 'var(--m-sand-2)',
          border: '1px solid var(--m-line-2)',
          overflow: 'hidden',
        }}
      >
        <div style={{ width: `${clamped}%`, height: '100%', background: fill }} />
      </div>
      <span
        className="num"
        style={{ fontSize: 11, fontWeight: 700, color: 'var(--m-ink-2)', minWidth: 34, textAlign: 'right' }}
      >
        {Math.round(pct)}%
      </span>
    </div>
  )
}

// Per-cost-line row shaped for the design's BID / SPENT / BURN / STATUS table.
type BudgetLineRow = {
  code: string
  division: string | null
  bidDollars: number
  spentDollars: number
  burnPct: number
  hasEst: boolean
}

function BudgetTab({
  projectId,
  spent,
  bid,
  pctSpent,
  laborRate,
}: {
  projectId: string
  spent: number
  bid: number
  pctSpent: number
  laborRate: number
}) {
  const variance = useProjectLaborVariance(projectId)
  const summary = useProjectCloseoutSummary(projectId)
  const s = summary.data

  // Convert each variance line into bid$ / spent$ (hours × the project's
  // labor rate) + a burn % (actual vs estimated hours). Burn drives both the
  // bar and the OK / WATCH / OVER status pill.
  const lines = useMemo<BudgetLineRow[]>(() => {
    return (variance.data?.variance ?? []).map((r) => {
      const hasEst = r.estimated_hours > 0 || r.estimated_quantity > 0
      const burnPct = r.estimated_hours > 0 ? (r.actual_hours / r.estimated_hours) * 100 : r.actual_hours > 0 ? 100 : 0
      return {
        code: r.service_item_code,
        division: r.division_code,
        bidDollars: r.estimated_hours * laborRate,
        spentDollars: r.actual_hours * laborRate,
        burnPct,
        hasEst,
      }
    })
  }, [variance.data?.variance, laborRate])

  const projectedMarginPct = s && s.bid > 0 ? s.margin_pct : bid > 0 ? ((bid - spent) / bid) * 100 : 0
  const marginDelta = s ? s.margin_pct : 0

  const columns: Array<DColumn<BudgetLineRow>> = [
    {
      key: 'code',
      header: 'Cost line',
      render: (r) => (
        <span className="d-table-cell-strong">
          {r.code}
          {r.division ? ` · ${r.division}` : ''}
        </span>
      ),
    },
    { key: 'bid', header: 'Bid', numeric: true, render: (r) => formatMoney(r.bidDollars) },
    {
      key: 'spent',
      header: 'Spent',
      numeric: true,
      render: (r) => (
        <span style={{ color: r.burnPct > 100 ? 'var(--m-red)' : 'var(--m-ink)', fontWeight: 700 }}>
          {formatMoney(r.spentDollars)}
        </span>
      ),
    },
    { key: 'burn', header: 'Burn', render: (r) => <BurnBar pct={r.burnPct} /> },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        if (!r.hasEst) return <span style={{ color: 'var(--m-ink-3)' }}>no est.</span>
        const tone: 'green' | 'amber' | 'red' = r.burnPct > 100 ? 'red' : r.burnPct >= 90 ? 'amber' : 'green'
        const label = r.burnPct > 100 ? 'Over' : r.burnPct >= 90 ? 'Watch' : 'OK'
        return (
          <MPill tone={tone} dot>
            {label}
          </MPill>
        )
      },
    },
  ]

  return (
    <>
      {/* Three headline tiles — BID TOTAL · SPENT (% of bid) · PROJECTED MARGIN
          (highlighted, with vs-bid delta) — matching the design. */}
      {summary.isPending ? (
        <div className="d-card" style={{ color: 'var(--m-ink-3)' }}>
          Loading closeout summary…
        </div>
      ) : (
        <DKpiStrip>
          <DKpi label="Bid total" value={formatMoney(s?.bid || bid)} />
          <DKpi label="Spent" value={formatMoney(s?.total_actual ?? spent)} meta={`${pctSpent}% of bid`} />
          <DKpi
            label="Projected margin"
            value={String(Math.round(projectedMarginPct))}
            unit="%"
            tone="accent"
            meta={
              marginDelta !== 0
                ? `${marginDelta >= 0 ? '+' : '−'}${Math.abs(marginDelta).toFixed(0)} vs bid`
                : undefined
            }
          />
        </DKpiStrip>
      )}

      <DataTable<BudgetLineRow>
        columns={columns}
        rows={lines}
        rowKey={(r) => r.code}
        empty={
          variance.isPending
            ? 'Loading cost lines…'
            : variance.isError
              ? 'Could not load cost lines.'
              : 'No cost lines yet — labor entries with sqft_done populate this once jobs are in progress.'
        }
      />
    </>
  )
}

// ---- Crew ----------------------------------------------------------------
type CrewRow = {
  id: string
  name: string
  role: string
  onTask: string | null
  hours: number
  onSite: boolean
}

/** Initials avatar — a solid near-black square, the design's crew thumbnail. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}
function CrewAvatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: 30,
        height: 30,
        flexShrink: 0,
        background: 'var(--m-ink)',
        color: 'var(--m-accent)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--m-num)',
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {initials(name) || '—'}
    </span>
  )
}

function CrewTab({
  labor,
  workers,
  laborRate,
}: {
  labor: BootstrapResponse['laborEntries']
  workers: BootstrapResponse['workers']
  laborRate: number
}) {
  const rows = useMemo<CrewRow[]>(() => {
    const map = new Map<string, CrewRow & { lastDate: string }>()
    for (const l of labor) {
      const wid = l.worker_id ?? 'unassigned'
      const worker = workers.find((w) => w.id === wid)
      const name = worker?.name ?? 'Unassigned'
      const cur = map.get(wid) ?? {
        id: wid,
        name,
        role: worker?.role ?? 'crew',
        onTask: null,
        hours: 0,
        onSite: false,
        lastDate: '',
      }
      cur.hours += Number(l.hours ?? 0)
      // "On task" = the cost code of the most recent labor entry for this crew.
      const date = l.occurred_on ?? ''
      if (date >= cur.lastDate) {
        cur.lastDate = date
        cur.onTask = l.service_item_code || cur.onTask
      }
      map.set(wid, cur)
    }
    // Anyone with hours logged in the last 3 days reads as on-site.
    const cutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)
    return Array.from(map.values())
      .map((r) => ({ ...r, onSite: r.lastDate >= cutoff }))
      .sort((a, b) => b.hours - a.hours)
  }, [labor, workers])

  const onSiteCount = rows.filter((r) => r.onSite).length
  const totalHours = rows.reduce((sum, r) => sum + r.hours, 0)
  const laborCost = totalHours * laborRate

  const columns: Array<DColumn<CrewRow>> = [
    {
      key: 'name',
      header: 'Crew',
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <CrewAvatar name={r.name} />
          <span className="d-table-cell-strong">{r.name}</span>
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (r) => (
        <span
          className="num"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            border: '1.5px solid var(--m-line-2)',
            padding: '3px 7px',
            color: 'var(--m-ink-2)',
          }}
        >
          {r.role}
        </span>
      ),
    },
    { key: 'task', header: 'On task', render: (r) => r.onTask ?? '—' },
    { key: 'hours', header: 'Week hrs', numeric: true, render: (r) => r.hours.toFixed(1) },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone={r.onSite ? 'green' : 'amber'} dot>
          {r.onSite ? 'On' : 'Off'}
        </MPill>
      ),
    },
  ]
  return (
    <>
      {/* Three summary tiles — on-site count · week hours · week labor cost. */}
      <DKpiStrip>
        <DKpi label="On site now" value={String(onSiteCount)} />
        <DKpi label="Crew-hrs this week" value={totalHours.toFixed(1)} />
        <DKpi label="Labor cost wk" value={formatMoney(laborCost)} tone="accent" />
      </DKpiStrip>

      <DataTable<CrewRow> columns={columns} rows={rows} rowKey={(r) => r.id} empty="No labor entries logged yet." />
    </>
  )
}

// ---- Logs ----------------------------------------------------------------
function LogsTab({ projectId }: { projectId: string }) {
  const query = useDailyLogs({ projectId })
  const logs = useMemo(
    () => [...(query.data?.dailyLogs ?? [])].sort((a, b) => (b.occurred_on ?? '').localeCompare(a.occurred_on ?? '')),
    [query.data?.dailyLogs],
  )

  const columns: Array<DColumn<DailyLog>> = [
    {
      key: 'date',
      header: 'Date',
      render: (r) => <span className="d-table-cell-strong">{shortDate(r.occurred_on)}</span>,
    },
    { key: 'notes', header: 'Notes', render: (r) => logPreview(r) },
    {
      key: 'photos',
      header: 'Photos',
      numeric: true,
      render: (r) => String(Array.isArray(r.photo_keys) ? r.photo_keys.length : 0),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone={r.status === 'submitted' ? 'green' : 'amber'} dot>
          {r.status === 'submitted' ? 'Submitted' : 'Draft'}
        </MPill>
      ),
    },
  ]
  return (
    <DataTable<DailyLog>
      title="Daily logs"
      columns={columns}
      rows={logs}
      rowKey={(r) => r.id}
      empty={
        query.isPending
          ? 'Loading daily logs…'
          : query.isError
            ? 'Could not load daily logs.'
            : 'No daily logs yet. Foreman end-of-day reports land here once the crew is on site.'
      }
    />
  )
}

// ---- Files ---------------------------------------------------------------
/** File-extension → small type badge (PDF / ZIP / IMG). */
function fileExtBadge(fileName: string, previewType: string): string {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  if (ext === 'pdf') return 'PDF'
  if (ext === 'zip') return 'ZIP'
  if (/png|jpg|jpeg|gif|webp|heic/.test(ext)) return 'IMG'
  if (previewType) return previewType.slice(0, 3).toUpperCase()
  return 'DOC'
}

/** Filename heuristic → category TYPE pill (PLANS / CONTRACT / TAKEOFF / …). */
function fileTypeTag(fileName: string): string {
  const n = fileName.toLowerCase()
  if (/contract|signed|agreement/.test(n)) return 'Contract'
  if (/takeoff|measure/.test(n)) return 'Takeoff'
  if (/co-|change|change-order/.test(n)) return 'Change order'
  if (/photo|\.zip$/.test(n)) return 'Photos'
  if (/draw|plan|sheet|blueprint/.test(n)) return 'Plans'
  return 'Drawing'
}

function FilesTab({ projectId, navigate }: { projectId: string; navigate: (path: string) => void }) {
  const query = useProjectBlueprints(projectId)
  const blueprints = (query.data?.blueprints ?? []).filter((b) => !b.deleted_at)

  const columns: Array<DColumn<BlueprintDocument>> = [
    {
      key: 'file',
      header: 'File',
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span
            aria-hidden
            className="num"
            style={{
              width: 30,
              height: 30,
              flexShrink: 0,
              border: '1.5px solid var(--m-line-2)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 8,
              fontWeight: 700,
              color: 'var(--m-ink-3)',
            }}
          >
            {fileExtBadge(r.file_name, r.preview_type)}
          </span>
          <span className="d-table-cell-strong">{r.file_name || 'Untitled drawing'}</span>
        </span>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      render: (r) => (
        <span
          className="num"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            border: '1.5px solid var(--m-line-2)',
            padding: '3px 7px',
            color: 'var(--m-ink-2)',
          }}
        >
          {fileTypeTag(r.file_name)}
        </span>
      ),
    },
    { key: 'added_by', header: 'Added by', render: () => '—' },
    {
      key: 'size',
      header: 'Size',
      numeric: true,
      render: (r) => (r.calibration_length ? 'Scaled' : '—'),
    },
    { key: 'date', header: 'Date', render: (r) => fmtFileDate(r.created_at) },
  ]
  const uploadButton = (
    <MButton size="sm" variant="primary" onClick={() => navigate(`/desktop/canvas/${projectId}`)}>
      Upload
    </MButton>
  )
  return (
    <DataTable<BlueprintDocument>
      title={`${blueprints.length} ${blueprints.length === 1 ? 'file' : 'files'}`}
      action={uploadButton}
      columns={columns}
      rows={blueprints}
      rowKey={(r) => r.id}
      empty={
        query.isPending
          ? 'Loading drawings…'
          : query.isError
            ? 'Could not load drawings.'
            : 'No drawings yet. Drop a PDF or photo on the takeoff canvas to start measuring scope.'
      }
    />
  )
}

// ---- Activity ------------------------------------------------------------
type ActivityCategory = 'all' | 'money' | 'time' | 'field' | 'briefs' | 'docs'

const ACTIVITY_FILTERS: ReadonlyArray<{ key: ActivityCategory; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'money', label: 'Money' },
  { key: 'time', label: 'Time' },
  { key: 'field', label: 'Field' },
  { key: 'briefs', label: 'Briefs' },
  { key: 'docs', label: 'Docs' },
]

// Map a timeline event onto one of the design's activity categories, by the
// entity type + action verb. Each category carries a left-bar accent color.
function categorize(ev: ProjectTimelineEvent): Exclude<ActivityCategory, 'all'> {
  const hay = `${ev.entity_type} ${ev.action}`.toLowerCase()
  if (/invoice|estimate|payment|bill|change_order|money|qbo/.test(hay)) return 'money'
  if (/clock|labor|time|payroll|hours/.test(hay)) return 'time'
  if (/log|issue|field|flag|photo|problem/.test(hay)) return 'field'
  if (/brief|plan/.test(hay)) return 'briefs'
  if (/blueprint|file|document|takeoff|measurement/.test(hay)) return 'docs'
  return 'field'
}
const CATEGORY_COLOR: Record<Exclude<ActivityCategory, 'all'>, string> = {
  money: 'var(--m-green)',
  time: 'var(--m-ink)',
  field: 'var(--m-red)',
  briefs: 'var(--m-accent)',
  docs: 'var(--m-ink-3)',
}

function ActivityTab({ projectId }: { projectId: string }) {
  const timeline = useProjectTimeline(projectId)
  const [cat, setCat] = useState<ActivityCategory>('all')
  const events = timeline.data?.events ?? []
  const filtered = useMemo(() => (cat === 'all' ? events : events.filter((e) => categorize(e) === cat)), [events, cat])

  return (
    <div className="d-card">
      <MChipRow>
        {ACTIVITY_FILTERS.map((f) => (
          <MChip key={f.key} active={cat === f.key} onClick={() => setCat(f.key)}>
            {f.label}
          </MChip>
        ))}
      </MChipRow>

      {timeline.isPending ? (
        <div style={{ marginTop: 12, color: 'var(--m-ink-3)' }}>Loading activity…</div>
      ) : timeline.isError ? (
        <div style={{ marginTop: 12, color: 'var(--m-red)' }}>Could not load activity.</div>
      ) : filtered.length === 0 ? (
        <div style={{ marginTop: 12, color: 'var(--m-ink-3)' }}>No activity in this category.</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
          {filtered.map((ev, idx) => {
            const c = categorize(ev)
            return (
              <li
                key={ev.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '12px 14px',
                  borderTop: idx === 0 ? 'none' : '1px solid var(--m-line-2)',
                  borderLeft: `4px solid ${CATEGORY_COLOR[c]}`,
                }}
              >
                <span
                  className="num"
                  style={{
                    fontSize: 11,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                    color: 'var(--m-ink-3)',
                    minWidth: 64,
                    flexShrink: 0,
                  }}
                >
                  {timeOfDay(ev.created_at)}
                </span>
                {ev.actor_role ? (
                  <span
                    className="num"
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      border: '1.5px solid var(--m-line-2)',
                      padding: '3px 7px',
                      color: 'var(--m-ink-2)',
                      flexShrink: 0,
                    }}
                  >
                    {ev.actor_role}
                  </span>
                ) : null}
                <span style={{ fontSize: 14, fontWeight: 600, minWidth: 0 }}>{formatStatusLabel(ev.action)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function ActivityList({
  title,
  events,
  pending,
  error,
  compact,
}: {
  title: string
  events: ProjectTimelineEvent[]
  pending: boolean
  error: boolean
  compact?: boolean
}) {
  return (
    <div className="d-card">
      <div className="d-eyebrow">{title}</div>
      {pending ? (
        <div style={{ marginTop: 10, color: 'var(--m-ink-3)' }}>Loading activity…</div>
      ) : error ? (
        <div style={{ marginTop: 10, color: 'var(--m-red)' }}>Could not load activity.</div>
      ) : events.length === 0 ? (
        <div style={{ marginTop: 10, color: 'var(--m-ink-3)' }}>No activity recorded yet.</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
          {(compact ? events.slice(0, 6) : events).map((ev, idx) => (
            <li
              key={ev.id}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'baseline',
                padding: '10px 0',
                borderTop: idx === 0 ? 'none' : '1px solid var(--m-line-2)',
              }}
            >
              <span style={{ width: 8, height: 8, background: 'var(--m-accent)', flexShrink: 0 }} aria-hidden />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{formatStatusLabel(ev.action)}</div>
                <div
                  className="num"
                  style={{ fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--m-ink-3)' }}
                >
                  {ev.entity_type}
                  {ev.actor_role ? ` · ${ev.actor_role}` : ''} · {shortDate(ev.created_at)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---- Aside (sticky budget / quick facts + change orders) -----------------
function BudgetAside({
  projectId,
  bid,
  spent,
  pctSpent,
  totalHours,
  laborRate,
  navigate,
}: {
  projectId: string
  bid: number
  spent: number
  pctSpent: number
  totalHours: number
  laborRate: number
  navigate: (path: string) => void
}) {
  const changeOrders = useProjectChangeOrders(projectId)
  const cos = (changeOrders.data?.change_orders ?? []).slice(0, 4)
  const acceptedDelta = changeOrders.data?.accepted_value_delta ?? 0
  const remaining = bid - spent
  const tone = pctSpent < 60 ? 'green' : pctSpent < 90 ? 'amber' : 'red'

  return (
    <aside className="d-card" style={{ position: 'sticky', top: 16, alignSelf: 'start' }}>
      <div className="d-eyebrow">Budget</div>
      <Fact label="Bid" value={formatMoney(bid)} />
      <Fact label="Spent" value={formatMoney(spent)} valueTone={tone} />
      <Fact label="Remaining" value={formatMoney(remaining)} />
      <Fact label="% spent" value={`${pctSpent}%`} />

      <div className="d-eyebrow" style={{ marginTop: 22 }}>
        Quick facts
      </div>
      <Fact label="Labor logged" value={`${totalHours.toFixed(1)}h`} />
      <Fact label="Labor rate" value={`$${laborRate}/hr`} />
      <Fact
        label="Effective value"
        value={formatMoney(bid + acceptedDelta)}
        meta={`incl. ${formatMoney(acceptedDelta)} COs`}
      />

      <div
        style={{
          marginTop: 22,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span className="d-eyebrow">Change orders</span>
        <button
          type="button"
          onClick={() => navigate(`/projects/${projectId}/change-orders`)}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            font: 'inherit',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-2)',
          }}
        >
          View all →
        </button>
      </div>
      {changeOrders.isPending ? (
        <div style={{ marginTop: 10, color: 'var(--m-ink-3)', fontSize: 13 }}>Loading…</div>
      ) : cos.length === 0 ? (
        <div style={{ marginTop: 10, color: 'var(--m-ink-3)', fontSize: 13 }}>No change orders.</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
          {cos.map((co, idx) => (
            <ChangeOrderItem key={co.id} co={co} isFirst={idx === 0} />
          ))}
        </ul>
      )}
    </aside>
  )
}

function ChangeOrderItem({ co, isFirst }: { co: ChangeOrder; isFirst: boolean }) {
  const delta = Number(co.value_delta ?? 0)
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        padding: '10px 0',
        borderTop: isFirst ? 'none' : '1px solid var(--m-line-2)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          #{co.number} {co.description}
        </div>
        <div
          className="num"
          style={{ fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--m-ink-3)' }}
        >
          {formatStatusLabel(co.status)}
        </div>
      </div>
      <span className="num" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
        {delta >= 0 ? '+' : '−'}
        {formatMoney(Math.abs(delta))}
      </span>
    </li>
  )
}

function Fact({
  label,
  value,
  valueTone,
  meta,
}: {
  label: string
  value: string
  valueTone?: 'green' | 'amber' | 'red'
  meta?: string
}) {
  const color =
    valueTone === 'green'
      ? 'var(--m-green)'
      : valueTone === 'amber'
        ? 'var(--m-amber)'
        : valueTone === 'red'
          ? 'var(--m-red)'
          : 'var(--m-ink)'
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        padding: '8px 0',
        borderTop: '1px solid var(--m-line-2)',
        marginTop: 8,
      }}
    >
      <span
        className="num"
        style={{ fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--m-ink-3)' }}
      >
        {label}
      </span>
      <span style={{ textAlign: 'right' }}>
        <span className="num" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color }}>
          {value}
        </span>
        {meta ? (
          <span
            className="num"
            style={{
              display: 'block',
              fontSize: 10,
              color: 'var(--m-ink-3)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            {meta}
          </span>
        ) : null}
      </span>
    </div>
  )
}

// ---- helpers -------------------------------------------------------------
function fmtFileDate(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function logPreview(log: DailyLog): string {
  const notes = (log.notes ?? '').trim()
  if (notes) return notes.length > 80 ? `${notes.slice(0, 80)}…` : notes
  return 'No notes recorded'
}
