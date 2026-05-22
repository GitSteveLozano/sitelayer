/**
 * Pub/sub module for route screens to publish XState snapshots
 * into the control-plane probe's global registry.
 *
 * Design: Module-scope `Map<string, { value, publishedAt }>` that
 * route screens write to via `useControlPlaneProbePublish()` hook.
 * `ControlPlaneProbe` reads the map at `capture()` time via
 * `readProbePublishRegistry()`.
 *
 * Pattern: Same shape as `operator-context.ts`'s module-scope global.
 * Last-write-wins on key collision. Auto-cleanup on unmount.
 *
 * Why pub/sub instead of prop drilling: the xstate machines
 * (`useProjectLifecycle`, `useBillingReview`, `useTimeReview`) mount
 * per-route deeper than the `ControlPlaneProbe` (which lives at the
 * `CompanyWorkspace` level in `routes/workspace.tsx`). Threading
 * snapshots up via props would require lifting every machine to the
 * workspace and would re-instantiate them on every route change.
 * The pub/sub keeps each machine local to its screen.
 *
 * See `~/projects/digital-ontology/tab-to-task-implementation-plan-2026-05-22.md`
 * §1.9.5 for the design summary.
 */

import { useEffect, useRef } from 'react'

const probePublishRegistry = new Map<
  string,
  { value: unknown; publishedAt: number; token: symbol }
>()

/**
 * Snapshot of every key currently published. Called by
 * `ControlPlaneProbe.capture()` and folded into `page_state`.
 */
export function readProbePublishRegistry(): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, { value }] of probePublishRegistry.entries()) {
    result[key] = value
  }
  return result
}

/**
 * Metadata for diagnostics — `publishedAt` is the ms-since-epoch the
 * key was last written, `ageMs` is the elapsed time since. Returns
 * `null` when the key is absent.
 */
export function getProbePublishMetadata(
  key: string,
): { publishedAt: number; ageMs: number } | null {
  const entry = probePublishRegistry.get(key)
  if (!entry) return null
  return {
    publishedAt: entry.publishedAt,
    ageMs: Date.now() - entry.publishedAt,
  }
}

/**
 * Publish `snapshot` under `key` for the lifetime of the calling
 * component. `null` / `undefined` snapshots are skipped (so a
 * pre-load screen doesn't publish a stale absent-state). The cleanup
 * removes the key on unmount so route changes don't leak stale
 * snapshots into the probe.
 *
 * Last-write-wins: if two components publish the same key, the most
 * recent `useEffect` write overwrites. Cleanup is token-scoped so an
 * older publisher unmounting after a newer publisher has overwritten
 * the key cannot delete the newer snapshot.
 */
export function useControlPlaneProbePublish(key: string, snapshot: unknown): void {
  const tokenRef = useRef<symbol | null>(null)
  if (!tokenRef.current) tokenRef.current = Symbol('control-plane-probe-publish')

  useEffect(() => {
    const token = tokenRef.current!
    if (snapshot !== null && snapshot !== undefined) {
      probePublishRegistry.set(key, {
        value: snapshot,
        publishedAt: Date.now(),
        token,
      })
    }
    return () => {
      if (probePublishRegistry.get(key)?.token === token) {
        probePublishRegistry.delete(key)
      }
    }
  }, [key, snapshot])
}

/**
 * Test-only reset. Clears all registered keys. Production code paths
 * should rely on the per-component cleanup; this exists so unit tests
 * don't leak state between cases.
 */
export function __resetProbePublish(): void {
  probePublishRegistry.clear()
}
