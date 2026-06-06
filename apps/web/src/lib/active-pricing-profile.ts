import { useCallback, useEffect, useState } from 'react'

/**
 * Per-company active pricing profile pin (the "which profile drives
 * the markup math" choice). Lives in localStorage so the choice
 * survives reloads and offline boots without requiring a server-side
 * column on `companies` or `projects`. The estimate-builder reads this
 * to pick which `pricing_profiles.config` row to feed into
 * `applyMarkup` for the transparent breakdown panel.
 *
 * When no pin exists the consumer is expected to fall back to the
 * company's `is_default = true` row (set in `seedCompanyDefaults`).
 *
 * Scope: company-keyed so the same browser logged into two companies
 * doesn't bleed pricing-profile preference across them.
 */
const KEY_PREFIX = 'sitelayer.v2.active-pricing-profile-id::'

function buildKey(companySlug: string): string {
  return `${KEY_PREFIX}${companySlug}`
}

export function readActivePricingProfileId(companySlug: string): string | null {
  if (typeof window === 'undefined' || !companySlug) return null
  try {
    return window.localStorage.getItem(buildKey(companySlug))
  } catch {
    return null
  }
}

export function writeActivePricingProfileId(companySlug: string, id: string | null): void {
  if (typeof window === 'undefined' || !companySlug) return
  try {
    if (id === null) {
      window.localStorage.removeItem(buildKey(companySlug))
    } else {
      window.localStorage.setItem(buildKey(companySlug), id)
    }
    window.dispatchEvent(new CustomEvent('sitelayer:active-pricing-profile-change'))
  } catch {
    /* ignore quota / disabled-storage — UX falls back to default profile */
  }
}

export function useActivePricingProfileId(companySlug: string): [string | null, (id: string | null) => void] {
  const [id, setId] = useState<string | null>(() => readActivePricingProfileId(companySlug))

  useEffect(() => {
    setId(readActivePricingProfileId(companySlug))
    if (typeof window === 'undefined') return
    const sync = () => setId(readActivePricingProfileId(companySlug))
    window.addEventListener('storage', sync)
    window.addEventListener('sitelayer:active-pricing-profile-change', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('sitelayer:active-pricing-profile-change', sync)
    }
  }, [companySlug])

  const setActiveId = useCallback(
    (next: string | null) => {
      writeActivePricingProfileId(companySlug, next)
      setId(next)
    },
    [companySlug],
  )

  return [id, setActiveId]
}
