import type { FeaturesResponse } from '../api.js'

export function EnvironmentRibbon({ features }: { features: FeaturesResponse | null }) {
  if (!features || !features.ribbon) return null
  const flagText = features.flags.length > 0 ? ` · flags: ${features.flags.join(', ')}` : ''
  return (
    <div className="environmentRibbon" data-tone={features.ribbon.tone} role="status">
      {features.ribbon.label}
      <span>{flagText}</span>
    </div>
  )
}
