import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  MBanner,
  MBody,
  MButton,
  MI,
  MKpi,
  MKpiRow,
  MListInset,
  MListRow,
  MQuickAction,
  MQuickActionGrid,
  MSectionH,
  MTopBar,
} from '../../components/m/index.js'
import {
  apiGet,
  fetchAppIssueBoard,
  fetchOpsDiagnostics,
  fetchWorkRequestQueueHealth,
  fetchWorkRequests,
  queryKeys,
  useAppIssueCapabilities,
  type ContextWorkItem,
  type OpsDiagnosticComponent,
  type OpsDiagnosticStatus,
  type WorkItemStatus,
  type WorkRequestQueueHealthResponse,
} from '@/lib/api'
import { getBuildSha } from '@/lib/api/client'
import { useOnlineStatus } from '@/lib/offline/online-status'
import { canTriageWorkRequests } from '@/lib/work-request-permissions'
import type { CompanyRole } from '@sitelayer/domain'

const OPEN_WORK_STATUSES = new Set<WorkItemStatus>([
  'new',
  'triaged',
  'agent_running',
  'human_assigned',
  'review_ready',
  'review_stale',
  'proposal_expired',
  'reopened',
])

interface WorkerIssueRow {
  id: string
  resolved_at?: string | null
  created_at?: string | null
  urgency?: string | null
  severity?: string | null
  project_id?: string | null
}

interface WorkerIssuesResponse {
  worker_issues?: WorkerIssueRow[]
}

