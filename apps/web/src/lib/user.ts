import { useUser } from '@clerk/clerk-react'
import { isClerkConfigured } from './auth'

/**
 * Resolve the signed-in user's first name for greeting copy
 * ("Good morning, Mike."). Falls back to a generic friendly form when
 * Clerk isn't configured (local dev) or when no name is set yet.
 *
 * Same hook-shape contract as `useRole()` — `isClerkConfigured()` is a
 * build-time constant so the branch is stable for the app lifetime.
 */
export function useFirstName(): string | null {
  if (isClerkConfigured()) {
    return useFirstNameWithClerk()
  }
  return null
}

function useFirstNameWithClerk(): string | null {
  const { user } = useUser()
  if (!user) return null
  if (user.firstName && user.firstName.trim()) return user.firstName.trim()
  if (user.fullName && user.fullName.trim()) {
    const first = user.fullName.trim().split(/\s+/)[0]
    if (first) return first
  }
  return null
}

/**
 * Resolve the signed-in user's full display name ("Mike Davis") for the
 * avatar-dropdown identity header. Falls back to `null` when Clerk isn't
 * configured (local dev) or no name is set yet, so callers can default to
 * the company mark. Same hook-shape contract as `useFirstName()`.
 */
export function useUserFullName(): string | null {
  if (isClerkConfigured()) {
    return useUserFullNameWithClerk()
  }
  return null
}

function useUserFullNameWithClerk(): string | null {
  const { user } = useUser()
  if (!user) return null
  if (user.fullName && user.fullName.trim()) return user.fullName.trim()
  const first = user.firstName?.trim() ?? ''
  const last = user.lastName?.trim() ?? ''
  const joined = `${first} ${last}`.trim()
  return joined || null
}

/**
 * Resolve the signed-in user's avatar initials ("MD" for Mike Davis) for the
 * topbar avatar square. Falls back to `null` when Clerk isn't configured
 * (local dev) or no name is set yet, so callers can default to the company
 * mark. Same hook-shape contract as `useFirstName()`.
 */
export function useUserInitials(): string | null {
  if (isClerkConfigured()) {
    return useUserInitialsWithClerk()
  }
  return null
}

function useUserInitialsWithClerk(): string | null {
  const { user } = useUser()
  if (!user) return null
  const first = user.firstName?.trim() ?? ''
  const last = user.lastName?.trim() ?? ''
  if (first || last) {
    return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase() || null
  }
  const full = user.fullName?.trim()
  if (full) {
    const parts = full.split(/\s+/).filter(Boolean)
    const initials = `${parts[0]?.charAt(0) ?? ''}${parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : ''}`
    return initials.toUpperCase() || null
  }
  return null
}

/**
 * Resolve the signed-in user's sign-in email from the Clerk session for the
 * Settings → Profile identity card. Falls back to `null` when Clerk isn't
 * configured (local dev) or no email is on the account, so callers render an
 * honest "—" instead of a fabricated address. Same hook-shape contract as
 * `useFirstName()`.
 */
export function useUserEmail(): string | null {
  if (isClerkConfigured()) {
    return useUserEmailWithClerk()
  }
  return null
}

function useUserEmailWithClerk(): string | null {
  const { user } = useUser()
  if (!user) return null
  const primary = user.primaryEmailAddress?.emailAddress?.trim()
  if (primary) return primary
  const first = user.emailAddresses?.[0]?.emailAddress?.trim()
  return first || null
}

/**
 * Time-of-day greeting word ("morning" / "afternoon" / "evening").
 * Used by the PM busy-day header per Sitemap §03 panel 1.
 */
export function greetingWord(date: Date = new Date()): 'morning' | 'afternoon' | 'evening' {
  const h = date.getHours()
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}
