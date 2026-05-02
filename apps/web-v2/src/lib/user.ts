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
 * Time-of-day greeting word ("morning" / "afternoon" / "evening").
 * Used by the PM busy-day header per Sitemap §03 panel 1.
 */
export function greetingWord(date: Date = new Date()): 'morning' | 'afternoon' | 'evening' {
  const h = date.getHours()
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}