export function MobileOps({ companyRole, companySlug }: { companyRole: CompanyRole; companySlug: string }) {
  const navigate = useNavigate()
  const online = useOnlineStatus()
  const canTriage = canTriageWorkRequests(companyRole)
  const buildSha = getBuildSha()

  const work = useQuery({
    queryKey: queryKeys.workRequests.list({ limit: 75 }),
    queryFn: () => fetchWorkRequests({ limit: 75 }),
    refetchInterval: 30_000,
  })
  const health = useQuery({
    queryKey: queryKeys.workRequests.health(),
    queryFn: fetchWorkRequestQueueHealth,
    enabled: canTriage,
    refetchInterval: 30_000,
  })
  const workerIssues = useQuery({
    queryKey: ['worker-issues', 'ops-open', companySlug],
    queryFn: () => apiGet<WorkerIssuesResponse>('/api/worker-issues?resolved=false', companySlug),
    refetchInterval: 30_000,
  })
  const appIssueCaps = useAppIssueCapabilities()
  const canViewAppIssues = Boolean(appIssueCaps.data?.includes('app_issue.view'))
  const appIssues = useQuery({
    queryKey: ['app-issues', 'ops-summary', canViewAppIssues],
    queryFn: () => fetchAppIssueBoard({ groupBy: 'status_group', limit: 50 }),
    enabled: canViewAppIssues,
    refetchInterval: 30_000,
  })
  const opsDiagnostics = useQuery({
    queryKey: ['ops-diagnostics', companySlug],
    queryFn: () => fetchOpsDiagnostics(companySlug),
    enabled: canViewAppIssues,
    refetchInterval: 15_000,
  })

  const workItems = work.data?.work_items ?? []
  const openWork = useMemo(() => workItems.filter((item) => OPEN_WORK_STATUSES.has(item.status)), [workItems])
  const reviewReady = health.data?.work_items.review_ready ?? countStatus(workItems, 'review_ready')
  const staleReview =
    (health.data?.work_items.review_stale ?? countStatus(workItems, 'review_stale')) +
    (health.data?.work_items.proposal_expired ?? countStatus(workItems, 'proposal_expired'))
  const dispatchActive = health.data ? health.data.dispatch_outbox.pending + health.data.dispatch_outbox.processing : 0
  const dispatchFailed = health.data ? health.data.dispatch_outbox.failed + health.data.dispatch_outbox.dead : 0
  const dispatchConfigured = health.data
    ? isDispatchConfigured(health.data.config) && health.data.config.scoped_callbacks_enabled
    : null
  const openFieldIssues = (workerIssues.data?.worker_issues ?? []).filter((issue) => !issue.resolved_at)
  const appIssueCount = appIssues.data?.issues.length ?? 0
  const systemComponents = opsDiagnostics.data?.components ?? []
  const gateway = componentByKey(systemComponents, 'gateway')
  const screenCapture = componentByKey(systemComponents, 'screen_capture')
  const captureRouter = componentByKey(systemComponents, 'capture_router')
  const latestCaptured = findLatestCaptured(workItems)
  const onsiteAction = buildOnsiteAction({
    health: health.data,
    latestCaptured,
    reviewReady,
    staleReview,
    dispatchFailed,
    openFieldIssues: openFieldIssues.length,
  })
  const hasLoadError = Boolean(
    work.error || health.error || workerIssues.error || appIssues.error || opsDiagnostics.error,
  )

  return (
    <>
      <MTopBar title="Ops" />
      <MBody>
        <div style={{ padding: '14px 16px 4px' }}>
          <MKpiRow cols={2}>
            <MKpi label="Open work" value={openWork.length} meta={work.isPending ? 'Loading' : 'Active queue'} />
            <MKpi
              label="Review"
              value={reviewReady}
              meta={staleReview > 0 ? `${staleReview} stale` : 'Ready for human'}
              metaTone={staleReview > 0 ? 'amber' : 'green'}
            />
          </MKpiRow>
        </div>

        <MQuickActionGrid>
          <MQuickAction Icon={MI.FileText} label="Work" onClick={() => navigate('/work')} />
          <MQuickAction Icon={MI.Layers} label="Board" onClick={() => navigate('/work/board')} />
          <MQuickAction Icon={MI.Alert} label="Issues" onClick={() => navigate('/issues')} />
          <MQuickAction Icon={MI.AlertTri} label="Field" onClick={() => navigate('/field')} />
        </MQuickActionGrid>

        {hasLoadError ? (
          <div style={{ padding: '0 16px 8px' }}>
            <MBanner tone="error" title="Some ops data did not load" body="Open the linked surface for detail." />
          </div>
        ) : null}

        <MSectionH>Onsite state</MSectionH>
        <MListInset>
          <MListRow
            leading={online ? <MI.Check size={18} /> : <MI.WifiOff size={18} />}
            leadingTone={online ? 'green' : 'amber'}
            headline={online ? 'Phone online' : 'Phone offline'}
            supporting={online ? 'Live API reads are available.' : 'Mutable control needs the network.'}
          />
          <MListRow
            leading={<MI.Clock size={18} />}
            leadingTone={dispatchFailed > 0 ? 'red' : dispatchActive > 0 ? 'amber' : 'green'}
            headline="Agent dispatch"
            supporting={formatDispatchSummary(health.data, dispatchConfigured)}
            onTap={() => navigate('/work')}
            chev
          />
          <MListRow
            leading={<MI.Camera size={18} />}
            leadingTone={
              health.data?.capture.analysis_failed
                ? 'red'
                : health.data?.capture.analysis_pending || health.data?.capture.analysis_missing
                  ? 'amber'
                  : latestCaptured
                    ? 'blue'
                    : 'accent'
            }
            headline="Capture readiness"
            supporting={formatCaptureSummary(health.data, latestCaptured)}
            onTap={latestCaptured ? () => navigate(`/work/${latestCaptured.id}`) : () => navigate('/work')}
            chev
          />
          <MListRow
            leading={<MI.Settings size={18} />}
            headline="Build"
            supporting={buildSha ? buildSha.slice(0, 12) : 'Build SHA appears after the first API response.'}
          />
        </MListInset>

        <MSectionH>Systems</MSectionH>
        <MListInset>
          {canViewAppIssues ? (
            <>
              <MListRow
                leading={<MI.ShieldAlert size={18} />}
                leadingTone={statusTone(opsDiagnostics.data?.status, opsDiagnostics.isPending)}
                headline="Ops diagnostics"
                supporting={formatOpsDiagnosticsSummary(opsDiagnostics.data?.summary, opsDiagnostics.isPending)}
              />
              <SystemRow component={gateway} fallbackLabel="Console Gateway" pending={opsDiagnostics.isPending} />
              <SystemRow component={screenCapture} fallbackLabel="Screen capture" pending={opsDiagnostics.isPending} />
              <SystemRow component={captureRouter} fallbackLabel="Capture router" pending={opsDiagnostics.isPending} />
            </>
          ) : (
            <MListRow
              leading={<MI.ShieldAlert size={18} />}
              leadingTone="accent"
              headline="Ops diagnostics"
              supporting="Platform capability required."
            />
          )}
        </MListInset>

        <MSectionH>Queues</MSectionH>
        <MListInset>
          <MListRow
            leading={<MI.FileText size={18} />}
            leadingTone={openWork.length > 0 ? 'amber' : 'green'}
            headline="Work requests"
            supporting={`${openWork.length} open · ${reviewReady} review-ready`}
            trailing={<QueueCount value={openWork.length} />}
            onTap={() => navigate('/work')}
            chev
          />
          <MListRow
            leading={<MI.AlertTri size={18} />}
            leadingTone={openFieldIssues.length > 0 ? 'amber' : 'green'}
            headline="Field blockers"
            supporting={`${openFieldIssues.length} open worker issue${openFieldIssues.length === 1 ? '' : 's'}`}
            trailing={<QueueCount value={openFieldIssues.length} />}
            onTap={() => navigate('/field')}
            chev
          />
          <MListRow
            leading={<MI.Alert size={18} />}
            leadingTone={canViewAppIssues && appIssueCount > 0 ? 'blue' : 'accent'}
            headline="App issues"
            supporting={
              appIssueCaps.isPending
                ? 'Checking access'
                : canViewAppIssues
                  ? `${appIssueCount} platform issue${appIssueCount === 1 ? '' : 's'}`
                  : 'Platform capability required'
            }
            trailing={canViewAppIssues ? <QueueCount value={appIssueCount} /> : undefined}
            onTap={canViewAppIssues ? () => navigate('/issues') : undefined}
            chev={canViewAppIssues}
          />
        </MListInset>

        <MSectionH>Next actions</MSectionH>
        <MListInset>
          <MListRow
            leading={<onsiteAction.Icon size={18} />}
            leadingTone={onsiteAction.tone}
            headline={onsiteAction.headline}
            supporting={onsiteAction.supporting}
            onTap={() => navigate(onsiteAction.to)}
            chev
          />
          <MListRow
            leading={<MI.Plus size={18} />}
            leadingTone="accent"
            headline="Create or route work"
            supporting="Open the work queue to file a request or dispatch an agent."
            onTap={() => navigate('/work')}
            chev
          />
          {onsiteAction.to !== '/issue' ? (
            <MListRow
              leading={<MI.Mic size={18} />}
              leadingTone="blue"
              headline="Capture field context"
              supporting="Use field issue flow for note, photo, voice, and onsite triage."
              onTap={() => navigate('/issue')}
              chev
            />
          ) : null}
        </MListInset>

        <div style={{ padding: '18px 16px 28px' }}>
          <MButton variant="ghost" onClick={() => navigate('/more')}>
            Back to More
          </MButton>
        </div>
      </MBody>
    </>
  )
}

