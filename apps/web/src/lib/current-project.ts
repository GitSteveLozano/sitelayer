import { useCallback, useEffect, useState } from 'react'

/**
 * Persists the user's "current" project — the one the drawer header
 * and project switcher sheet (Sitemap §02 panel 4) revolve around.
 *
 * This isn't a routing concept: a user can navigate to any project
 * via `/projects/:id` regardless of what's pinned here. The switcher
 * is a fast-path to a project the user has marked as primary.
 *
 * Backed by localStorage so the choice survives reloads and offline
 * boots. Listens for the cross-tab `storage` event so two open tabs
 * stay aligned.
 */
const KEY = 'sitelayer.v2.current-project-id'

export function readCurrentProjectId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function writeCurrentProjectId(id: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (id === null) {
      window.localStorage.removeItem(KEY)
    } else {
      window.localStorage.setItem(KEY, id)
    }
    // Same-tab listeners need a manual nudge — the `storage` event
    // only fires in *other* tabs.
    window.dispatchEvent(new CustomEvent('sitelayer:current-project-change'))
  } catch {
    /* ignore quota / disabled-storage failures — UX falls back to no pin */
  }
}

export function useCurrentProjectId(): [string | null, (id: string | null) => void] {
  const [id, setId] = useState<string | null>(() => readCurrentProjectId())

  useEffect(() => {
    if (typeof window === 'undefined') return
    const sync = () => setId(readCurrentProjectId())
    window.addEventListener('storage', sync)
    window.addEventListener('sitelayer:current-project-change', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('sitelayer:current-project-change', sync)
    }
  }, [])

  const setCurrentProjectId = useCallback((next: string | null) => {
    writeCurrentProjectId(next)
    setId(next)
  }, [])

  return [id, setCurrentProjectId]
}
