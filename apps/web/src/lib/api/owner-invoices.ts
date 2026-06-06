// Owner "Books · Invoices" composite list. There is no single unified
// invoices endpoint, so this hook COMPOSES the two company-scoped billing
// surfaces that already exist:
//
//   • estimate_pushes      (./estimate-pushes.ts → GET /api/estimate-pushes)
//       — the QBO estimate-push workflow; one row per estimate sent toward
//         QBO. `subtotal` is the invoice amount.
//   • rental_billing_runs  (./billing-runs.ts → GET /api/rental-billing-runs)
//       — recurring rental invoicing runs; one row per billing period.
//
// Both lists carry only ids (project_id / customer_id), so this layer joins
// the bootstrap project + customer rosters back in for human-readable
// Project / Client labels. Read-only derivation — no new API calls beyond the
// two underlying list queries.
import { useMemo } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import { useEstimatePushes, type EstimatePushState } from './estimate-pushes'
import { useBillingRuns, type RentalBillingState } from './billing-runs'

export type InvoiceKind = 'estimate' | 'rental'

/** A unified invoice/billing row for the owner Books view. */
export interface OwnerInvoiceRow {
  /** Stable per-source id (the underlying estimate_push / billing_run id). */
  id: string
  kind: InvoiceKind
  projectId: string
  /** Resolved project name, or a short id fallback when not in bootstrap. */
  projectName: string
  /** Resolved client/customer name, or '—' when unknown. */
  clientName: string
  amount: number
  /** Raw workflow status (lowercase enum), used for tone + reminder gating. */
  status: EstimatePushState | RentalBillingState
  /** ISO timestamp this row was created (drives the Date column + sort). */
  date: string
  /** True once the invoice has actually been pushed to QBO (posted). */
  posted: boolean
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

/**
 * Compose estimate pushes + rental billing runs into one company-wide invoice
 * list, newest first, with project/client labels joined from bootstrap.
 *
 * `bootstrap` may be null on first paint; the underlying queries still run.
 * Loading/error state is the union of the two queries so the caller can show a
 * single spinner / error surface.
 */
export function useOwnerInvoices(bootstrap: BootstrapResponse | null) {
  const estimatePushes = useEstimatePushes()
  const billingRuns = useBillingRuns()

  const projectsById = useMemo(() => {
    const map = new Map<string, { name: string; customerName: string }>()
    for (const p of bootstrap?.projects ?? []) {
      map.set(p.id, { name: p.name, customerName: p.customer_name })
    }
    return map
  }, [bootstrap])

  const customersById = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of bootstrap?.customers ?? []) map.set(c.id, c.name)
    return map
  }, [bootstrap])

  const rows = useMemo<OwnerInvoiceRow[]>(() => {
    const out: OwnerInvoiceRow[] = []

    for (const push of estimatePushes.data?.estimatePushes ?? []) {
      const project = projectsById.get(push.project_id)
      const clientFromCustomer = push.customer_id ? customersById.get(push.customer_id) : undefined
      out.push({
        id: push.id,
        kind: 'estimate',
        projectId: push.project_id,
        projectName: project?.name ?? shortId(push.project_id),
        clientName: clientFromCustomer ?? project?.customerName ?? '—',
        amount: Number(push.subtotal ?? 0),
        status: push.status,
        date: push.created_at,
        posted: push.status === 'posted',
      })
    }

    for (const run of billingRuns.data?.billingRuns ?? []) {
      const project = projectsById.get(run.project_id)
      const clientFromCustomer = run.customer_id ? customersById.get(run.customer_id) : undefined
      out.push({
        id: run.id,
        kind: 'rental',
        projectId: run.project_id,
        projectName: project?.name ?? shortId(run.project_id),
        clientName: clientFromCustomer ?? project?.customerName ?? '—',
        amount: Number(run.subtotal ?? 0),
        status: run.status,
        date: run.created_at,
        posted: run.status === 'posted',
      })
    }

    out.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    return out
  }, [estimatePushes.data, billingRuns.data, projectsById, customersById])

  return {
    rows,
    isLoading: estimatePushes.isLoading || billingRuns.isLoading,
    isError: estimatePushes.isError || billingRuns.isError,
    refetch: () => {
      estimatePushes.refetch()
      billingRuns.refetch()
    },
  }
}
