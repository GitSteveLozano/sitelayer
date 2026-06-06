import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { fetchWorkRequests, queryKeys, type ContextWorkItem, type WorkItemStatus } from '@/lib/api'
import { MListInset, MListRow, MSectionH, MI } from '../m/index.js'
import { WorkRequestSeverityPill, WorkRequestStatusPill } from './status.js'

const OPEN_STATUSES = new Set<WorkItemStatus>([
  'new',
  'triaged',
  'agent_running',
  'human_assigned',
  'review_ready',
  'review_stale',
  'proposal_expired',
  'reopened',
])

export function WorkRequestEntityStatus({
  entityType,
  entityId,
  title = 'Open work',
  limit = 5,
}: {
  entityType: string
  entityId: string
  title?: string
  limit?: number
}) {
  const navigate = useNavigate()
  const params = useMemo(
    () => ({
      entity_type: entityType,
      entity_id: entityId,
      limit,
    }),
    [entityId, entityType, limit],
  )
  const query = useQuery({
    queryKey: queryKeys.workRequests.list(params),
    queryFn: () => fetchWorkRequests(params),
    staleTime: 30_000,
  })
  const rows = useMemo(
    () => (query.data?.work_items ?? []).filter((item) => OPEN_STATUSES.has(item.status)),
    [query.data?.work_items],
  )

  if (query.isPending || rows.length === 0) return null

  return (
    <>
      <MSectionH>{title}</MSectionH>
      <MListInset>
        {rows.map((item: ContextWorkItem) => (
          <MListRow
            key={item.id}
            leading={<MI.FileText size={18} />}
            leadingTone={item.status === 'review_ready' ? 'amber' : 'blue'}
            headline={item.title}
            supporting={item.summary || item.route || 'No summary'}
            trailing={
              <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <WorkRequestStatusPill status={item.status} />
                <WorkRequestSeverityPill severity={item.severity} />
              </span>
            }
            chev
            onTap={() => navigate(`/work/${item.id}`)}
          />
        ))}
      </MListInset>
    </>
  )
}
