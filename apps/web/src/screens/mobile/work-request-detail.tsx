import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import {
  MBanner,
  MBody,
  MButton,
  MButtonStack,
  MI,
  MInput,
  MListInset,
  MListRow,
  MSectionH,
  MTextarea,
  MTopBar,
  Spark,
} from '../../components/m/index.js'
import { MSkeletonList } from '../../components/m-states/index.js'
import { WorkRequestContextPreview } from '../../components/work-requests/WorkRequestContextPreview.js'
import { WorkRequestTimeline } from '../../components/work-requests/WorkRequestTimeline.js'
import {
  WorkRequestReversibilityBadge,
  WorkRequestSeverityPill,
  WorkRequestStatusPill,
  reversibilityBadgeState,
} from '../../components/work-requests/status.js'
import {
  appendWorkRequestEvent,
  dispatchWorkRequestToMesh,
  fetchSupportPacket,
  fetchSupportPacketAccessLog,
  fetchWorkRequest,
  fetchWorkRequestGithubExport,
  fetchWorkRequestQueueHealth,
  queryKeys,
  retryWorkRequestMeshDispatch,
  reverseWorkRequest,
  type AppendWorkRequestEventInput,
  type WorkRequestBrief,
} from '@/lib/api'
import { canTriageWorkRequests } from '@/lib/work-request-permissions'
import type { CompanyRole } from '@sitelayer/domain'

