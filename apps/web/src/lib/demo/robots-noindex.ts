/**
 * Site-wide robots `noindex` for the demo tier.
 *
 * The demo tier (`VITE_APP_TIER=demo`, demo.preview.sitelayer.sandolab.xyz) is
 * a public showcase seeded with sample data. It must NEVER be indexed by search
 * engines — otherwise the demo's fake company / projects would leak into search
 * results and could outrank or be confused with the real product.
 *
 * The `/demo` landing screen already installs a route-scoped meta tag and the
 * API stamps `X-Robots-Tag: noindex` on `/api/demo/*`, but those only cover two
 * surfaces. This installs a `<meta name="robots" content="noindex, nofollow">`
 * on the document head for the WHOLE SPA the moment the app boots, so every
 * route on the demo deployment is excluded — not just `/demo`.
 *
 * Tier-gated by build-time `import.meta.env.VITE_APP_TIER`. On prod (and any
 * other tier) this is a no-op: the prod marketing/app surface stays indexable.
 * The check is structural — there is no runtime toggle that can turn indexing
 * back on for the demo tier.
 */

const NOINDEX_META_ID = 'sitelayer-tier-robots-noindex'

/**
 * Pure predicate: is the running build the demo tier? Exported for tests so the
 * tier gate is provable without depending on global `import.meta.env`.
 */
export function isDemoTier(tier: string | undefined): boolean {
  return (tier ?? '').trim().toLowerCase() === 'demo'
}

/**
 * Install (or remove) the site-wide noindex meta tag based on the tier.
 *
 * - On the demo tier: ensure a single `<meta name="robots" noindex,nofollow>`
 *   exists in `<head>`. Idempotent — calling twice does not duplicate the tag.
 * - On any other tier: leave the head untouched (and remove a stale tag if one
 *   somehow exists, so a tier flip can't strand an indexing block).
 *
 * `doc` is injectable so tests can drive a JSDOM document, or pass `null` to
 * exercise the SSR / non-DOM no-op path. When `doc` is omitted it resolves the
 * ambient `document` (and is a no-op when there is none).
 */
export function applyTierRobotsNoIndex(tier: string | undefined, doc?: Document | null): boolean {
  const resolved: Document | null = doc !== undefined ? doc : typeof document === 'undefined' ? null : document
  if (!resolved) return false
  const existing = resolved.getElementById(NOINDEX_META_ID) as HTMLMetaElement | null

  if (!isDemoTier(tier)) {
    if (existing?.parentNode) existing.parentNode.removeChild(existing)
    return false
  }

  if (existing) {
    existing.setAttribute('content', 'noindex, nofollow')
    return true
  }
  const meta = resolved.createElement('meta')
  meta.id = NOINDEX_META_ID
  meta.setAttribute('name', 'robots')
  meta.setAttribute('content', 'noindex, nofollow')
  resolved.head.appendChild(meta)
  return true
}

/**
 * Boot hook called once from `main.tsx`. Reads the build-time tier from
 * `import.meta.env.VITE_APP_TIER` and installs the noindex tag when on demo.
 */
export function installDemoTierNoIndex(): void {
  applyTierRobotsNoIndex(import.meta.env.VITE_APP_TIER as string | undefined)
}
