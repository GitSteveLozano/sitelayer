// Shipment deterministic-workflow hook.
//
// Headless snapshot/events surface for the shipment workflow, mirroring the
// rental-billing-run review pattern (see apps/web/src/machines/billing-review.ts
// + apps/web/src/screens/financial/billing-run-detail.tsx). The backend lives
// in apps/api/src/routes/shipments.ts:
//
//   GET  /api/shipments/:id          → WorkflowSnapshot { state, state_version,
//                                       context, next_events }
//   POST /api/shipments/:id/events   → { event, state_version } applies the
//                                       reducer; 200 returns the fresh snapshot,
//                                       409 returns { error, snapshot } on a
//                                       stale state_version or illegal transition.
//
// The screen is a thin renderer: it never invents UI-only business states. A
// 409 reloads the authoritative snapshot and surfaces an out-of-sync banner so
// the operator re-picks the next action. This hook owns only the transient UI
// state (submitting / error / outOfSync) around the TanStack Query cache.

import { useCallback, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, request } from './client'

export type ShipmentWorkflowState = 'planned' | 'picking' | 'shipped' | 'delivered' | 'returning' | 'closed' | 'voided'

export type ShipmentHumanEvent = 'START_PICKING' | 'SHIP' | 'CONFIRM_DELIVERY' | 'OPEN_RETURN' | 'CLOSE' | 'VOID'

export interface ShipmentNextEvent {
  type: ShipmentHumanEvent
  label: string
  disabled_reason?: string
}

export interface ShipmentLine {
  id: string
  shipment_id: string
  inventory_item_id: string | null
  catalog_part_id: string | null
  bom_line_id: string | null
  quantity_planned: string
  quantity_shipped: string
  quantity_delivered: string
  quantity_returned: string
  quantity_damaged: string
  quantity_lost: string
  notes: string | null
}

export interface ShipmentEvent {
  id: string
  shipment_id: string
  event_type: string
  payload: Record<string, unknown>
  state_before: string | null
  state_after: string | null
  state_version: number
  produced_by: string
  created_at: string
}

export interface ShipmentWorkflowContext {
  id: string
  company_id: string
  project_id: string
  bom_id: string | null
  source_branch_id: string | null
  destination_location_id: string | null
  direction: string
  status: ShipmentWorkflowState
  state_version: number
  scheduled_for: string | null
  shipped_at: string | null
  delivered_at: string | null
  confirmed_by: string | null
  driver: string | null
  ticket_number: string | null
  notes: string | null
  workflow_engine: string
  workflow_run_id: string | null
  version: number
  created_at: string
  updated_at: string
  lines: ShipmentLine[]
  events: ShipmentEvent[]
}

export interface ShipmentWorkflowSnapshot {
  state: ShipmentWorkflowState
  state_version: number
  context: ShipmentWorkflowContext
  next_events: ShipmentNextEvent[]
}

const shipmentSnapshotKey = (shipmentId: string) => ['shipment-workflow', shipmentId] as const

/** Pull a `{ error, snapshot }` body off a 409 ApiError, if present. */
function readConflictSnapshot(err: unknown): ShipmentWorkflowSnapshot | null {
  if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'snapshot' in err.body) {
    const snapshot = (err.body as { snapshot?: unknown }).snapshot
    if (snapshot && typeof snapshot === 'object') return snapshot as ShipmentWorkflowSnapshot
  }
  return null
}

export interface UseShipmentWorkflow {
  snapshot: ShipmentWorkflowSnapshot | undefined
  isLoading: boolean
  isSubmitting: boolean
  /** Human-readable error from the last failed dispatch (or load). */
  error: string | null
  /** True when the server state moved on under us and we reloaded a fresh snapshot. */
  outOfSync: boolean
  dispatch: (event: ShipmentHumanEvent, payload?: Record<string, unknown>) => void
  dismissError: () => void
}

/**
 * Headless shipment-workflow hook. Loads the WorkflowSnapshot and dispatches
 * human events through POST /api/shipments/:id/events. A 409 (stale version or
 * illegal transition) writes the authoritative snapshot from the error body
 * back into the cache and raises `outOfSync` so the screen re-renders fresh
 * action buttons.
 */
export function useShipmentWorkflow(shipmentId: string): UseShipmentWorkflow {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [outOfSync, setOutOfSync] = useState(false)

  const query = useQuery<ShipmentWorkflowSnapshot>({
    queryKey: shipmentSnapshotKey(shipmentId),
    enabled: !!shipmentId,
    queryFn: () => request<ShipmentWorkflowSnapshot>(`/api/shipments/${encodeURIComponent(shipmentId)}`),
  })

  const mutation = useMutation<
    ShipmentWorkflowSnapshot,
    Error,
    { event: ShipmentHumanEvent; payload?: Record<string, unknown> }
  >({
    mutationFn: (input) =>
      request<ShipmentWorkflowSnapshot>(`/api/shipments/${encodeURIComponent(shipmentId)}/events`, {
        method: 'POST',
        json: { event: input.event, state_version: query.data?.state_version, payload: input.payload },
      }),
    onMutate: () => {
      setError(null)
      setOutOfSync(false)
    },
    onSuccess: (snapshot) => {
      qc.setQueryData(shipmentSnapshotKey(shipmentId), snapshot)
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message_for_user() : err.message
      const conflictSnapshot = readConflictSnapshot(err)
      if (err instanceof ApiError && err.status === 409 && conflictSnapshot) {
        // Server state moved on (stale version) or the transition was
        // illegal from the fresh state — adopt the authoritative snapshot
        // and let the operator re-pick.
        qc.setQueryData(shipmentSnapshotKey(shipmentId), conflictSnapshot)
        setOutOfSync(true)
        setError(message)
        return
      }
      // Other failures: surface the message, refetch to stay honest.
      setError(message)
      void qc.invalidateQueries({ queryKey: shipmentSnapshotKey(shipmentId) })
    },
  })

  const dispatch = useCallback(
    (event: ShipmentHumanEvent, payload?: Record<string, unknown>) => {
      mutation.mutate(payload === undefined ? { event } : { event, payload })
    },
    [mutation],
  )

  const dismissError = useCallback(() => {
    setError(null)
    setOutOfSync(false)
  }, [])

  return {
    snapshot: query.data,
    isLoading: query.isPending,
    isSubmitting: mutation.isPending,
    error,
    outOfSync,
    dispatch,
    dismissError,
  }
}
