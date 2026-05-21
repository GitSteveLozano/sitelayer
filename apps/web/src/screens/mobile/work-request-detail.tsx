import { useState } from 'react'
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
} from '../../components/m/index.js'
import { MSkeletonList } from '../../components/m-states/index.js'
import { WorkRequestContextPreview } from '../../components/work-requests/WorkRequestContextPreview.js'
import { WorkRequestTimeline } from '../../components/work-requests/WorkRequestTimeline.js'
import { WorkRequestSeverityPill, WorkRequestStatusPill } from '../../components/work-requests/status.js'
import {
  appendWorkRequestEvent,
  dispatchWorkRequestToMesh,
  fetchWorkRequest,
  fetchWorkRequestGithubExport,
  queryKeys,
  retryWorkRequestMeshDispatch,
  type AppendWorkRequestEventInput,
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
  const githubExport = useMutation({
    mutationFn: () => fetchWorkRequestGithubExport(workItemId),
    onSuccess: (response) => setGithubExportBody(response.body),
  })

  const workItem = detail.data?.work_item ?? null
  const canTriage = canTriageWorkRequests(companyRole)
  const busy = appendEvent.isPending || dispatch.isPending || retryDispatch.isPending || githubExport.isPending
  const isClosed = workItem?.status === 'resolved' || workItem?.status === 'wont_do'
  const dispatchOutbox = detail.data?.dispatch_outbox ?? null
  const canRetryDispatch = dispatchOutbox?.status === 'failed' || dispatchOutbox?.status === 'dead'

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
              </div>
              <h1 style={{ margin: 0, fontSize: 22, lineHeight: 1.15, fontWeight: 750 }}>{workItem.title}</h1>
              {workItem.summary ? (
                <div style={{ color: 'var(--m-ink-2)', fontSize: 14, lineHeight: 1.45 }}>{workItem.summary}</div>
              ) : null}
            </div>

            {appendEvent.error || dispatch.error || retryDispatch.error ? (
              <div style={{ padding: '8px 16px' }}>
                <MBanner
                  tone="error"
                  title="Update failed"
                  body={
                    (appendEvent.error ?? dispatch.error ?? retryDispatch.error) instanceof Error
                      ? (appendEvent.error ?? dispatch.error ?? retryDispatch.error)?.message
                      : 'Request failed.'
                  }
                />
              </div>
            ) : null}

            {canTriage || isClosed ? (
              <>
                <MSectionH>Actions</MSectionH>
                <div style={{ padding: '0 16px', display: 'grid', gap: 10 }}>
                  <MButtonStack>
                    {canTriage ? (
                      canRetryDispatch ? (
                        <MButton variant="primary" disabled={busy} onClick={() => retryDispatch.mutate()}>
                          {retryDispatch.isPending ? 'Retrying...' : 'Retry dispatch'}
                        </MButton>
                      ) : (
                        <MButton
                          variant="primary"
                          disabled={busy || workItem.status === 'agent_running'}
                          onClick={() => dispatch.mutate()}
                        >
                          {dispatch.isPending ? 'Dispatching...' : 'Dispatch agent'}
                        </MButton>
                      )
                    ) : null}
                    {isClosed ? (
                      <MButton
                        variant="ghost"
                        disabled={busy}
                        onClick={() => appendEvent.mutate({ event_type: 'resolution.reopened' })}
                      >
                        Reopen
                      </MButton>
                    ) : canTriage ? (
                      <MButton
                        variant="ghost"
                        disabled={busy}
                        onClick={() => appendEvent.mutate({ event_type: 'resolution.accepted' })}
                      >
                        Mark resolved
                      </MButton>
                    ) : null}
                  </MButtonStack>
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
            </MListInset>

            <WorkRequestTimeline events={detail.data.events} />
          </>
        )}
      </MBody>
    </>
  )
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
