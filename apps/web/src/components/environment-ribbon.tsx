import type { FeaturesResponse } from '../api.js'

const RIBBON_COLORS: Record<'info' | 'warn' | 'danger', { bg: string; fg: string }> = {
  info: { bg: '#1e40af', fg: '#ffffff' },
  warn: { bg: '#b45309', fg: '#ffffff' },
  danger: { bg: '#b91c1c', fg: '#ffffff' },
}

export function EnvironmentRibbon({ features }: { features: FeaturesResponse | null }) {
  if (!features || !features.ribbon) return null
  const colors = RIBBON_COLORS[features.ribbon.tone]
  const flagText = features.flags.length > 0 ? ` · flags: ${features.flags.join(', ')}` : ''
  return (
    <div
      role="status"
      style={{
        background: colors.bg,
        color: colors.fg,
        padding: '6px 12px',
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: 0.3,
        textAlign: 'center',
      }}
    >
      {features.ribbon.label}
      <span style={{ fontWeight: 400, opacity: 0.9 }}>{flagText}</span>
    </div>
  )
}
