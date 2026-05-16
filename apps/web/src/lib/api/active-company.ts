/**
 * Active company helpers — pulls the current bootstrap response out of the
 * TanStack Query cache so screens can grab the active company id without
 * threading it through props.
 *
 * Use sparingly. Screens already inside a feature that always renders
 * inside the mobile shell (which loads bootstrap) can rely on this. Pages
 * that pre-shell (sign-in, marketing) cannot.
 */
import { useQueryClient } from '@tanstack/react-query'
import type { BootstrapResponse } from '../../api-v1-compat'
import { getActiveCompanySlug } from './client'
import { queryKeys } from './keys'
import { useCompanyModules, type CompanyModulesResponse } from './companies'

export function useActiveCompanyId(): string | null {
  const qc = useQueryClient()
  const slug = getActiveCompanySlug() || 'la-operations'
  const data = qc.getQueryData<BootstrapResponse>(queryKeys.bootstrap(slug))
  return data?.company?.id ?? null
}

/**
 * Reads the active company's module flags through the existing
 * useCompanyModules query. Returns `null` while loading / not authed.
 */
export function useActiveCompanyModules(): CompanyModulesResponse | null {
  const id = useActiveCompanyId()
  const query = useCompanyModules(id)
  if (!id || !query.data) return null
  return query.data
}
