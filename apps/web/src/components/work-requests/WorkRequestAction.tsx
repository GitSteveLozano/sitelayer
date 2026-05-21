import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { MBanner, MButton, MButtonStack, MInput, MSectionH, MSelect, MTextarea } from '../m/index.js'
import { buildBrowserWorkRequestContext, type WorkRequestClientContext } from './context.js'
import { nextRequestId } from '@/lib/api/client'
import {
  createWorkRequest,
  queryKeys,
  type CreateWorkRequestInput,
  type CreateWorkRequestResponse,
  type WorkItemSeverity,
} from '@/lib/api'

export function WorkRequestAction({
  defaultTitle,
  defaultSummary = '',
  category,
  client,
  route,
  submitLabel = 'Create work item',
  collapsedLabel = 'Report issue',
  navigateOnCreate = true,
  onCreated,
}: {
  defaultTitle: string
  defaultSummary?: string
  category?: string | null
  client?: WorkRequestClientContext
  route?: string | null
  submitLabel?: string
  collapsedLabel?: string
  navigateOnCreate?: boolean
  onCreated?: (response: CreateWorkRequestResponse) => void
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(defaultTitle)
  const [summary, setSummary] = useState(defaultSummary)
  const [severity, setSeverity] = useState<WorkItemSeverity>('normal')
  const [clientRequestId, setClientRequestId] = useState(() => nextRequestId())
  const navigate = useNavigate()
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => {
      const clientContext = buildBrowserWorkRequestContext({ ...client, client_request_id: clientRequestId })
      const input: CreateWorkRequestInput = {
        title,
        summary,
        severity,
        lane: 'triage',
        client: clientContext,
        client_request_id: clientRequestId,
      }
      if (category !== undefined) input.category = category
      if (route !== undefined) input.route = route
      return createWorkRequest(input)
    },
    onSuccess: (response) => {
      void qc.invalidateQueries({ queryKey: queryKeys.workRequests.all() })
      onCreated?.(response)
      if (navigateOnCreate) navigate(`/work/${response.work_item.id}`)
      setOpen(false)
      setClientRequestId(nextRequestId())
    },
  })

  if (!open) {
    return (
      <div style={{ padding: '12px 16px 0' }}>
        <MButton
          variant="ghost"
          onClick={() => {
            setClientRequestId(nextRequestId())
            setOpen(true)
          }}
        >
          {collapsedLabel}
        </MButton>
      </div>
    )
  }

  return (
    <div style={{ padding: '12px 16px 0' }}>
      <MSectionH>Work item</MSectionH>
      <div
        style={{
          display: 'grid',
          gap: 10,
          padding: 12,
          border: '1px solid var(--m-line)',
          borderRadius: 8,
          background: 'var(--m-card)',
        }}
      >
        {mutation.error ? (
          <MBanner
            tone="error"
            title="Create failed"
            body={mutation.error instanceof Error ? mutation.error.message : 'Request failed.'}
          />
        ) : null}
        <MInput
          aria-label="Title"
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          placeholder="Title"
        />
        <MTextarea
          aria-label="Summary"
          value={summary}
          onChange={(event) => setSummary(event.currentTarget.value)}
          placeholder="What happened?"
          rows={4}
        />
        <MSelect
          aria-label="Severity"
          value={severity}
          onChange={(event) => setSeverity(event.currentTarget.value as WorkItemSeverity)}
        >
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </MSelect>
        <MButtonStack>
          <MButton onClick={() => mutation.mutate()} disabled={mutation.isPending || !title.trim()}>
            {mutation.isPending ? 'Creating...' : submitLabel}
          </MButton>
          <MButton variant="ghost" onClick={() => setOpen(false)} disabled={mutation.isPending}>
            Cancel
          </MButton>
        </MButtonStack>
      </div>
    </div>
  )
}