function countStatus(items: readonly ContextWorkItem[], status: WorkItemStatus): number {
  return items.filter((item) => item.status === status).length
}

function findLatestCaptured(items: readonly ContextWorkItem[]): ContextWorkItem | null {
  const captured = items.filter((item) => item.capture_session_id)
  captured.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  return captured[0] ?? null
}

function formatDispatchSummary(health: WorkRequestQueueHealthResponse | undefined, configured: boolean | null): string {
  if (!health) return 'Health check pending.'
  const active = health.dispatch_outbox.pending + health.dispatch_outbox.processing
  const failed = health.dispatch_outbox.failed + health.dispatch_outbox.dead
  const config = configured === false ? 'config missing' : 'configured'
  const oldest = health.dispatch_outbox.oldest_pending_age_seconds
    ? ` · oldest ${formatAge(health.dispatch_outbox.oldest_pending_age_seconds)}`
    : ''
  return `${config} · ${active} active · ${failed} failed${oldest}`
}

function formatCaptureSummary(
  health: WorkRequestQueueHealthResponse | undefined,
  latestCaptured: ContextWorkItem | null,
): string {
  if (!health) return latestCaptured ? latestCaptured.title : 'Capture health pending.'
  const c = health.capture
  return `${c.captured_work_items} captured · ${c.analysis_ready} ready · ${c.analysis_pending} pending · ${c.analysis_failed} failed · ${c.analysis_missing} missing`
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

function QueueCount({ value }: { value: number }) {
  return <span className="num">{value}</span>
}

function SystemRow({
  component,
  fallbackLabel,
  pending,
}: {
  component: OpsDiagnosticComponent | null
  fallbackLabel: string
  pending: boolean
}) {
  return (
    <MListRow
      leading={<MI.Settings size={18} />}
      leadingTone={statusTone(component?.status, pending)}
      headline={component?.label ?? fallbackLabel}
      supporting={component ? formatSystemComponent(component) : pending ? 'Checking health.' : 'No status reported.'}
    />
  )
}

function isDispatchConfigured(config: { projectkit_dispatch_configured?: boolean; mesh_dispatch_configured: boolean }) {
  return config.projectkit_dispatch_configured ?? config.mesh_dispatch_configured
}

function componentByKey(components: readonly OpsDiagnosticComponent[], key: string): OpsDiagnosticComponent | null {
  return components.find((component) => component.key === key) ?? null
}

function statusTone(
  status: OpsDiagnosticStatus | undefined,
  pending = false,
): 'accent' | 'amber' | 'blue' | 'green' | 'red' {
  if (pending) return 'blue'
  if (status === 'ok') return 'green'
  if (status === 'degraded') return 'amber'
  if (status === 'error') return 'red'
  if (status === 'unavailable' || status === 'unauthorized') return 'amber'
  return 'accent'
}

function formatOpsDiagnosticsSummary(
  summary: { ok: number; total: number; degraded: number; unavailable: number; error: number } | undefined,
  pending: boolean,
): string {
  if (pending) return 'Checking gateway, screen, and capture router.'
  if (!summary) return 'No diagnostics returned.'
  const attention = summary.degraded + summary.unavailable + summary.error
  return `${summary.ok}/${summary.total} green${attention > 0 ? ` · ${attention} need attention` : ''}`
}

function formatSystemComponent(component: OpsDiagnosticComponent): string {
  const latency = typeof component.latency_ms === 'number' ? ` · ${Math.round(component.latency_ms)}ms` : ''
  return `${component.detail}${latency}`
}

type OnsiteActionInput = {
  health: WorkRequestQueueHealthResponse | undefined
  latestCaptured: ContextWorkItem | null
  reviewReady: number
  staleReview: number
  dispatchFailed: number
  openFieldIssues: number
}

function buildOnsiteAction({
  health,
  latestCaptured,
  reviewReady,
  staleReview,
  dispatchFailed,
  openFieldIssues,
}: OnsiteActionInput): {
  Icon: typeof MI.Camera
  tone: 'accent' | 'amber' | 'blue' | 'green' | 'red'
  headline: string
  supporting: string
  to: string
} {
  const capture = health?.capture
  if (capture && (capture.analysis_failed > 0 || capture.analysis_missing > 0)) {
    return {
      Icon: MI.Camera,
      tone: 'red',
      headline: 'Review capture diagnostics',
      supporting: `${capture.analysis_failed} failed · ${capture.analysis_missing} missing analysis`,
      to: latestCaptured ? `/work/${latestCaptured.id}` : '/work',
    }
  }
  if (capture && capture.analysis_pending > 0) {
    return {
      Icon: MI.Clock,
      tone: 'amber',
      headline: 'Watch capture processing',
      supporting: `${capture.analysis_pending} capture analysis job${capture.analysis_pending === 1 ? '' : 's'} pending`,
      to: latestCaptured ? `/work/${latestCaptured.id}` : '/work',
    }
  }
  if (dispatchFailed > 0 || staleReview > 0) {
    return {
      Icon: MI.Alert,
      tone: 'amber',
      headline: 'Clear stalled handoffs',
      supporting: `${dispatchFailed} dispatch failed · ${staleReview} stale review`,
      to: '/work/board',
    }
  }
  if (reviewReady > 0) {
    return {
      Icon: MI.Check,
      tone: 'blue',
      headline: 'Review ready work',
      supporting: `${reviewReady} request${reviewReady === 1 ? '' : 's'} ready for a human decision`,
      to: '/work',
    }
  }
  if (openFieldIssues > 0) {
    return {
      Icon: MI.AlertTri,
      tone: 'amber',
      headline: 'Check field blockers',
      supporting: `${openFieldIssues} open blocker${openFieldIssues === 1 ? '' : 's'} from the field`,
      to: '/field',
    }
  }
  return {
    Icon: MI.Mic,
    tone: 'green',
    headline: 'Capture field context',
    supporting: 'Start with note, photo, voice, or onsite triage.',
    to: '/issue',
  }
}
