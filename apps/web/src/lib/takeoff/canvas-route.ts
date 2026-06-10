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
 * navigation lands. The v1 `screens/projects/takeoff-canvas` editor is no
 * longer a navigation target (de-fork, Phase 0); routing every entry through
 * here keeps the eventual Phase 3 retirement of that surface a one-file change.
 * See docs/TAKEOFF_CANVAS_CONSOLIDATION_PLAN.md.
 */
export function takeoffCanvasPath(projectId: string, isDesktop: boolean): string {
  return isDesktop ? `/desktop/canvas/${projectId}` : `/projects/${projectId}/takeoff-mobile`
}

/** Hook form: resolves the takeoff-canvas path for the current viewport. */
export function useTakeoffCanvasPath(): (projectId: string) => string {
  const isDesktop = useIsDesktop()
  return (projectId: string) => takeoffCanvasPath(projectId, isDesktop)
}
