// QBO custom-field cross-reference — view/define which QBO custom field
// each entity_type+field_name maps to. Wraps the CRUD in
// apps/api/src/routes/qbo-custom-fields.ts:
//
//   GET    /api/qbo/custom-fields        list definitions
//   PUT    /api/qbo/custom-fields        upsert one (conflict on
//                                        company_id+entity_type+field_name)
//   DELETE /api/qbo/custom-fields/:id    remove
//
// The worker's QBO push handlers read these rows to know which custom
// field id to populate; a missing mapping is tolerated (the field write
// is skipped, not failed).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export type QboCustomFieldEntity = 'Estimate' | 'Invoice' | 'Bill' | 'PurchaseOrder'

export const QBO_CUSTOM_FIELD_ENTITIES: readonly QboCustomFieldEntity[] = [
  'Estimate',
  'Invoice',
  'Bill',
  'PurchaseOrder',
]

export interface QboCustomField {
  id: string
  company_id: string
  entity_type: string
  field_name: string
  qbo_definition_id: string
  qbo_label: string | null
  notes: string | null
  origin: string | null
  created_at: string
  updated_at: string
}

export interface QboCustomFieldListResponse {
  mappings: QboCustomField[]
}

export interface QboCustomFieldUpsertRequest {
  entity_type: QboCustomFieldEntity | string
  field_name: string
  qbo_definition_id: string
  qbo_label?: string | null
  notes?: string | null
}

const KEYS = {
  all: () => ['qbo', 'custom-fields'] as const,
  list: () => [...KEYS.all(), 'list'] as const,
}

export const qboCustomFieldQueryKeys = KEYS

export function fetchQboCustomFields(): Promise<QboCustomFieldListResponse> {
  return request<QboCustomFieldListResponse>('/api/qbo/custom-fields')
}

export function useQboCustomFields() {
  return useQuery<QboCustomFieldListResponse>({
    queryKey: KEYS.list(),
    queryFn: fetchQboCustomFields,
  })
}

export function useUpsertQboCustomField() {
  const qc = useQueryClient()
  return useMutation<{ mapping: QboCustomField }, Error, QboCustomFieldUpsertRequest>({
    mutationFn: (input) =>
      request<{ mapping: QboCustomField }>('/api/qbo/custom-fields', { method: 'PUT', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

export function useDeleteQboCustomField() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { id: string }>({
    mutationFn: ({ id }) => request(`/api/qbo/custom-fields/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}
