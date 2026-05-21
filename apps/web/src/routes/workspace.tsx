import { useEffect, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ColdStartSplash } from '@/components/shell/ColdStartSplash'
import {
  ApiError,
  getActiveCompanySlug,
  queryKeys,
  request,
  setActiveCompanySlug,
  type BootstrapResponse,
  type SessionResponse,
} from '@/lib/api'
import { ACTIVE_COMPANY_STORAGE_KEY } from '@/lib/api/client'
import { normalizeMobileShellRole } from '@/lib/active-context'
import { membershipRoleToPersona, RoleContext } from '@/lib/role'
import { MobileShell } from '@/screens/mobile-shell'

type MembershipRow = {
  company_id: string
  company_slug: string
  company_name: string
  role: string
}

type MembershipsResponse = {
  memberships: MembershipRow[]
}

type ActiveCompany = {
  id: string
  slug: string
  name: string
  role: string
}

/**
 * Authenticated workspace entry.
 *
 * The old root went straight at `/api/bootstrap` for `la-operations`.
 * That was fine for a demo tenant, but a real multi-company app needs to
 * resolve the caller's memberships first. The canonical role shell still
 * owns navigation: admins land in admin mode, and field-only users stay in
 * foreman/worker mode.
 */
export default function WorkspaceRoute() {
  const membershipsQuery = useQuery({
    queryKey: ['me', 'memberships', 'workspace'],
    queryFn: () => request<MembershipsResponse>('/api/me/memberships'),
    staleTime: 5 * 60_000,
  })

  const activeCompany = useMemo<ActiveCompany | null>(() => {
    const memberships = membershipsQuery.data?.memberships ?? []
    if (memberships.length === 0) return null
    const requestedSlug = getActiveCompanySlug()
    const active = memberships.find((membership) => membership.company_slug === requestedSlug) ?? memberships[0]
    if (!active) return null
    return {
      id: active.company_id,
      slug: active.company_slug,
      name: active.company_name,
      role: active.role,
    }
  }, [membershipsQuery.data?.memberships])

  useEffect(() => {
    if (activeCompany) {
      persistActiveCompanySlug(activeCompany.slug)
    }
  }, [activeCompany])

  if (membershipsQuery.isPending) return <ColdStartSplash />
  if (membershipsQuery.error) return <WorkspaceLoadError error={membershipsQuery.error} />
  if (!activeCompany) return <Navigate to="/onboarding" replace />

  return <CompanyWorkspace activeCompany={activeCompany} />
}

function CompanyWorkspace({ activeCompany }: { activeCompany: ActiveCompany }) {
  const companySlug = activeCompany.slug

  const bootstrapQuery = useQuery({
    queryKey: queryKeys.bootstrap(companySlug),
    queryFn: () => request<BootstrapResponse>('/api/bootstrap', { companySlug }),
  })

  const sessionQuery = useQuery({
    queryKey: queryKeys.session(companySlug),
    queryFn: () => request<SessionResponse>('/api/session', { companySlug }),
  })

  const error = bootstrapQuery.error ?? sessionQuery.error
  if (needsOnboarding(error)) return <Navigate to="/onboarding" replace />
  if (error) return <WorkspaceLoadError error={error} />

  const session = sessionQuery.data ?? null
  const sessionRole =
    session?.memberships?.find((membership) => membership.slug === companySlug)?.role ??
    activeCompany.role ??
    session?.user?.role ??
    null
  const companyRole = normalizeMobileShellRole(sessionRole)
  const persona = companyRole === 'admin' || companyRole === 'office' ? 'owner' : membershipRoleToPersona(companyRole)

  if (bootstrapQuery.isPending || sessionQuery.isPending) return <ColdStartSplash />

  return (
    <RoleContext.Provider value={persona}>
      <MobileShell
        bootstrap={bootstrapQuery.data ?? null}
        companyRole={companyRole}
        companySlug={companySlug}
        currentUserId={session?.user.id ?? null}
      />
    </RoleContext.Provider>
  )
}

function persistActiveCompanySlug(slug: string): void {
  setActiveCompanySlug(slug)
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ACTIVE_COMPANY_STORAGE_KEY, slug)
  } catch {
    // localStorage is best-effort only; module state still keeps this render coherent.
  }
}

function needsOnboarding(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    error.body !== null &&
    typeof error.body === 'object' &&
    'error' in error.body &&
    typeof (error.body as { error: unknown }).error === 'string' &&
    /company slug.*not found|requires_onboarding/i.test((error.body as { error: string }).error)
  )
}

function WorkspaceLoadError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error)
  return <div className="p-4 text-[12px] text-bad">Failed to load workspace: {message}</div>
}
