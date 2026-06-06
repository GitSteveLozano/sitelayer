/**
 * `splash-cold-start` — Sitemap §1 panel 5.
 *
 * Branded splash shown during initial app load and as the lazy-route
 * Suspense fallback. v2 brutalist (matches V2StateSplash in the design
 * handoff): full-bleed ACCENT background, square ink "SL" block, big
 * "SITELAYER." display lockup + "RUN THE DAY." mono tagline, a faint
 * diagonal-hatch backdrop, and a square pulsing loading indicator with
 * the status line at the bottom.
 *
 * Colors come from the `--m-*` tokens. The accent surface is identical in
 * the worker dark theme (`.m-dark` keeps `--m-accent` yellow with the
 * same `--m-ink`/`--m-accent-ink` contrast), so the splash reads correctly
 * whether or not it's mounted inside a `.m-dark` shell wrapper.
 *
 * Stays inert when the user is already past first-load — App.tsx
 * decides when to swap it out.
 */
export interface ColdStartSplashProps {
  /** Override the status line. Defaults to "Syncing to projects · offline ready". */
  status?: string
}

export function ColdStartSplash({ status = 'Syncing to projects · offline ready' }: ColdStartSplashProps) {
  return (
    <div className="min-h-dvh flex flex-col" style={{ background: 'var(--m-accent)', color: 'var(--m-accent-ink)' }}>
      <div
        className="flex-1 flex flex-col justify-center px-8 relative overflow-hidden"
        style={{ position: 'relative' }}
      >
        {/* Faint diagonal hatch backdrop. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            opacity: 0.08,
            backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 22px, var(--m-ink) 22px 26px)',
          }}
        />
        <div style={{ position: 'relative' }}>
          {/* Square SL block — ink fill, accent monogram. */}
          <div
            style={{
              width: 72,
              height: 72,
              background: 'var(--m-ink)',
              color: 'var(--m-accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--m-font-display)',
              fontWeight: 900,
              fontSize: 32,
              letterSpacing: '-0.04em',
            }}
          >
            SL
          </div>
          <h1
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 64,
              lineHeight: 0.85,
              letterSpacing: '-0.04em',
              color: 'var(--m-accent-ink)',
              marginTop: 36,
            }}
          >
            SITELAYER.
          </h1>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 13,
              marginTop: 16,
              color: 'var(--m-accent-ink)',
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            Run the day.
          </div>
        </div>
      </div>

      <div
        className="flex items-center gap-2.5"
        style={{
          padding: '20px 24px calc(env(safe-area-inset-bottom, 0px) + 20px)',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 10,
            height: 10,
            background: 'var(--m-ink)',
            animation: 'm-pulse 1s infinite',
            flexShrink: 0,
          }}
        />
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--m-accent-ink)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          {status}
        </div>
      </div>
    </div>
  )
}
