import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  controlOpsDiagnosticSession,
  createOpsDiagnosticSession,
  fetchAppIssueBoard,
  fetchOpsDiagnostics,
  fetchOpsDiagnosticSessionActionStatus,
  fetchOpsDiagnosticSessions,
  fetchWorkRequestQueueHealth,
  fetchWorkRequests,
  queryKeys,
  redeemOpsDiagnosticControlTransfer,
  requestOpsDiagnosticSessionAction,
  useAppIssueCapabilities,
  type ContextWorkItem,
  type OpsDiagnosticComponent,
  type OpsDiagnosticStatus,
  type OpsOnsiteDiagnosticAction,
  type OpsOnsiteDiagnosticActionDeliveryState,
  type OpsOnsiteDiagnosticCaptureRouteResult,
  type OpsOnsiteDiagnosticDesktopEvidenceResult,
  type OpsOnsiteDiagnosticAgentFeedDelivery,
  type OpsOnsiteDiagnosticActionKey,
  type OpsOnsiteDiagnosticActionStatusResponse,
  type OpsOnsiteDiagnosticControlAction,
  type OpsOnsiteDiagnosticSessionActionResponse,
  type OpsOnsiteDiagnosticSessionPlan,
  type OpsOnsiteDiagnosticSessionRecord,
  type WorkItemStatus,
  type WorkRequestQueueHealthResponse,
} from '@/lib/api'
import { fetchCaptureArtifactBlob } from '@/lib/api/capture-sessions'
import { ApiError, getBuildSha } from '@/lib/api/client'
import { useActiveCompanyId } from '@/lib/api/active-company'
import { useCreateFeedbackInvite, type CreateFeedbackInviteRequest } from '@/lib/api/feedback-invites'
import { useOnlineStatus } from '@/lib/offline/online-status'
import { canTriageWorkRequests } from '@/lib/work-request-permissions'
import type { CompanyRole } from '@sitelayer/domain'
import {
  clearOpsDiagnosticControl,
  createOpsDiagnosticControlTransferUrl,
  importOpsDiagnosticControlFromUrl,
  persistOpsDiagnosticControl,
  readOpsDiagnosticControl,
} from './ops-diagnostic-control'

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
  const qc = useQueryClient()
  const online = useOnlineStatus()
  const canTriage = canTriageWorkRequests(companyRole)
  const companyId = useActiveCompanyId()
  const buildSha = getBuildSha()
  const [activeDiagnosticSession, setActiveDiagnosticSession] = useState<OpsOnsiteDiagnosticSessionRecord | null>(null)
  const [diagnosticControlToken, setDiagnosticControlToken] = useState<string | null>(null)
  const [lastDiagnosticAction, setLastDiagnosticAction] = useState<OpsOnsiteDiagnosticSessionActionResponse | null>(
    null,
  )
  const [diagnosticControlTransferUrl, setDiagnosticControlTransferUrl] = useState<string | null>(null)
  const [diagnosticControlTransferCopied, setDiagnosticControlTransferCopied] = useState(false)
  const [leaveBehindCaptureLink, setLeaveBehindCaptureLink] = useState<LeaveBehindCaptureLinkState | null>(null)
  const [leaveBehindCaptureCopied, setLeaveBehindCaptureCopied] = useState(false)

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
  const canCaptureAppIssues = Boolean(appIssueCaps.data?.includes('app_issue.capture'))
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
  const diagnosticSessions = useQuery({
    queryKey: ['ops-diagnostic-sessions', companySlug],
    queryFn: () => fetchOpsDiagnosticSessions(companySlug),
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
  const linkedWorkerIssueId = openFieldIssues[0]?.id
  const appIssueCount = appIssues.data?.issues.length ?? 0
  const systemComponents = opsDiagnostics.data?.components ?? []
  const gateway = componentByKey(systemComponents, 'gateway')
  const screenCapture = componentByKey(systemComponents, 'screen_capture')
  const captureRouter = componentByKey(systemComponents, 'capture_router')
  const agentFeed = componentByKey(systemComponents, 'agent_feed')
  const onsiteSession = opsDiagnostics.data?.onsite_session
  const observedDiagnosticSession = diagnosticSessions.data?.sessions[0] ?? null
  const displayedDiagnosticSession = activeDiagnosticSession ?? observedDiagnosticSession
  const displayedDiagnosticSessionId = displayedDiagnosticSession?.id ?? null
  const hasDiagnosticControl = Boolean(activeDiagnosticSession && diagnosticControlToken)
  const diagnosticActionStatusLookup = useMemo(
    () => latestDiagnosticActionStatusLookup(displayedDiagnosticSession),
    [displayedDiagnosticSession],
  )
  const diagnosticActionStatus = useQuery({
    queryKey: [
      'ops-diagnostic-action-status',
      companySlug,
      diagnosticActionStatusLookup?.sessionId,
      diagnosticActionStatusLookup?.actionKey,
      diagnosticActionStatusLookup?.clientActionId,
    ],
    queryFn: () =>
      fetchOpsDiagnosticSessionActionStatus(
        diagnosticActionStatusLookup!.sessionId,
        {
          action_key: diagnosticActionStatusLookup!.actionKey,
          client_action_id: diagnosticActionStatusLookup!.clientActionId,
        },
        companySlug,
      ),
    enabled: canViewAppIssues && Boolean(diagnosticActionStatusLookup),
    refetchInterval: (query) => {
      const state = query.state.data?.action_status.state
      return state === 'accepted' || state === 'retrying' || !state ? 5_000 : false
    },
  })
  useEffect(() => {
    setActiveDiagnosticSession(null)
    setDiagnosticControlToken(null)
    setLastDiagnosticAction(null)
    setDiagnosticControlTransferUrl(null)
    setDiagnosticControlTransferCopied(false)
    setLeaveBehindCaptureLink(null)
    setLeaveBehindCaptureCopied(false)
  }, [companySlug])
  useEffect(() => {
    setLeaveBehindCaptureLink(null)
    setLeaveBehindCaptureCopied(false)
  }, [displayedDiagnosticSessionId])
  useEffect(() => {
    if (!canCaptureAppIssues) return
    const importedControl = importOpsDiagnosticControlFromUrl(companySlug)
    if (!importedControl) return
    let cancelled = false
    redeemOpsDiagnosticControlTransfer(
      importedControl.session_id,
      { transfer_token: importedControl.transfer_token },
      companySlug,
    )
      .then((response) => {
        if (cancelled || !response.control.control_token) return
        setActiveDiagnosticSession(response.session)
        setDiagnosticControlToken(response.control.control_token)
        persistOpsDiagnosticControl(companySlug, response.session, response.control.control_token)
        setDiagnosticControlTransferUrl(null)
        setDiagnosticControlTransferCopied(false)
        void qc.invalidateQueries({ queryKey: ['ops-diagnostic-sessions', companySlug] })
        void qc.invalidateQueries({ queryKey: ['ops-diagnostics', companySlug] })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [canCaptureAppIssues, companySlug, qc])
  useEffect(() => {
    if (!canCaptureAppIssues) return
    const storedControl = readOpsDiagnosticControl(companySlug)
    if (!storedControl) return
    if (!diagnosticSessions.data) return
    const restoredSession = (diagnosticSessions.data?.sessions ?? []).find(
      (session) => session.id === storedControl.session_id,
    )
    if (!restoredSession) {
      clearOpsDiagnosticControl(companySlug)
      setActiveDiagnosticSession(null)
      setDiagnosticControlToken(null)
      return
    }
    setActiveDiagnosticSession(restoredSession)
    setDiagnosticControlToken(storedControl.control_token)
  }, [canCaptureAppIssues, companySlug, diagnosticSessions.data?.sessions])
  const startDiagnosticSession = useMutation({
    mutationFn: () => {
      const input = {
        label: 'Mobile ops',
        ...(onsiteSession?.recommended_entry ? { intent: onsiteSession.recommended_entry } : {}),
        ...(linkedWorkerIssueId ? { worker_issue_id: linkedWorkerIssueId } : {}),
      }
      return createOpsDiagnosticSession(companySlug, input)
    },
    onSuccess: (response) => {
      setActiveDiagnosticSession(response.session)
      setDiagnosticControlToken(response.control_token)
      setLastDiagnosticAction(null)
      persistOpsDiagnosticControl(companySlug, response.session, response.control_token)
      void qc.invalidateQueries({ queryKey: ['ops-diagnostics', companySlug] })
      void qc.invalidateQueries({ queryKey: ['ops-diagnostic-sessions', companySlug] })
    },
  })
  const requestDiagnosticAction = useMutation({
    mutationFn: (request: { actionKey: OpsOnsiteDiagnosticActionKey; clientActionId: string }) => {
      if (!activeDiagnosticSession || !diagnosticControlToken) {
        return Promise.reject(new Error('diagnostic session is not active'))
      }
      return requestOpsDiagnosticSessionAction(
        activeDiagnosticSession.id,
        {
          action_key: request.actionKey,
          client_action_id: request.clientActionId,
          control_token: diagnosticControlToken,
        },
        companySlug,
      )
    },
    onSuccess: (response) => {
      setActiveDiagnosticSession(response.session)
      setLastDiagnosticAction(response)
      if (diagnosticControlToken) persistOpsDiagnosticControl(companySlug, response.session, diagnosticControlToken)
      void qc.invalidateQueries({ queryKey: ['ops-diagnostic-sessions', companySlug] })
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 403) {
        clearOpsDiagnosticControl(companySlug)
        setActiveDiagnosticSession(null)
        setDiagnosticControlToken(null)
      }
    },
  })
  const controlDiagnosticSession = useMutation({
    mutationFn: (action: Exclude<OpsOnsiteDiagnosticControlAction, 'redeem'>) => {
      if (!activeDiagnosticSession || !diagnosticControlToken) {
        return Promise.reject(new Error('diagnostic session is not active'))
      }
      return controlOpsDiagnosticSession(
        activeDiagnosticSession.id,
        { action, control_token: diagnosticControlToken },
        companySlug,
      )
    },
    onSuccess: async (response, action) => {
      setLastDiagnosticAction(null)
      if (action === 'cancel' || action === 'revoke') {
        clearOpsDiagnosticControl(companySlug)
        setActiveDiagnosticSession(null)
        setDiagnosticControlToken(null)
        setDiagnosticControlTransferUrl(null)
        setDiagnosticControlTransferCopied(false)
      } else {
        const nextControlToken = response.control.control_token ?? diagnosticControlToken
        setActiveDiagnosticSession(response.session)
        if (nextControlToken) {
          setDiagnosticControlToken(nextControlToken)
          persistOpsDiagnosticControl(companySlug, response.session, nextControlToken)
        }
        if (action === 'transfer' && response.control.transfer_token) {
          const transferUrl = createOpsDiagnosticControlTransferUrl(
            companySlug,
            response.session,
            response.control.transfer_token,
          )
          setDiagnosticControlTransferUrl(transferUrl)
          setDiagnosticControlTransferCopied(false)
          if (transferUrl) {
            const shareResult = await shareOrCopyMobileLink(transferUrl, 'Sitelayer onsite control handoff')
            setDiagnosticControlTransferCopied(shareResult !== 'manual')
          }
        } else {
          setDiagnosticControlTransferUrl(null)
          setDiagnosticControlTransferCopied(false)
        }
      }
      void qc.invalidateQueries({ queryKey: ['ops-diagnostic-sessions', companySlug] })
      void qc.invalidateQueries({ queryKey: ['ops-diagnostics', companySlug] })
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 403) {
        clearOpsDiagnosticControl(companySlug)
        setActiveDiagnosticSession(null)
        setDiagnosticControlToken(null)
      }
    },
  })
  const copyDiagnosticControlTransferLink = async () => {
    if (!diagnosticControlTransferUrl) return
    const shareResult = await shareOrCopyMobileLink(diagnosticControlTransferUrl, 'Sitelayer onsite control handoff')
    setDiagnosticControlTransferCopied(shareResult !== 'manual')
  }
  const createLeaveBehindCaptureInvite = useCreateFeedbackInvite(companyId ?? '')
  const reusableLeaveBehindCaptureLinkUrl = reusableLeaveBehindCaptureUrl(
    leaveBehindCaptureLink,
    displayedDiagnosticSession,
  )
  const copyLeaveBehindCaptureInvite = useMutation({
    mutationFn: async () => {
      if (!companyId) throw new Error('company is not loaded')
      const sessionId = displayedDiagnosticSession?.id ?? null
      const inviteUrl =
        reusableLeaveBehindCaptureLinkUrl ??
        (
          await createLeaveBehindCaptureInvite.mutateAsync(
            buildLeaveBehindCaptureInviteInput({ companySlug, session: displayedDiagnosticSession }),
          )
        ).invite_url
      setLeaveBehindCaptureLink({ url: inviteUrl, session_id: sessionId })
      setLeaveBehindCaptureCopied(false)
      const shareResult = await shareOrCopyMobileLink(inviteUrl, 'Sitelayer leave-behind capture link')
      return { inviteUrl, sessionId, shareResult }
    },
    onSuccess: ({ inviteUrl, sessionId, shareResult }) => {
      setLeaveBehindCaptureLink({ url: inviteUrl, session_id: sessionId })
      setLeaveBehindCaptureCopied(shareResult !== 'manual')
    },
  })
  const openDesktopEvidence = useMutation({
    mutationFn: async (evidence: OpsOnsiteDiagnosticDesktopEvidenceResult) => {
      if (!evidence.capture_session_id || !evidence.artifact_id) {
        throw new Error('desktop evidence artifact is not available')
      }
      const blob = await fetchCaptureArtifactBlob(evidence.capture_session_id, evidence.artifact_id)
      return URL.createObjectURL(blob)
    },
    onSuccess: (objectUrl) => {
      window.open(objectUrl, '_blank', 'noopener,noreferrer')
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
    },
  })
  const latestCaptured = findLatestCaptured(workItems)
  const onsiteAction = buildOnsiteAction({
    onsiteSession,
    health: health.data,
    latestCaptured,
    reviewReady,
    staleReview,
    dispatchFailed,
    openFieldIssues: openFieldIssues.length,
  })
  const hasLoadError = Boolean(
    work.error ||
    health.error ||
    workerIssues.error ||
    appIssues.error ||
    opsDiagnostics.error ||
    diagnosticSessions.error ||
    startDiagnosticSession.error ||
    requestDiagnosticAction.error,
  )
  const diagnosticActions = visibleDiagnosticActions(activeDiagnosticSession, hasDiagnosticControl)
  const latestAgentFeedDelivery = latestDiagnosticDelivery(displayedDiagnosticSession)
  const latestDesktopEvidence = resolveLatestDesktopEvidence(lastDiagnosticAction, displayedDiagnosticSession)
  const latestDiagnosticManifest =
    lastDiagnosticAction?.session.diagnostic_manifest ?? displayedDiagnosticSession?.diagnostic_manifest ?? null
  const linkedAppIssueId =
    latestDiagnosticManifest?.context_work_item_id ?? displayedDiagnosticSession?.context_work_item_id ?? null
  const linkedSupportPacketId =
    latestDiagnosticManifest?.support_packet_id ?? displayedDiagnosticSession?.support_packet_id ?? null
  const latestCaptureRoute = lastDiagnosticAction?.accepted_action.capture_route ?? null
  const latestCaptureRouteAction = lastDiagnosticAction?.accepted_action.key ?? null
  const latestActionStatus = diagnosticActionStatus.data?.action_status ?? null
  const canCreateLeaveBehindCapture = companyRole === 'admin' && Boolean(companyId)
  const fieldReadinessItems = buildFieldReadinessItems({
    online,
    hasDiagnosticControl,
    displayedDiagnosticSession,
    screenCapture,
    captureRouter,
    agentFeed,
    onsiteSession,
  })

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
          {canViewAppIssues ? (
            <MListRow
              leading={
                onsiteSession?.status === 'ready' ? (
                  <MI.Check size={18} />
                ) : onsiteSession?.status === 'blocked' ? (
                  <MI.ShieldAlert size={18} />
                ) : (
                  <MI.Clock size={18} />
                )
              }
              leadingTone={onsiteSessionTone(onsiteSession, opsDiagnostics.isPending)}
              headline="Diagnostic readiness"
              supporting={formatOnsiteSessionSummary(onsiteSession, opsDiagnostics.isPending)}
              onTap={onsiteSession ? () => navigate(onsiteSessionRoute(onsiteSession)) : undefined}
              chev={Boolean(onsiteSession)}
            />
          ) : null}
          {canCaptureAppIssues ? (
            <MListRow
              leading={
                displayedDiagnosticSession && hasDiagnosticControl ? (
                  <MI.Check size={18} />
                ) : displayedDiagnosticSession ? (
                  <MI.Clock size={18} />
                ) : startDiagnosticSession.isPending ? (
                  <MI.Clock size={18} />
                ) : (
                  <MI.Camera size={18} />
                )
              }
              leadingTone={diagnosticSessionTone(
                displayedDiagnosticSession,
                startDiagnosticSession.isPending,
                requestDiagnosticAction.isPending,
                hasDiagnosticControl,
              )}
              headline={formatDiagnosticSessionHeadline(displayedDiagnosticSession, hasDiagnosticControl)}
              supporting={formatDiagnosticSessionControl(
                displayedDiagnosticSession,
                startDiagnosticSession.isPending,
                requestDiagnosticAction.isPending,
                hasDiagnosticControl,
              )}
              onTap={
                hasDiagnosticControl && activeDiagnosticSession
                  ? () => navigate(onsiteSessionRoute(activeDiagnosticSession.plan))
                  : displayedDiagnosticSession
                    ? () => navigate(onsiteSessionRoute(displayedDiagnosticSession.plan))
                    : startDiagnosticSession.isPending
                      ? undefined
                      : () => startDiagnosticSession.mutate()
              }
              chev={Boolean(displayedDiagnosticSession)}
            />
          ) : null}
          {latestAgentFeedDelivery ? (
            <MListRow
              leading={<MI.Clock size={18} />}
              leadingTone={agentFeedDeliveryTone(latestAgentFeedDelivery)}
              headline={formatAgentFeedDeliveryHeadline(latestAgentFeedDelivery)}
              supporting={formatAgentFeedDeliverySummary(latestAgentFeedDelivery)}
            />
          ) : null}
          {latestActionStatus || diagnosticActionStatus.isFetching ? (
            <MListRow
              leading={<MI.Clock size={18} />}
              leadingTone={actionStatusTone(latestActionStatus?.state, diagnosticActionStatus.isFetching)}
              headline={formatActionStatusHeadline(latestActionStatus)}
              supporting={formatActionStatusSummary(latestActionStatus, diagnosticActionStatus.isFetching)}
            />
          ) : null}
          {linkedAppIssueId ? (
            <MListRow
              leading={<MI.Alert size={18} />}
              leadingTone="blue"
              headline="Linked app issue"
              supporting={
                linkedSupportPacketId
                  ? `Support packet ${linkedSupportPacketId.slice(0, 8)} is attached.`
                  : 'Open the routed board item.'
              }
              onTap={() => navigate(`/issues/${linkedAppIssueId}`)}
              chev
            />
          ) : null}
          {latestDesktopEvidence ? (
            <MListRow
              leading={<MI.Camera size={18} />}
              leadingTone={
                openDesktopEvidence.isError
                  ? 'red'
                  : openDesktopEvidence.isPending
                    ? 'blue'
                    : desktopEvidenceTone(latestDesktopEvidence)
              }
              headline={openDesktopEvidence.isPending ? 'Opening desktop clip' : 'Desktop evidence'}
              supporting={
                openDesktopEvidence.isError
                  ? 'Clip could not open from this device.'
                  : formatDesktopEvidenceSummary(latestDesktopEvidence)
              }
              onTap={
                canOpenDesktopEvidence(latestDesktopEvidence) && !openDesktopEvidence.isPending
                  ? () => openDesktopEvidence.mutate(latestDesktopEvidence)
                  : undefined
              }
              chev={canOpenDesktopEvidence(latestDesktopEvidence)}
            />
          ) : null}
          {latestCaptureRoute && latestCaptureRouteAction ? (
            <MListRow
              leading={<MI.Layers size={18} />}
              leadingTone={captureRouteTone(latestCaptureRoute)}
              headline={formatCaptureRouteHeadline(latestCaptureRouteAction)}
              supporting={formatCaptureRouteSummary(latestCaptureRoute)}
            />
          ) : null}
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

        {canViewAppIssues ? (
          <>
            <MSectionH>Field checklist</MSectionH>
            <MListInset>
              {fieldReadinessItems.map((item) => {
                const Icon = item.Icon
                return (
                  <MListRow
                    key={item.key}
                    leading={<Icon size={18} />}
                    leadingTone={item.tone}
                    headline={item.headline}
                    supporting={item.supporting}
                  />
                )
              })}
            </MListInset>
          </>
        ) : null}

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
              <SystemRow component={agentFeed} fallbackLabel="Agent feed" pending={opsDiagnostics.isPending} />
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
          {diagnosticActions.map((action) => {
            const Icon = diagnosticActionIcon(action.key)
            return (
              <MListRow
                key={action.key}
                leading={<Icon size={18} />}
                leadingTone={requestDiagnosticAction.isPending ? 'blue' : action.enabled ? 'blue' : 'amber'}
                headline={requestDiagnosticAction.isPending ? 'Recording action' : `Record ${lowerFirst(action.label)}`}
                supporting={formatDiagnosticActionSummary(action, requestDiagnosticAction.isPending)}
                onTap={
                  action.enabled &&
                  diagnosticControlToken &&
                  !requestDiagnosticAction.isPending &&
                  activeDiagnosticSession
                    ? () =>
                        requestDiagnosticAction.mutate({
                          actionKey: action.key,
                          clientActionId: diagnosticClientActionId(activeDiagnosticSession.id, action.key),
                        })
                    : undefined
                }
              />
            )
          })}
          {hasDiagnosticControl && activeDiagnosticSession ? (
            <MListRow
              leading={<MI.Clock size={18} />}
              leadingTone={controlDiagnosticSession.isPending ? 'blue' : 'green'}
              headline={controlDiagnosticSession.isPending ? 'Updating control window' : 'Extend control window'}
              supporting={`Keep phone control until ${formatClock(activeDiagnosticSession.expires_at)} or extend another hour.`}
              onTap={controlDiagnosticSession.isPending ? undefined : () => controlDiagnosticSession.mutate('extend')}
            />
          ) : null}
          {hasDiagnosticControl && activeDiagnosticSession ? (
            <MListRow
              leading={<MI.Users size={18} />}
              leadingTone={
                controlDiagnosticSession.isPending
                  ? 'blue'
                  : diagnosticControlTransferCopied
                    ? 'green'
                    : diagnosticControlTransferUrl
                      ? 'amber'
                      : 'accent'
              }
              headline={
                controlDiagnosticSession.isPending
                  ? 'Preparing handoff'
                  : diagnosticControlTransferCopied
                    ? 'Control handoff ready'
                    : diagnosticControlTransferUrl
                      ? 'Share control handoff'
                      : 'Create control handoff'
              }
              supporting={
                diagnosticControlTransferUrl ? (
                  <ManualLinkSupporting
                    message={
                      diagnosticControlTransferCopied
                        ? 'Link shared or copied. Open it on another phone to import control.'
                        : 'Use this short-lived link on another phone to import control.'
                    }
                    url={diagnosticControlTransferUrl}
                  />
                ) : (
                  'Rotate the token and create a short-lived handoff link.'
                )
              }
              onTap={
                controlDiagnosticSession.isPending
                  ? undefined
                  : diagnosticControlTransferUrl
                    ? copyDiagnosticControlTransferLink
                    : () => controlDiagnosticSession.mutate('transfer')
              }
            />
          ) : null}
          {hasDiagnosticControl && activeDiagnosticSession ? (
            <MListRow
              leading={<MI.X size={18} />}
              leadingTone={controlDiagnosticSession.isPending ? 'blue' : 'amber'}
              headline={controlDiagnosticSession.isPending ? 'Updating control token' : 'Revoke this phone'}
              supporting="Invalidate this phone's token while leaving the diagnostic session visible."
              onTap={controlDiagnosticSession.isPending ? undefined : () => controlDiagnosticSession.mutate('revoke')}
            />
          ) : null}
          {hasDiagnosticControl && activeDiagnosticSession ? (
            <MListRow
              leading={<MI.ShieldAlert size={18} />}
              leadingTone={controlDiagnosticSession.isPending ? 'blue' : 'amber'}
              headline={controlDiagnosticSession.isPending ? 'Updating control window' : 'End phone control'}
              supporting="Close this diagnostic window and clear the control token on this phone."
              onTap={controlDiagnosticSession.isPending ? undefined : () => controlDiagnosticSession.mutate('cancel')}
            />
          ) : null}
          <MListRow
            leading={<onsiteAction.Icon size={18} />}
            leadingTone={onsiteAction.tone}
            headline={onsiteAction.headline}
            supporting={onsiteAction.supporting}
            onTap={() => navigate(onsiteAction.to)}
            chev
          />
          {canCreateLeaveBehindCapture ? (
            <MListRow
              leading={
                copyLeaveBehindCaptureInvite.isPending || createLeaveBehindCaptureInvite.isPending ? (
                  <MI.Clock size={18} />
                ) : leaveBehindCaptureCopied ? (
                  <MI.Check size={18} />
                ) : (
                  <MI.Users size={18} />
                )
              }
              leadingTone={
                copyLeaveBehindCaptureInvite.isError || createLeaveBehindCaptureInvite.isError
                  ? 'red'
                  : copyLeaveBehindCaptureInvite.isPending || createLeaveBehindCaptureInvite.isPending
                    ? 'blue'
                    : leaveBehindCaptureCopied
                      ? 'green'
                      : 'accent'
              }
              headline={leaveBehindCaptureCopied ? 'Leave-behind link ready' : 'Share leave-behind capture link'}
              supporting={
                reusableLeaveBehindCaptureLinkUrl ? (
                  <ManualLinkSupporting
                    message={formatLeaveBehindCaptureSummary({
                      pending: copyLeaveBehindCaptureInvite.isPending || createLeaveBehindCaptureInvite.isPending,
                      copied: leaveBehindCaptureCopied,
                      error: copyLeaveBehindCaptureInvite.error ?? createLeaveBehindCaptureInvite.error,
                      hasSession: Boolean(displayedDiagnosticSession),
                    })}
                    url={reusableLeaveBehindCaptureLinkUrl}
                  />
                ) : (
                  formatLeaveBehindCaptureSummary({
                    pending: copyLeaveBehindCaptureInvite.isPending || createLeaveBehindCaptureInvite.isPending,
                    copied: leaveBehindCaptureCopied,
                    error: copyLeaveBehindCaptureInvite.error ?? createLeaveBehindCaptureInvite.error,
                    hasSession: Boolean(displayedDiagnosticSession),
                  })
                )
              }
              onTap={
                copyLeaveBehindCaptureInvite.isPending || createLeaveBehindCaptureInvite.isPending
                  ? undefined
                  : () => copyLeaveBehindCaptureInvite.mutate()
              }
            />
          ) : null}
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

type MobileTone = 'accent' | 'amber' | 'blue' | 'green' | 'red'

type FieldReadinessItem = {
  key: string
  Icon: typeof MI.Camera
  tone: MobileTone
  headline: string
  supporting: string
}

type FieldReadinessInput = {
  online: boolean
  hasDiagnosticControl: boolean
  displayedDiagnosticSession: OpsOnsiteDiagnosticSessionRecord | null
  screenCapture: OpsDiagnosticComponent | null
  captureRouter: OpsDiagnosticComponent | null
  agentFeed: OpsDiagnosticComponent | null
  onsiteSession: OpsOnsiteDiagnosticSessionPlan | undefined
}

export type LeaveBehindCaptureLinkState = {
  url: string
  session_id: string | null
}

export type MobileLinkShareResult = 'shared' | 'copied' | 'manual'

export type MobileLinkShareDeps = {
  share?: ((data: ShareData) => Promise<void>) | undefined
  clipboard?: { writeText?: ((text: string) => Promise<void>) | undefined } | undefined
}

export function buildFieldReadinessItems({
  online,
  hasDiagnosticControl,
  displayedDiagnosticSession,
  screenCapture,
  captureRouter,
  agentFeed,
  onsiteSession,
}: FieldReadinessInput): FieldReadinessItem[] {
  const screenReady = screenCapture?.status === 'ok' && screenCapture.facts.recording === true
  const routeSinks =
    typeof captureRouter?.facts.sinks === 'string' ? captureRouter.facts.sinks.split(',').filter(Boolean) : []
  const routerReady = captureRouter?.status === 'ok' && routeSinks.length > 0
  const agentFeedReady = agentFeed?.status === 'ok' && agentFeed.facts.audience_live === true
  const canRouteWork = onsiteSession?.can_route_work === true
  const canDispatchAgentReview = onsiteSession?.can_dispatch_agent_review === true

  return [
    {
      key: 'phone-link',
      Icon: online ? MI.Check : MI.WifiOff,
      tone: online ? 'green' : 'amber',
      headline: 'Phone link',
      supporting: online ? 'Network available.' : 'No network for mutable actions.',
    },
    {
      key: 'control-window',
      Icon: hasDiagnosticControl ? MI.Check : displayedDiagnosticSession ? MI.Clock : MI.Camera,
      tone: hasDiagnosticControl ? 'green' : displayedDiagnosticSession ? 'amber' : 'accent',
      headline: 'Control window',
      supporting: hasDiagnosticControl
        ? `Token held until ${formatClock(displayedDiagnosticSession?.expires_at ?? '')}.`
        : displayedDiagnosticSession
          ? 'Session visible; control token not held.'
          : 'No active control window.',
    },
    {
      key: 'desktop-video',
      Icon: screenReady ? MI.Check : MI.Camera,
      tone: screenReady ? 'green' : statusTone(screenCapture?.status),
      headline: 'Desktop video',
      supporting: screenReady ? 'Recording confirmed.' : (screenCapture?.detail ?? 'Screen capture pending.'),
    },
    {
      key: 'capture-route',
      Icon: routerReady ? MI.Check : MI.Layers,
      tone: routerReady ? 'green' : statusTone(captureRouter?.status),
      headline: 'Capture route',
      supporting: routerReady
        ? `${routeSinks.length} sink${routeSinks.length === 1 ? '' : 's'} active.`
        : (captureRouter?.detail ?? 'Capture router pending.'),
    },
    {
      key: 'agent-lane',
      Icon: canDispatchAgentReview || canRouteWork ? MI.Check : MI.ShieldAlert,
      tone: canDispatchAgentReview
        ? 'green'
        : canRouteWork
          ? 'blue'
          : agentFeedReady
            ? 'amber'
            : statusTone(agentFeed?.status),
      headline: 'Agent lane',
      supporting: canDispatchAgentReview
        ? 'Agent review ready.'
        : canRouteWork
          ? 'Support packet route ready.'
          : agentFeedReady
            ? 'Agent feed ready; route still blocked.'
            : (agentFeed?.detail ?? 'Agent feed pending.'),
    },
  ]
}

export async function shareOrCopyMobileLink(
  url: string,
  title: string,
  deps: MobileLinkShareDeps = browserMobileLinkShareDeps(),
): Promise<MobileLinkShareResult> {
  if (deps.share) {
    try {
      await deps.share({ title, url })
      return 'shared'
    } catch {
      /* Fall back to clipboard/manual link display. */
    }
  }
  if (deps.clipboard?.writeText) {
    try {
      await deps.clipboard.writeText(url)
      return 'copied'
    } catch {
      return 'manual'
    }
  }
  return 'manual'
}

function browserMobileLinkShareDeps(): MobileLinkShareDeps {
  if (typeof navigator === 'undefined') return {}
  return {
    share: typeof navigator.share === 'function' ? navigator.share.bind(navigator) : undefined,
    clipboard: navigator.clipboard,
  }
}

export function visibleDiagnosticActions(
  session: OpsOnsiteDiagnosticSessionRecord | null,
  hasControl: boolean,
): OpsOnsiteDiagnosticAction[] {
  return hasControl && session ? session.plan.actions : []
}

export function reusableLeaveBehindCaptureUrl(
  link: LeaveBehindCaptureLinkState | null,
  session: OpsOnsiteDiagnosticSessionRecord | null,
): string | null {
  if (!link) return null
  return link.session_id === (session?.id ?? null) ? link.url : null
}

export function buildLeaveBehindCaptureInviteInput({
  companySlug,
  session,
}: {
  companySlug: string
  session: OpsOnsiteDiagnosticSessionRecord | null
}): CreateFeedbackInviteRequest {
  return {
    reviewer_ref: 'onsite-worker',
    source: 'mobile_ops_leavebehind',
    target_route: '/ops',
    expires_in_days: 7,
    allowed_capture_modes: ['text', 'audio', 'state', 'screen'],
    metadata: {
      created_from: 'mobile_ops',
      company_slug: companySlug,
      ops_diagnostic_session_id: session?.id ?? null,
      ops_diagnostic_control_level: session?.plan.control_level ?? null,
      ops_diagnostic_state: session?.state ?? null,
    },
  }
}

function formatLeaveBehindCaptureSummary({
  pending,
  copied,
  error,
  hasSession,
}: {
  pending: boolean
  copied: boolean
  error: unknown
  hasSession: boolean
}): string {
  if (pending) return 'Creating a signed guest capture link.'
  if (error) return error instanceof Error ? error.message : 'Could not create the link.'
  if (copied) return hasSession ? 'Guest capture is tied to this onsite session.' : 'Guest capture is tied to Ops.'
  return hasSession ? 'Guest can send text, audio, state, or screen evidence.' : 'Works without starting control.'
}

function ManualLinkSupporting({ message, url }: { message: string; url: string }) {
  return (
    <span>
      {message}
      <br />
      <span style={{ wordBreak: 'break-all', fontFamily: 'var(--m-num)' }}>{url}</span>
    </span>
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
  if (pending) return 'Checking gateway, screen, capture router, and agent feed.'
  if (!summary) return 'No diagnostics returned.'
  const attention = summary.degraded + summary.unavailable + summary.error
  return `${summary.ok}/${summary.total} green${attention > 0 ? ` · ${attention} need attention` : ''}`
}

function formatSystemComponent(component: OpsDiagnosticComponent): string {
  const latency = typeof component.latency_ms === 'number' ? ` · ${Math.round(component.latency_ms)}ms` : ''
  return `${component.detail}${latency}`
}

type OnsiteActionInput = {
  onsiteSession: OpsOnsiteDiagnosticSessionPlan | undefined
  health: WorkRequestQueueHealthResponse | undefined
  latestCaptured: ContextWorkItem | null
  reviewReady: number
  staleReview: number
  dispatchFailed: number
  openFieldIssues: number
}

function buildOnsiteAction({
  onsiteSession,
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
  if (onsiteSession?.status === 'blocked') {
    return {
      Icon: MI.ShieldAlert,
      tone: 'amber',
      headline: 'Fix onsite diagnostics',
      supporting: `${onsiteSession.blockers.length} blocker${onsiteSession.blockers.length === 1 ? '' : 's'} before routed diagnostics`,
      to: '/issues',
    }
  }
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

function onsiteSessionTone(
  plan: OpsOnsiteDiagnosticSessionPlan | undefined,
  pending: boolean,
): 'accent' | 'amber' | 'blue' | 'green' | 'red' {
  if (pending) return 'blue'
  if (plan?.status === 'ready') return 'green'
  if (plan?.status === 'limited') return 'amber'
  if (plan?.status === 'blocked') return 'red'
  return 'accent'
}

function formatOnsiteSessionSummary(plan: OpsOnsiteDiagnosticSessionPlan | undefined, pending: boolean): string {
  if (pending) return 'Checking capture, routing, and agent review.'
  if (!plan) return 'No session plan reported.'
  const enabled = plan.actions.filter((action) => action.enabled).length
  const blockers = plan.blockers.length
  const level =
    plan.control_level === 'route'
      ? 'Routing ready'
      : plan.control_level === 'capture'
        ? 'Capture only'
        : 'Observe only'
  return `${level} · ${enabled}/${plan.actions.length} actions ready${blockers > 0 ? ` · ${blockers} blocker${blockers === 1 ? '' : 's'}` : ''}`
}

function diagnosticSessionTone(
  session: OpsOnsiteDiagnosticSessionRecord | null,
  pending: boolean,
  actionPending: boolean,
  hasControlToken: boolean,
): 'accent' | 'amber' | 'blue' | 'green' | 'red' {
  if (pending || actionPending) return 'blue'
  if (!session) return 'accent'
  return hasControlToken ? 'green' : 'amber'
}

function formatDiagnosticSessionHeadline(
  session: OpsOnsiteDiagnosticSessionRecord | null,
  hasControlToken: boolean,
): string {
  if (!session) return 'Start onsite session'
  return hasControlToken ? 'Onsite session active' : 'Onsite session observed'
}

function formatDiagnosticSessionControl(
  session: OpsOnsiteDiagnosticSessionRecord | null,
  pending: boolean,
  actionPending: boolean,
  hasControlToken: boolean,
): string {
  if (pending) return 'Starting a 60m diagnostic window.'
  if (actionPending) return 'Recording the requested action.'
  if (!session) return 'No active diagnostic window.'
  if (!hasControlToken) return `Started ${formatClock(session.created_at)} · tap to start a new control window.`
  return `Expires ${formatClock(session.expires_at)} · ${session.audit_events.length} event${session.audit_events.length === 1 ? '' : 's'}`
}

function formatDiagnosticActionSummary(action: OpsOnsiteDiagnosticAction, pending: boolean): string {
  if (pending) return 'Audit event pending.'
  return action.reason
}

export function desktopEvidenceTone(
  evidence: OpsOnsiteDiagnosticDesktopEvidenceResult,
): 'amber' | 'blue' | 'green' | 'red' {
  if (evidence.status === 'attached') return 'green'
  if (evidence.status === 'not_configured') return 'amber'
  return 'red'
}

export function formatDesktopEvidenceSummary(evidence: OpsOnsiteDiagnosticDesktopEvidenceResult): string {
  if (evidence.status === 'attached') {
    const prefix = evidence.byte_size ? `Attached ${formatBytes(evidence.byte_size)} clip.` : 'Attached desktop clip.'
    return canOpenDesktopEvidence(evidence) ? `${prefix} Tap to open.` : prefix
  }
  if (evidence.status === 'not_configured') return 'Desktop evidence storage is not configured.'
  return evidence.error ? `Attach failed: ${evidence.error}` : 'Desktop evidence did not attach.'
}

export function canOpenDesktopEvidence(evidence: OpsOnsiteDiagnosticDesktopEvidenceResult): boolean {
  return Boolean(
    evidence.capture_session_id && evidence.artifact_id && evidence.file_path && evidence.status === 'attached',
  )
}

export function resolveLatestDesktopEvidence(
  action: OpsOnsiteDiagnosticSessionActionResponse | null,
  session: OpsOnsiteDiagnosticSessionRecord | null,
): OpsOnsiteDiagnosticDesktopEvidenceResult | null {
  return action?.accepted_action.desktop_evidence ?? session?.desktop_evidence ?? null
}

function captureRouteTone(route: OpsOnsiteDiagnosticCaptureRouteResult): 'amber' | 'blue' | 'green' | 'red' {
  if (route.status === 'accepted') return 'green'
  if (route.status === 'not_configured') return 'amber'
  return 'red'
}

function formatCaptureRouteHeadline(actionKey: OpsOnsiteDiagnosticActionKey): string {
  return `${diagnosticActionName(actionKey)} route`
}

function formatCaptureRouteSummary(route: OpsOnsiteDiagnosticCaptureRouteResult): string {
  if (route.status === 'accepted') {
    return route.routed === false
      ? 'Router accepted the envelope without a work request.'
      : 'Capture router accepted it.'
  }
  if (route.status === 'not_configured') return 'Capture router is not configured.'
  return route.error ? `Route failed: ${route.error}` : 'Capture router did not accept it.'
}

function latestDiagnosticDelivery(
  session: OpsOnsiteDiagnosticSessionRecord | null,
): OpsOnsiteDiagnosticAgentFeedDelivery | null {
  const deliveries = session?.agent_feed_deliveries ?? []
  if (deliveries.length === 0) return null
  return [...deliveries].sort((a, b) => Date.parse(b.queued_at) - Date.parse(a.queued_at))[0] ?? null
}

type DiagnosticActionStatusLookup = {
  sessionId: string
  actionKey: OpsOnsiteDiagnosticActionKey
  clientActionId: string
}

export function latestDiagnosticActionStatusLookup(
  session: OpsOnsiteDiagnosticSessionRecord | null,
): DiagnosticActionStatusLookup | null {
  const events = (session?.audit_events ?? []).filter(
    (event) => event.type === 'action.requested' && event.action_key && event.client_action_id,
  )
  if (!session || events.length === 0) return null
  const latest = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  if (!latest?.action_key || !latest.client_action_id) return null
  return { sessionId: session.id, actionKey: latest.action_key, clientActionId: latest.client_action_id }
}

export function actionStatusTone(
  state: OpsOnsiteDiagnosticActionDeliveryState | undefined,
  pending = false,
): 'accent' | 'amber' | 'blue' | 'green' | 'red' {
  if (pending && !state) return 'blue'
  if (state === 'delivered') return 'green'
  if (state === 'failed') return 'red'
  if (state === 'retrying') return 'amber'
  return 'blue'
}

function formatActionStatusHeadline(status: OpsOnsiteDiagnosticActionStatusResponse['action_status'] | null): string {
  if (!status) return 'Action status'
  return `${diagnosticActionName(status.action_key)} status`
}

export function formatActionStatusSummary(
  status: OpsOnsiteDiagnosticActionStatusResponse['action_status'] | null,
  pending = false,
): string {
  if (!status) return pending ? 'Checking latest action status.' : 'No action status reported.'
  const routeStatus = status.capture_route?.outbox_status
  if (status.state === 'retrying') {
    return routeStatus ? `${status.summary} Route row is ${routeStatus}.` : status.summary
  }
  if (status.state === 'failed') {
    const error = status.capture_route?.error ?? status.agent_feed?.callback_error
    return error ? `${status.summary} ${error}` : status.summary
  }
  return status.summary
}

export function agentFeedDeliveryTone(
  delivery: OpsOnsiteDiagnosticAgentFeedDelivery,
): 'accent' | 'amber' | 'blue' | 'green' | 'red' {
  if (delivery.status === 'succeeded') return 'green'
  if (delivery.status === 'failed' || delivery.status === 'cancelled') return 'red'
  if (delivery.stale) return 'amber'
  return 'blue'
}

export function formatAgentFeedDeliveryHeadline(delivery: OpsOnsiteDiagnosticAgentFeedDelivery): string {
  return `${diagnosticActionName(delivery.action_key)} delivery`
}

export function formatAgentFeedDeliverySummary(
  delivery: OpsOnsiteDiagnosticAgentFeedDelivery,
  nowMs = Date.now(),
): string {
  if (delivery.status === 'succeeded') {
    return `Succeeded ${formatSince(delivery.completed_at ?? delivery.queued_at, nowMs)} · ${delivery.audience}`
  }
  if (delivery.status === 'failed') {
    return `Failed ${formatSince(delivery.completed_at ?? delivery.queued_at, nowMs)} · ${
      delivery.callback_error ? 'callback error recorded' : 'callback recorded'
    }`
  }
  if (delivery.status === 'cancelled') {
    return `Cancelled ${formatSince(delivery.completed_at ?? delivery.queued_at, nowMs)} · ${delivery.audience}`
  }
  if (delivery.status === 'claimed') {
    return delivery.stale
      ? `Claimed ${formatSince(delivery.claimed_at ?? delivery.queued_at, nowMs)} · no callback`
      : `Claimed ${formatSince(delivery.claimed_at ?? delivery.queued_at, nowMs)} · waiting for callback`
  }
  return delivery.stale
    ? `Queued ${formatSince(delivery.queued_at, nowMs)} · no executor claim`
    : `Queued ${formatSince(delivery.queued_at, nowMs)} · waiting for claim`
}

function diagnosticActionName(actionKey: OpsOnsiteDiagnosticActionKey): string {
  if (actionKey === 'route_support_packet') return 'Support packet'
  if (actionKey === 'dispatch_agent_review') return 'Agent review'
  if (actionKey === 'capture_desktop_context') return 'Desktop evidence'
  return 'Field context'
}

function diagnosticClientActionId(sessionId: string, actionKey: OpsOnsiteDiagnosticActionKey): string {
  const randomId =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${sessionId}:${actionKey}:${randomId}`.slice(0, 120)
}

function diagnosticActionIcon(actionKey: OpsOnsiteDiagnosticActionKey): typeof MI.Camera {
  if (actionKey === 'capture_field_context') return MI.Mic
  if (actionKey === 'capture_desktop_context') return MI.Camera
  if (actionKey === 'route_support_packet') return MI.Layers
  return MI.Alert
}

function formatSince(value: string, nowMs: number): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return 'recently'
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - parsed) / 1000))
  return `${formatAge(elapsedSeconds)} ago`
}

function formatClock(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'soon'
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`
  const mib = kib / 1024
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`
}

function lowerFirst(value: string): string {
  return value ? `${value[0]?.toLocaleLowerCase()}${value.slice(1)}` : value
}

function onsiteSessionRoute(plan: OpsOnsiteDiagnosticSessionPlan): string {
  if (plan.recommended_entry === 'dispatch_agent_review' || plan.recommended_entry === 'route_support_packet') {
    return '/work'
  }
  if (plan.recommended_entry === 'capture_desktop_context') return '/work/board'
  return '/issue'
}
