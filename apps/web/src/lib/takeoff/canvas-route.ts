import { useIsDesktop } from '@/lib/use-is-desktop'

/**
 * Canonical entry to the consolidated est-canvas takeoff editor.
 *
 * Desktop resolves to the `/desktop` command-center canvas; mobile to the
 * mobile-shell canvas. BOTH routes mount the same responsive `TakeoffCanvas`
 * (`screens/desktop/est-canvas`), which picks the form-factor body at the
 * 1024px gate (`useIsDesktop`) — so a row drawn either way is interchangeable.
 *
 * This is the single source of truth for where "open the takeoff canvas"
 * navigation lands. The v1 `screens/projects/takeoff-canvas` editor was
 * RETIRED (deleted) on 2026-06-12 — consolidation Phase 3 close-out. Its old
 * `/projects/:id/takeoff-canvas` deep-link redirects through this same seam
 * (`LegacyTakeoffCanvasRedirect` in App.tsx), so saved URLs land on the
 * canonical est-canvas editor. See docs/TAKEOFF_CANVAS_CONSOLIDATION_PLAN.md.
 */
export function takeoffCanvasPath(projectId: string, isDesktop: boolean): string {
  return isDesktop ? `/desktop/canvas/${projectId}` : `/projects/${projectId}/takeoff-mobile`
}

/** Hook form: resolves the takeoff-canvas path for the current viewport. */
export function useTakeoffCanvasPath(): (projectId: string) => string {
  const isDesktop = useIsDesktop()
  return (projectId: string) => takeoffCanvasPath(projectId, isDesktop)
}
