/**
 * Multi-company switcher for users who belong to more than one company
 * (e.g. a sub-contractor billing multiple general contractors). Mounts
 * in the mobile-shell header and renders nothing for single-company
 * users so the chrome stays minimal.
 *
 * Data flow:
 *   1. Fetch `/api/me/memberships` via TanStack Query. The endpoint runs
 *      at the pool (pre-tenancy context); migration 066's IS NULL
 *      fallback policy on company_memberships permits the read across
 *      companies for a given clerk user.
 *   2. If < 2 memberships, render nothing.
 *   3. Otherwise render an `<MSelect>` showing the active slug.
 *   4. On change, write the new slug to localStorage and reload the
 *      page so every TanStack Query cache + XState machine re-bootstraps
 *      against the new company. This mirrors the dev RoleSwitcher
 *      pattern — a full client-side context refactor is out of scope
 *      for this slice.
 *
 * Why a reload rather than a context bump:
 *   - `getActiveCompanySlug()` is read by `buildAuthHeaders` and pinned
 *     into TanStack Query keys, useQuery deps, and XState invocation
 *     inputs in many places. A reload guarantees every cached resolver
 *     re-evaluates against the new slug without us having to thread
 *     invalidations through every machine.
 *   - The user opens this switcher rarely (once per session, when they
 *     change tenant). A full reload is fine UX for that frequency.
 */
import { useQuery } from '@tanstack/react-query'
import { ACTIVE_COMPANY_STORAGE_KEY, getActiveCompanySlug, request } from '@/lib/api/client'

export interface MembershipRow {
  company_id: string
  company_slug: string
  company_name: string
  role: string
}

export interface MembershipsResponse {
  memberships: MembershipRow[]
}

const QUERY_KEY = ['me', 'memberships'] as const

export function CompanySwitcher() {
  const query = useQuery<MembershipsResponse>({
    queryKey: QUERY_KEY,
    queryFn: () => request<MembershipsResponse>('/api/me/memberships'),
    // The membership set is durable — a user joining or leaving a
    // company is rare relative to a session. Cache for the session.
    staleTime: 5 * 60_000,
  })

  const memberships = query.data?.memberships ?? []

  // Single-company users (the overwhelming majority on the pilot tier)
  // see nothing — the switcher only earns a header slot when there's
  // an actual choice to make.
  if (memberships.length < 2) {
    return null
  }

  const activeSlug = getActiveCompanySlug()
  // If the persisted active slug isn't in the membership list (e.g. a
  // user was removed from a company they had pinned), select the first
  // available so the dropdown still reflects something coherent. The
  // next API call surfaces the mismatch as a 404 and the SPA bounces
  // through onboarding the same way a first-time user does.
  const fallbackSlug = memberships[0]!.company_slug
  const selectedSlug = memberships.find((m) => m.company_slug === activeSlug) ? activeSlug : fallbackSlug

  const onChange = (nextSlug: string) => {
    if (!nextSlug || nextSlug === selectedSlug) return
    try {
      window.localStorage.setItem(ACTIVE_COMPANY_STORAGE_KEY, nextSlug)
    } catch {
      // localStorage can throw in private-browsing / sandboxed iframes.
      // Without it we can't persist the switch across the reload, so
      // bail rather than reloading into the old company silently. The
      // user will see no state change and can try again.
      console.warn('[CompanySwitcher] localStorage unavailable; cannot persist company switch')
      return
    }
    window.location.reload()
  }

  return (
    <div
      data-testid="company-switcher"
      style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--m-line)',
        background: 'var(--m-bg)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <label
        htmlFor="company-switcher-select"
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: 'var(--m-ink-3, #aea69a)',
        }}
      >
        Company
      </label>
      <select
        id="company-switcher-select"
        data-testid="company-switcher-select"
        value={selectedSlug}
        onChange={(e) => onChange(e.target.value)}
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          padding: '4px 8px',
          border: '2px solid var(--m-ink)',
          background: 'var(--m-surface, #ffffff)',
          color: 'var(--m-ink, #1a1a1a)',
        }}
      >
        {memberships.map((m) => (
          <option key={m.company_id} value={m.company_slug} data-testid={`company-switcher-option-${m.company_slug}`}>
            {m.company_name} ({m.role})
          </option>
        ))}
      </select>
    </div>
  )
}
