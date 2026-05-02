import { useUser } from '@clerk/clerk-react'
import { isClerkConfigured } from './auth'

/**
 * The three personas Sitelayer's design is built around.
 * Mirrors `company_memberships.role` in the API (admin/foreman/office/member).
 *
 * Mapping:
 *   - admin, office  → 'owner'   (Owner / PM persona)
 *   - foreman        → 'foreman'
 *   - member         → 'worker'
 *
 * Phase 1+ will read this from the Clerk org membership; for now the
 * Phase 0 substrate falls back to a localStorage override so dev can
 * preview each persona's Home variant.
 */
export type Role = 'owner' | 'foreman' | 'worker'

const LOCAL_OVERRIDE_KEY = 'sitelayer.v2.role-override'

export function readRoleOverride(): Role | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(LOCAL_OVERRIDE_KEY)
  if (raw === 'owner' || raw === 'foreman' || raw === 'worker') return raw
  return null
}

export function writeRoleOverride(role: Role | null): void {
  if (typeof window === 'undefined') return
  if (role === null) {
    window.localStorage.removeItem(LOCAL_OVERRIDE_KEY)
  } else {
    window.localStorage.setItem(LOCAL_OVERRIDE_KEY, role)
  }
}

function membershipRoleToPersona(role: string | null | undefined): Role {
  switch (role) {
    case 'admin':
    case 'org:admin':
    case 'office':
      return 'owner'
    case 'foreman':
    case 'org:foreman':
      return 'foreman'
    default:
      return 'worker'
  }
}

/**
 * Resolve the active persona. The localStorage override always wins
 * (lets a dev flip personas without re-auth); otherwise we read the
 * primary org membership role from Clerk; otherwise default to worker.
 *
 * Note: `useUser()` is always called (rules of hooks) but only when
 * Clerk is configured — `isClerkConfigured()` is a build-time constant
 * resolved from `import.meta.env.VITE_CLERK_PUBLISHABLE_KEY`, so the
 * branch is stable across the app lifetime.
 */
export function useRole(): Role {
  if (isClerkConfigured()) {
    return useRoleWithClerk()
  }
  return useRoleWithoutClerk()
}

function useRoleWithClerk(): Role {
  const { user } = useUser()
  const override = readRoleOverride()
  if (override) return override
  const primary = user?.organizationMemberships?.[0]?.role
  return membershipRoleToPersona(primary)
}

function useRoleWithoutClerk(): Role {
  const override = readRoleOverride()
  if (override) return override
  return 'worker'
}
