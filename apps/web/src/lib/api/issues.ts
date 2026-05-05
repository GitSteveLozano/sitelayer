// Worker-issue ping (`wk-issue` from Sitemap §11). Wraps
// apps/api/src/routes/worker-issues.ts.

import { useMutation } from '@tanstack/react-query'
import { request } from './client'

export type WorkerIssueKind = 'materials_out' | 'crew_short' | 'safety' | 'other'

export interface WorkerIssue {
  id: string
  company_id: string
  project_id: string | null
  worker_id: string | null
  reporter_clerk_user_id: string
  kind: WorkerIssueKind
  message: string
  resolved_at: string | null
  resolved_by_clerk_user_id: string | null
  created_at: string
}

export interface CreateWorkerIssueRequest {
  kind: WorkerIssueKind
  message: string
  /** Optional — when omitted the server logs the ping with a null project. */
  project_id?: string | null
}

export interface CreateWorkerIssueResponse {
  worker_issue: WorkerIssue
}

export function createWorkerIssue(input: CreateWorkerIssueRequest): Promise<CreateWorkerIssueResponse> {
  return request<CreateWorkerIssueResponse>('/api/worker-issues', { method: 'POST', json: input })
}

export function useCreateWorkerIssue() {
  return useMutation<CreateWorkerIssueResponse, Error, CreateWorkerIssueRequest>({
    mutationFn: createWorkerIssue,
  })
}