export function MobileWorkRequestDetail({ companyRole }: { companyRole: CompanyRole }) {
  const params = useParams<{ workItemId: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const workItemId = params.workItemId ?? ''
  const [message, setMessage] = useState('')
  const [githubUrl, setGithubUrl] = useState('')
  const [githubExportBody, setGithubExportBody] = useState('')
  const [reverseReason, setReverseReason] = useState('')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const detail = useQuery({
    queryKey: queryKeys.workRequests.detail(workItemId),
    queryFn: () => fetchWorkRequest(workItemId),
    enabled: Boolean(workItemId),
  })
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.workRequests.detail(workItemId) })
    void qc.invalidateQueries({ queryKey: queryKeys.workRequests.all() })
  }
  const appendEvent = useMutation({
    mutationFn: (input: AppendWorkRequestEventInput) => appendWorkRequestEvent(workItemId, input),
    onSuccess: invalidate,
  })
  const dispatch = useMutation({
    mutationFn: () => dispatchWorkRequestToMesh(workItemId),
    onSuccess: invalidate,
  })
  const retryDispatch = useMutation({
    mutationFn: () => retryWorkRequestMeshDispatch(workItemId),
    onSuccess: invalidate,
  })
  const reverse = useMutation({
    mutationFn: (reason: string) => reverseWorkRequest(workItemId, { reason }),
    onSuccess: invalidate,
  })
  const githubExport = useMutation({
    mutationFn: () => fetchWorkRequestGithubExport(workItemId),
    onSuccess: (response) => setGithubExportBody(response.body),
  })
  const supportPacket = useMutation({
    mutationFn: (id: string) => fetchSupportPacket(id),
    onSuccess: (_, id) => {
      void qc.invalidateQueries({ queryKey: queryKeys.supportPackets.accessLog(id) })
    },
  })
  const workItem = detail.data?.work_item ?? null
  const canTriage = canTriageWorkRequests(companyRole)
  const isAdmin = companyRole === 'admin'
  const supportPacketId = detail.data?.support_packet?.id ?? workItem?.support_packet_id ?? ''
  const health = useQuery({
    queryKey: queryKeys.workRequests.health(),
    queryFn: fetchWorkRequestQueueHealth,
    enabled: canTriage,
    refetchInterval: 30_000,
  })
  const supportPacketAccessLog = useQuery({
    queryKey: queryKeys.supportPackets.accessLog(supportPacketId),
    queryFn: () => fetchSupportPacketAccessLog(supportPacketId),
    enabled: isAdmin && Boolean(supportPacketId),
  })

  const busy =
    appendEvent.isPending ||
    dispatch.isPending ||
    retryDispatch.isPending ||
    githubExport.isPending ||
    supportPacket.isPending ||
    reverse.isPending
  const isReversed = workItem?.status === 'reversed'
  const canReopen = workItem?.status === 'resolved' || workItem?.status === 'wont_do'
  const isClosed = canReopen || isReversed
  const reversibility = workItem ? reversibilityBadgeState(workItem, now) : null
  const canReverse =
    canTriage &&
    workItem !== null &&
    !isClosed &&
    reversibility !== null &&
    reversibility.mode !== 'closed' &&
    reversibility.mode !== 'reversed'
  const dispatchOutbox = detail.data?.dispatch_outbox ?? null
  const canDispatch = canTriage && !isClosed
  const canRetryDispatch = canDispatch && (dispatchOutbox?.status === 'failed' || dispatchOutbox?.status === 'dead')
  const canResolve = canTriage && !isClosed
  const dispatchUnavailable = Boolean(
    health.data && (!health.data.config.mesh_dispatch_configured || !health.data.config.scoped_callbacks_enabled),
  )
  const hasActions = canDispatch || canReopen || canResolve || canReverse

  return (
    <>
      <MTopBar back title="Work item" onBack={() => navigate('/work')} />
      <MBody>
        {detail.isPending ? (
          <MSkeletonList count={5} />
        ) : detail.error || !workItem ? (
          <div style={{ padding: 16 }}>
            <MBanner
              tone="error"
              title="Load failed"
              body={detail.error instanceof Error ? detail.error.message : 'Work item not found.'}
            />
          </div>
        ) : (
          <>
            <div style={{ padding: '16px 16px 4px', display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <WorkRequestStatusPill status={workItem.status} />
                <WorkRequestSeverityPill severity={workItem.severity} />
                <WorkRequestReversibilityBadge workItem={workItem} now={now} />
              </div>
              <h1 style={{ margin: 0, fontSize: 22, lineHeight: 1.15, fontWeight: 750 }}>{workItem.title}</h1>
              {workItem.summary ? (
                <div style={{ color: 'var(--m-ink-2)', fontSize: 14, lineHeight: 1.45 }}>{workItem.summary}</div>
              ) : null}
            </div>

            {appendEvent.error || dispatch.error || retryDispatch.error || reverse.error ? (
              <div style={{ padding: '8px 16px' }}>
                <MBanner
                  tone="error"
                  title="Update failed"
                  body={
                    (appendEvent.error ?? dispatch.error ?? retryDispatch.error ?? reverse.error) instanceof Error
                      ? (appendEvent.error ?? dispatch.error ?? retryDispatch.error ?? reverse.error)?.message
                      : 'Request failed.'
                  }
                />
              </div>
            ) : null}

            {hasActions ? (
              <>
                <MSectionH>Actions</MSectionH>
                <div style={{ padding: '0 16px', display: 'grid', gap: 10 }}>
                  {canDispatch && dispatchUnavailable ? (
                    <MBanner
                      tone="warn"
                      title="Agent dispatch unavailable"
                      body="Mesh dispatch is not configured for this environment. Keep this in human review or use the GitHub export."
                    />
                  ) : null}
                  <MButtonStack>
                    {canDispatch ? (
                      canRetryDispatch ? (
                        <MButton
                          variant="primary"
                          disabled={busy || dispatchUnavailable}
                          onClick={() => retryDispatch.mutate()}
                        >
                          {retryDispatch.isPending ? 'Retrying...' : 'Retry dispatch'}
                        </MButton>
                      ) : (
                        <MButton
                          variant="primary"
                          disabled={busy || dispatchUnavailable || workItem.status === 'agent_running'}
                          onClick={() => dispatch.mutate()}
                        >
                          {dispatch.isPending ? 'Dispatching...' : 'Dispatch agent'}
                        </MButton>
                      )
                    ) : null}
                    {canReopen ? (
                      <MButton
                        variant="ghost"
                        disabled={busy}
                        onClick={() => appendEvent.mutate({ event_type: 'resolution.reopened' })}
                      >
                        Reopen
                      </MButton>
                    ) : canResolve ? (
                      <MButton
                        variant="ghost"
                        disabled={busy}
                        onClick={() => appendEvent.mutate({ event_type: 'resolution.accepted' })}
                      >
                        Mark resolved
                      </MButton>
                    ) : null}
                  </MButtonStack>
                  {canReverse ? (
                    <div style={{ display: 'grid', gap: 8 }}>
                      <MInput
                        aria-label="Reverse reason"
                        value={reverseReason}
                        onChange={(event) => setReverseReason(event.currentTarget.value)}
                        placeholder="Why reverse?"
                      />
                      <MButton
                        variant="ghost"
                        disabled={busy || !reverseReason.trim()}
                        onClick={() =>
                          reverse.mutate(reverseReason.trim(), {
                            onSuccess: () => setReverseReason(''),
                          })
                        }
                      >
                        {reverse.isPending ? 'Reversing...' : 'Reverse'}
                      </MButton>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            <MSectionH>Message</MSectionH>
            <div style={{ padding: '0 16px', display: 'grid', gap: 10 }}>
              <MTextarea
                aria-label="Message"
                value={message}
                onChange={(event) => setMessage(event.currentTarget.value)}
                placeholder="Add a note"
                rows={3}
              />
              <MButton
                variant="ghost"
                disabled={busy || !message.trim()}
                onClick={() =>
                  appendEvent.mutate(
                    { event_type: 'message.added', message },
                    {
                      onSuccess: () => setMessage(''),
                    },
                  )
                }
              >
                Add message
              </MButton>
            </div>

            {canTriage ? (
              <>
                <MSectionH>External</MSectionH>
                <div style={{ padding: '0 16px', display: 'grid', gap: 10 }}>
                  <MButton variant="ghost" disabled={busy} onClick={() => githubExport.mutate()}>
                    {githubExport.isPending ? 'Preparing...' : 'Prepare GitHub export'}
                  </MButton>
                  {githubExportBody ? (
                    <MTextarea aria-label="GitHub export body" readOnly value={githubExportBody} rows={8} />
                  ) : null}
                  <MInput
                    aria-label="GitHub issue URL"
                    value={githubUrl}
                    onChange={(event) => setGithubUrl(event.currentTarget.value)}
                    placeholder="GitHub issue URL"
                  />
                  <MButton
                    variant="ghost"
                    disabled={busy || !githubUrl.trim()}
                    onClick={() =>
                      appendEvent.mutate(
                        {
                          event_type: 'external.github_linked',
                          url: githubUrl,
                          metadata: { source: 'manual_link' },
                        },
                        {
                          onSuccess: () => setGithubUrl(''),
                        },
                      )
                    }
                  >
                    Link GitHub
                  </MButton>
                </div>
              </>
            ) : null}

            <WorkRequestContextPreview workItem={workItem} supportPacket={detail.data.support_packet} />

            <WorkRequestAgentBrief brief={detail.data.work_request_brief} />

            {isAdmin ? (
              <>
                <MSectionH>Support packet</MSectionH>
                <div style={{ padding: '0 16px', display: 'grid', gap: 10 }}>
                  {supportPacket.error ? (
                    <MBanner
                      tone="error"
                      title="Packet load failed"
                      body={
                        supportPacket.error instanceof Error
                          ? supportPacket.error.message
                          : 'Support packet could not be loaded.'
                      }
                    />
                  ) : null}
                  <MButton
                    variant="ghost"
                    disabled={busy || !supportPacketId}
                    onClick={() => supportPacket.mutate(supportPacketId)}
                  >
                    {supportPacket.isPending ? 'Loading...' : 'Load packet'}
                  </MButton>
                  {supportPacket.data ? (
                    <>
                      <MTextarea
                        aria-label="Support packet agent prompt"
                        readOnly
                        value={supportPacket.data.agent_prompt}
                        rows={8}
                      />
                      <MTextarea
                        aria-label="Support packet JSON"
                        readOnly
                        value={JSON.stringify(supportPacket.data.support_packet, null, 2)}
                        rows={10}
                      />
                    </>
                  ) : null}
                  {supportPacketAccessLog.error ? (
                    <MBanner
                      tone="error"
                      title="Access log failed"
                      body={
                        supportPacketAccessLog.error instanceof Error
                          ? supportPacketAccessLog.error.message
                          : 'Support packet access log could not be loaded.'
                      }
                    />
                  ) : null}
                </div>
                <MListInset>
                  {supportPacketAccessLog.isPending ? (
                    <MListRow headline="Access log" supporting="Loading packet access history" />
                  ) : supportPacketAccessLog.data?.access_log.length ? (
                    supportPacketAccessLog.data.access_log.map((entry) => (
                      <MListRow
                        key={entry.id}
                        leading={<MI.ShieldAlert size={18} />}
                        leadingTone="blue"
                        headline={`${formatAccessType(entry.access_type)} by ${entry.actor_user_id}`}
                        supporting={formatAccessLogEntry(entry)}
                      />
                    ))
                  ) : (
                    <MListRow headline="Access log" supporting="No packet reads recorded yet" />
                  )}
                </MListInset>
              </>
            ) : null}

            <MSectionH>State</MSectionH>
            <MListInset>
              {dispatchOutbox ? (
                <MListRow
                  leading={<MI.CloudOff size={18} />}
                  leadingTone={canRetryDispatch ? 'red' : 'blue'}
                  headline="Dispatch"
                  supporting={formatDispatchOutbox(dispatchOutbox)}
                />
              ) : null}
              <MListRow
                leading={<MI.Clock size={18} />}
                leadingTone="blue"
                headline="Lane"
                supporting={workItem.lane}
              />
              <MListRow headline="Created" supporting={formatDateTime(workItem.created_at)} />
              <MListRow headline="Updated" supporting={formatDateTime(workItem.updated_at)} />
              {workItem.resolved_at ? (
                <MListRow headline="Resolved" supporting={formatDateTime(workItem.resolved_at)} />
              ) : null}
              {workItem.reversed_at ? (
                <MListRow headline="Reversed" supporting={formatDateTime(workItem.reversed_at)} />
              ) : null}
              {workItem.expires_at && !workItem.reversed_at ? (
                <MListRow headline="Recall window" supporting={`closes ${formatDateTime(workItem.expires_at)}`} />
              ) : null}
            </MListInset>

            <WorkRequestTimeline events={detail.data.events} />
          </>
        )}
      </MBody>
    </>
  )
}

function WorkRequestAgentBrief({ brief }: { brief: WorkRequestBrief }) {
  const diagnostics = brief.diagnostics
  const supporting = [
    diagnostics.route,
    diagnostics.entity_type && diagnostics.entity_id ? `${diagnostics.entity_type}:${diagnostics.entity_id}` : null,
    diagnostics.dispatch_outbox_status ? `dispatch ${diagnostics.dispatch_outbox_status}` : null,
  ]
    .filter(Boolean)
    .join(' - ')
  return (
    <>
      <MSectionH>Agent brief</MSectionH>
      <MListInset>
        <MListRow
          leading={<Spark state="accent" size={16} />}
          leadingTone="accent"
          headline="Next action"
          supporting={formatBriefAction(brief.state.next_action)}
        />
        <MListRow
          headline="Context"
          supporting={supporting || diagnostics.work_item_path}
          trailing={<span>{formatDateTime(brief.generated_at)}</span>}
        />
        <MListRow
          headline="Evidence"
          supporting={diagnostics.evidence_refs.map((ref) => `${ref.type}:${ref.id}`).join(' - ')}
          trailing={
            <span>
              {brief.timeline_total} event{brief.timeline_total === 1 ? '' : 's'}
              {brief.timeline_truncated ? '+' : ''}
            </span>
          }
        />
      </MListInset>
      <div style={{ padding: '0 16px', display: 'grid', gap: 10 }}>
        <MTextarea
          aria-label="Agent brief markdown"
          readOnly
          value={brief.agent_brief_markdown}
          rows={10}
          style={{
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            fontSize: 12,
            lineHeight: 1.45,
          }}
        />
      </div>
    </>
  )
}

function formatBriefAction(value: string): string {
  return value
    .split('_')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ')
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function formatDispatchOutbox(outbox: {
  status: string
  attempt_count: number
  next_attempt_at: string | null
  error: string | null
}): string {
  const parts = [`${outbox.status}, ${outbox.attempt_count} attempt${outbox.attempt_count === 1 ? '' : 's'}`]
  if (outbox.next_attempt_at && outbox.status !== 'applied') {
    parts.push(`next ${formatDateTime(outbox.next_attempt_at)}`)
  }
  if (outbox.error) parts.push(outbox.error)
  return parts.join(' - ')
}

function formatAccessType(value: string): string {
  return value
    .split('_')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ')
}

function formatAccessLogEntry(entry: { created_at: string; route: string | null; request_id: string | null }): string {
  return [
    formatDateTime(entry.created_at),
    entry.route ? `route ${entry.route}` : null,
    entry.request_id ? `request ${entry.request_id}` : null,
  ]
    .filter(Boolean)
    .join(' - ')
}
