/**
 * Takeoff canvas — Desktop v2 · EST 02 · "TAKEOFF CANVAS · FULL-BLEED +
 * FLOATING PALETTES" + the phone-first takeoff body.
 *
 * Phase C of the responsive consolidation: this file is now the ONE canonical
 * implementation of the takeoff/drawing surface. The exported responsive
 * `TakeoffCanvas` (and its back-compat aliases `EstCanvas` /
 * `TakeoffMobileScreen`) picks the form-factor body at the 1024px gate
 * (`useIsDesktop`), so BOTH `/desktop/canvas/:id` and the mobile
 * `/projects/:id/takeoff-mobile` route mount the same component:
 *   • `EstCanvasDesktopBody` — the full-bleed floating-palette command-center
 *     editor (calibration / SCALE overlay, conditions, copy-array-mirror, AI
 *     setup panels, marquee bulk-select, vertex edit, sheet jump, …).
 *   • `TakeoffCanvasMobileBody` — the phone manual-qty / draw / wall-height→area
 *     / CSV-import flow (folded in from the deleted
 *     `screens/mobile/takeoff-mobile.tsx` twin, behavior preserved verbatim).
 *
 * Both bodies share the same takeoff DATA + GEOMETRY: the same `lib/api` hooks,
 * the same `@sitelayer/domain` geometry helpers, the same 0–100 board-space
 * `viewBox="0 0 100 100"`, and the same `screenToBoardPoint` getScreenCTM/inverse
 * math — so rows written on either form factor are interchangeable. The
 * PlanSwift-style pan/zoom navigation layer is the shared `useCanvasViewport`
 * CAPABILITY (ON for desktop, OFF for the phone body). No takeoff logic is
 * reinvented.
 *
 * NOTE: `screens/projects/takeoff-canvas.tsx` is a DIFFERENT, still-live surface
 * (the v1 projects-tab takeoff IA — elevation tags, the four @sitelayer/pipe-*
 * capture pipelines, the AI agent-suggestions review panel, the 3D/photo/summary/
 * revision-compare cross-links). It is NOT a redundant copy of this pair and was
 * deliberately left intact in Phase C — folding its unique capabilities here is a
 * separate, larger effort. See the PR description for the rationale.
 */

import { useIsDesktop } from '@/lib/use-is-desktop'
import { EstCanvasDesktopBody } from './est-canvas/desktop-body'
import { TakeoffCanvasMobileBody } from './est-canvas/mobile-body'

// ===========================================================================
// Responsive takeoff canvas (Phase C)
// ===========================================================================
// ONE component for the takeoff/drawing surface. The desktop↔mobile twin split
// was a CAPABILITY split, not an input-model fork: both sides already share the
// 0–100 board space, the `@sitelayer/domain` geometry, the `canvas-math`
// point-mapping, and the `lib/api` data hooks, so rows are interchangeable. This
// wrapper picks the form-factor body at the same 1024px gate the rest of the
// responsive consolidation uses (`useIsDesktop`), so BOTH `/desktop/canvas/:id`
// and the mobile `/projects/:id/takeoff-mobile` route point at the single merged
// screen. The pan/zoom navigation layer lives in the shared `useCanvasViewport`
// capability hook — ON for the desktop command-center body, OFF for the
// lightweight phone body. Each body preserves every behavior of its former
// surface verbatim (the desktop floating-palette editor with calibration /
// conditions / copy-array / AI setup panels / SCALE overlay, and the phone
// manual-qty / draw / wall-height / CSV-import flow).
//
// `companySlug` is threaded through for mobile shell-prop parity; the desktop
// body resolves the project from the route param and ignores it.
export function TakeoffCanvas({ companySlug = '' }: { companySlug?: string } = {}) {
  const isDesktop = useIsDesktop()
  return isDesktop ? <EstCanvasDesktopBody /> : <TakeoffCanvasMobileBody companySlug={companySlug} />
}

// Back-compat named export: `desktop-workspace.tsx` historically imported
// `{ EstCanvas }`. It now resolves to the responsive component so the desktop
// route mounts the same merged screen (desktop body at its breakpoint).
export const EstCanvas = TakeoffCanvas

// Back-compat named export for the former `screens/mobile/takeoff-mobile.tsx`
// `{ TakeoffMobileScreen }`. The mobile route now mounts the responsive
// component, which renders the phone body below the 1024px gate.
export function TakeoffMobileScreen({ companySlug }: { companySlug: string }) {
  return <TakeoffCanvas companySlug={companySlug} />
}
