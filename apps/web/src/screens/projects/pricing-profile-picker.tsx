import { useEffect, useMemo } from 'react'
import { usePricingProfiles, type PricingProfile } from '@/lib/api'
import { useActivePricingProfileId } from '@/lib/active-pricing-profile'
import { getActiveCompanySlug } from '@/lib/api/client'

/**
 * Pricing-profile picker for the estimate header.
 *
 * Drives the "which profile feeds the markup breakdown" choice. The
 * selected profile id is persisted in localStorage (see
 * `lib/active-pricing-profile.ts`) so the estimator's pick survives a
 * reload and propagates to every estimate-line breakdown panel.
 *
 * When no profile is explicitly pinned, the company's default profile
 * (`is_default = true`, seeded by `seedCompanyDefaults`) is implicitly
 * active and surfaced as the selected option.
 */

export interface PricingProfilePickerProps {
  /**
   * Called when the resolved profile changes. The parent can capture it
   * to feed into the breakdown components without re-running the query.
   * Optional — the picker is otherwise self-contained.
   */
  onProfileResolved?: (profile: PricingProfile | null) => void
}

export function PricingProfilePicker({ onProfileResolved }: PricingProfilePickerProps) {
  const profiles = usePricingProfiles()
  const companySlug = getActiveCompanySlug()
  const [pinnedId, setPinnedId] = useActivePricingProfileId(companySlug)

  const list = profiles.data?.pricingProfiles ?? []
  const defaultProfile = list.find((p) => p.is_default) ?? list[0] ?? null

  // Effective pinned profile: prefer the localStorage pin if it still
  // points at an existing row, otherwise fall back to the default.
  const effective = useMemo<PricingProfile | null>(() => {
    if (pinnedId) {
      const found = list.find((p) => p.id === pinnedId)
      if (found) return found
    }
    return defaultProfile
  }, [pinnedId, list, defaultProfile])

  useEffect(() => {
    onProfileResolved?.(effective)
  }, [effective, onProfileResolved])

  // If the pin points at a profile that's been deleted, clear it so a
  // stale id doesn't keep haunting the picker UI.
  useEffect(() => {
    if (!pinnedId) return
    if (!profiles.data) return
    if (!list.find((p) => p.id === pinnedId)) {
      setPinnedId(null)
    }
  }, [pinnedId, profiles.data, list, setPinnedId])

  if (profiles.isPending) {
    return <div className="text-[11px] text-ink-3">Loading pricing profiles…</div>
  }

  if (list.length === 0) {
    return (
      <div className="text-[11px] text-ink-3" data-testid="pricing-profile-picker-empty">
        No pricing profiles — using zero markup.
      </div>
    )
  }

  return (
    <label className="flex items-center gap-1.5 text-[11px] text-ink-3" data-testid="pricing-profile-picker">
      <span className="text-[10px] font-semibold uppercase tracking-[0.06em]">Pricing</span>
      <select
        aria-label="Active pricing profile"
        value={effective?.id ?? ''}
        onChange={(e) => {
          const next = e.target.value
          if (!next) {
            setPinnedId(null)
            return
          }
          if (defaultProfile && next === defaultProfile.id) {
            // Pinning the default is the same as no pin — keep storage clean.
            setPinnedId(null)
          } else {
            setPinnedId(next)
          }
        }}
        className="px-1.5 py-1 rounded border border-line bg-card text-[11.5px] font-medium text-ink-1 focus:outline-none focus:border-accent"
      >
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.is_default ? ' (default)' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
