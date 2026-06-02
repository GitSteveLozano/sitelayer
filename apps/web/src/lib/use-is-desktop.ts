import { useEffect, useState } from 'react'

/**
 * True when the viewport is desktop-width (>=1024px) — the same 1024px gate
 * `routes/workspace.tsx` uses to pick the Desktop v2 shell.
 *
 * Responsive-consolidation (Phase B) screens that fold a desktop↔mobile twin
 * pair into ONE file use this to choose which composition to mount, so the
 * route table can point both the `/desktop/*` and the root mobile route at the
 * single merged screen. SSR-safe (returns false until mounted) and tracks live
 * viewport resizes via a `matchMedia` change listener.
 */
export function useIsDesktop(): boolean {
  const query = '(min-width: 1024px)'
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    setIsDesktop(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return isDesktop
}
