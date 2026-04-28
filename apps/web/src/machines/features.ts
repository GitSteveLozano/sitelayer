import { useEffect, useState } from 'react'
import { apiGet, type FeaturesResponse } from '../api.js'

/**
 * Fetch /api/features for the given company slug. Best-effort — the
 * environment ribbon is the only consumer, so a failed fetch silently
 * resolves to `null` rather than surfacing an error.
 *
 * Refetches whenever `companySlug` changes; cancels in-flight responses
 * on unmount or slug change so a slow request from the previous slug
 * can't overwrite fresh data.
 */
export function useFeatures(companySlug: string): FeaturesResponse | null {
  const [features, setFeatures] = useState<FeaturesResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    apiGet<FeaturesResponse>('/api/features', companySlug)
      .then((data) => {
        if (!cancelled) setFeatures(data)
      })
      .catch(() => {
        /* ribbon is best-effort; don't block app */
      })
    return () => {
      cancelled = true
    }
  }, [companySlug])

  return features
}
