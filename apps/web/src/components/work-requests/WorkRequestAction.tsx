import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { CompanyRole } from '@sitelayer/domain'
import { MBanner, MButton, MButtonStack, MInput, MSectionH, MSelect, MTextarea } from '../m/index.js'
import { buildBrowserWorkRequestContext, type WorkRequestClientContext } from './context.js'
import { nextRequestId } from '@/lib/api/client'
import { canCreateWorkRequests } from '@/lib/work-request-permissions'
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
  companyRole,
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
  companyRole?: CompanyRole
  onCreated?: (response: CreateWorkRequestResponse) => void
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(defaultTitle)
  const [summary, setSummary] = useState(defaultSummary)
  const [severity, setSeverity] = useState<WorkItemSeverity>('normal')
  const [clientRequestId, setClientRequestId] = useState(() => nextRequestId())
  const navigate = useNavigate()
  const qc = useQueryClient()
  const previewContext = useMemo(
    () => buildBrowserWorkRequestContext({ ...client, client_request_id: clientRequestId }),
    [client, clientRequestId],
  )
  const mutation = useMutation({
    mutationFn: () => {
      const input: CreateWorkRequestInput = {
        title,
        summary,
        severity,
        lane: 'triage',
        client: previewContext,
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

  if (companyRole !== undefined && !canCreateWorkRequests(companyRole)) return null

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
        <div style={{ display: 'grid', gap: 6, fontSize: 12, color: 'var(--m-ink-2)' }}>
          <PreviewLine label="Route" value={route ?? readRoute(previewContext)} />
          <PreviewLine label="Entity" value={readEntity(previewContext)} />
          <PreviewLine label="Request" value={readText(previewContext.client_request_id)} />
          <PreviewLine label="Build" value={readText(previewContext.build_sha)} />
          <div style={{ color: 'var(--m-ink-3)', lineHeight: 1.35 }}>
            Obvious secrets, tokens, emails, and phone numbers are redacted before this context is stored.
          </div>
        </div>
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

function PreviewLine({ label, value }: { label: string; value: string | null }) {
  if (!value) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '70px minmax(0, 1fr)', gap: 8 }}>
      <span style={{ color: 'var(--m-ink-3)' }}>{label}</span>
      <span style={{ overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  )
}

function readRoute(context: WorkRequestClientContext): string | null {
  const page = readRecord(context.page)
  return readText(page?.route) ?? readText(page?.path)
}

function readEntity(context: WorkRequestClientContext): string | null {
  const path = readRecord(context.path)
  const entity = readRecord(context.entity)
  const entityType = readText(path?.entity_type) ?? readText(entity?.entity_type)
  const entityId = readText(path?.entity_id) ?? readText(entity?.entity_id)
  if (entityType && entityId) return `${entityType}:${entityId}`
  return entityType ?? entityId
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
