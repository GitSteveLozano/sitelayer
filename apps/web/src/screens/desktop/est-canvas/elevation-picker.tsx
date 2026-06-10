import { ELEVATION_TAGS, type ElevationTag } from '@/lib/takeoff/elevation'
import { type TakeoffElevation } from '@/machines/takeoff-session'

// Elevation tag picker (parity with v1 takeoff-canvas's "Elevation" card). Tags
// the next draw with a building face (N/S/E/W/roof/other) so the per-elevation
// rollup in the projects summary works. 'none' clears the tag — the machine
// stores `null`. Form-factor-agnostic chip row (CSS vars), shared by the desktop
// and mobile est-canvas bodies; the value comes from the machine's
// `draft.elevation` slice and a tap dispatches SET_ELEVATION.
export function ElevationPicker({
  value,
  onChange,
}: {
  value: TakeoffElevation | null
  onChange: (next: TakeoffElevation | null) => void
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--m-ink-3)',
        }}
      >
        Elevation
      </span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {ELEVATION_TAGS.map((t: ElevationTag) => {
          const active = t === 'none' ? value === null : value === t
          return (
            <button
              key={t}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(t === 'none' ? null : (t as TakeoffElevation))}
              style={{
                padding: '5px 10px',
                background: active ? 'var(--m-accent)' : 'transparent',
                color: active ? 'var(--m-accent-ink)' : 'var(--m-ink-2)',
                border: '2px solid var(--m-ink)',
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              {t}
            </button>
          )
        })}
      </div>
    </label>
  )
}
