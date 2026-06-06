import { afterEach, describe, expect, it } from 'vitest'
import { applyTierRobotsNoIndex, isDemoTier } from './robots-noindex'

const META_ID = 'sitelayer-tier-robots-noindex'

function currentMeta(): HTMLMetaElement | null {
  return document.getElementById(META_ID) as HTMLMetaElement | null
}

afterEach(() => {
  currentMeta()?.remove()
})

describe('isDemoTier', () => {
  it('is true only for the demo tier (case/space-insensitive)', () => {
    expect(isDemoTier('demo')).toBe(true)
    expect(isDemoTier('  DEMO  ')).toBe(true)
  })

  it('is false for every other tier and for unset', () => {
    for (const tier of ['prod', 'preview', 'dev', 'local', '', undefined]) {
      expect(isDemoTier(tier), `tier ${String(tier)}`).toBe(false)
    }
  })
})

describe('applyTierRobotsNoIndex', () => {
  it('installs a site-wide noindex,nofollow meta tag on the demo tier', () => {
    const installed = applyTierRobotsNoIndex('demo')
    expect(installed).toBe(true)
    const meta = currentMeta()
    expect(meta).not.toBeNull()
    expect(meta?.getAttribute('name')).toBe('robots')
    expect(meta?.getAttribute('content')).toBe('noindex, nofollow')
  })

  it('does NOT install the tag on prod (keeps prod indexable)', () => {
    const installed = applyTierRobotsNoIndex('prod')
    expect(installed).toBe(false)
    expect(currentMeta()).toBeNull()
  })

  it('does NOT install the tag on dev/preview/local', () => {
    for (const tier of ['dev', 'preview', 'local']) {
      expect(applyTierRobotsNoIndex(tier), `tier ${tier}`).toBe(false)
      expect(currentMeta(), `tier ${tier}`).toBeNull()
    }
  })

  it('is idempotent — a second call does not duplicate the tag', () => {
    applyTierRobotsNoIndex('demo')
    applyTierRobotsNoIndex('demo')
    expect(document.querySelectorAll(`#${META_ID}`)).toHaveLength(1)
  })

  it('removes a stale tag if the tier flips away from demo', () => {
    applyTierRobotsNoIndex('demo')
    expect(currentMeta()).not.toBeNull()
    // Simulate a redeploy where the same document is reused on a non-demo tier.
    applyTierRobotsNoIndex('prod')
    expect(currentMeta()).toBeNull()
  })

  it('is a no-op (returns false) when there is no document (SSR / non-DOM)', () => {
    expect(applyTierRobotsNoIndex('demo', null)).toBe(false)
  })
})
