// Assembly drill-down hooks for the Estimate Builder line-item expand panel.
//
// `apps/web/src/lib/api/takeoff.ts` already exposes `useAssembly(id)` which
// loads a single assembly by uuid plus its components. The Estimate Builder
// works the other direction — given a `service_item_code` for an estimate
// line, surface the underlying assembly (materials, labor, waste %, margin)
// without forcing the caller to look up the uuid first.
//
// GET /api/assemblies?service_item_code=X returns the list; we take the
// most recently-created entry as the "current" assembly for that code (the
// API orders by `created_at desc` for that filter — see assemblies.ts).
// When that returns at least one assembly we re-use the existing detail
// hook to fetch components.

import { useQuery } from '@tanstack/react-query'
import { request } from './client'
import type { Assembly, AssemblyComponent } from './takeoff'

const KEYS = {
  byServiceItem: (code: string) => ['assemblies', 'by-service-item', code] as const,
  detailFromCode: (code: string) => ['assemblies', 'by-service-item', code, 'detail'] as const,
}

export const assemblyQueryKeys = KEYS

interface AssemblyListResponse {
  assemblies: Assembly[]
}

interface AssemblyDetailResponse {
  assembly: Assembly
  components: AssemblyComponent[]
}

/**
 * Fetch the current assembly for a service-item-code in a single call.
 * Returns `null` (not an error) if no assembly is configured for the code
 * — the Estimate Builder uses that to show an inline "no assembly defined"
 * fallback in the drill-down rather than a hard error.
 */
export function useAssemblyByServiceItem(code: string | null | undefined) {
  return useQuery<AssemblyDetailResponse | null>({
    queryKey: KEYS.detailFromCode(code ?? ''),
    queryFn: async () => {
      const list = await request<AssemblyListResponse>(`/api/assemblies?service_item_code=${encodeURIComponent(code!)}`)
      const head = list.assemblies[0]
      if (!head) return null
      return request<AssemblyDetailResponse>(`/api/assemblies/${encodeURIComponent(head.id)}`)
    },
    enabled: Boolean(code),
    // Assemblies don't change line-by-line during an editing session;
    // a 5-minute stale window matches the service-items hook so the
    // drill-down stays responsive even when the estimator opens many
    // rows in a row.
    staleTime: 5 * 60_000,
  })
}

export type { Assembly, AssemblyComponent }
