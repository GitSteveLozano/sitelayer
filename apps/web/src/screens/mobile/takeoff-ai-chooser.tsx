/**
 * `mb-takeoff-ai-chooser` — mobile AI-takeoff launch chooser.
 *
 * Ported from Steve's v2 master-flow mockup `V2AILaunchChooser` (MOBILE,
 * "AI LAUNCH · CHOOSER"). Bottom-sheet over a dimmed scrim with two
 * equal-weight launch paths:
 *   - COUNT ONE THING EVERYWHERE → tap a symbol → AI finds all of them.
 *   - DRAFT THE WHOLE TAKEOFF    → define targets → AI measures all of it.
 *
 * Reached from the "● AI" button on `takeoff-mobile.tsx`. Both choices are
 * navigation handlers into the setup lanes — there is NO live capture API on
 * mobile yet, so the downstream screens render labeled presentational data
 * exactly like the desktop `est-ai-*` screens.
 *
 * Token map: the mockup's `--v2-*` brutalist tokens map onto the repo's
 * `--m-*` mobile design tokens (ink/sand/accent/font-display/num).
 */
import { useNavigate, useParams } from 'react-router-dom'
import { MI, Spark } from '../../components/m/index.js'

type LaunchChoice = {
  label: string
  sub: string
  icon: string
  accent?: boolean
  to: (projectId: string) => string
}

const CHOICES: LaunchChoice[] = [
  {
    label: 'COUNT ONE THING EVERYWHERE',
    sub: 'TAP A SYMBOL → AI FINDS ALL OF THEM ACROSS SHEETS',
    icon: '×214',
    accent: true,
    to: (id) => `/projects/${id}/takeoff-ai/count`,
  },
  {
    label: 'DRAFT THE WHOLE TAKEOFF',
    sub: 'DEFINE TARGETS → AI MEASURES ALL OF IT',
    icon: 'AUTO',
    to: (id) => `/projects/${id}/takeoff-ai/takeoff`,
  },
]

export function TakeoffAiChooser({ companySlug }: { companySlug: string }) {
  void companySlug // resource hooks resolve company from the request layer; kept for shell-prop parity.
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  const cancel = () => navigate(`/projects/${projectId}/takeoff-mobile`)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(0,0,0,0.55)',
      }}
    >
      {/* Scrim — tap to dismiss back to the canvas. */}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={cancel}
        style={{ flex: 1, background: 'transparent', border: 'none', cursor: 'pointer' }}
      />

      {/* Bottom sheet */}
      <div
        style={{
          background: 'var(--m-sand)',
          border: '2px solid var(--m-ink)',
          borderBottom: 'none',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '10px 20px 16px', borderBottom: '2px solid var(--m-ink)' }}>
          <div style={{ width: 40, height: 4, background: 'var(--m-ink)', margin: '0 auto 14px' }} aria-hidden />
          <span
            className="m-topbar-eyebrow"
            data-tone="accent"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            <Spark size={11} state="strong" /> AI · WHAT&apos;S THE JOB?
          </span>
          <h2
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 32,
              letterSpacing: '-0.02em',
              marginTop: 12,
              color: 'var(--m-ink)',
            }}
          >
            Pick one.
          </h2>
        </div>

        {CHOICES.map((o) => (
          <button
            key={o.label}
            type="button"
            onClick={() => navigate(o.to(projectId))}
            style={{
              display: 'flex',
              width: '100%',
              alignItems: 'center',
              gap: 18,
              padding: '24px 20px',
              background: o.accent ? 'var(--m-accent)' : 'transparent',
              color: o.accent ? 'var(--m-accent-ink)' : 'var(--m-ink)',
              border: 'none',
              borderBottom: '2px solid var(--m-ink)',
              textAlign: 'left',
              fontFamily: 'var(--m-font)',
              cursor: 'pointer',
            }}
          >
            <span
              style={{
                width: 64,
                padding: '8px 0',
                background: 'var(--m-ink)',
                color: 'var(--m-accent)',
                textAlign: 'center',
                fontFamily: 'var(--m-font-display)',
                fontWeight: 800,
                fontSize: 16,
                flexShrink: 0,
              }}
              aria-hidden
            >
              {o.icon}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: 'block',
                  fontFamily: 'var(--m-font-display)',
                  fontWeight: 800,
                  fontSize: 18,
                  letterSpacing: '-0.015em',
                }}
              >
                {o.label}
              </span>
              <span
                style={{
                  display: 'block',
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  marginTop: 5,
                  fontWeight: 600,
                  lineHeight: 1.4,
                  opacity: o.accent ? 0.85 : 0.7,
                }}
              >
                {o.sub}
              </span>
            </span>
            <span style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 20 }} aria-hidden>
              <MI.ChevRight size={22} />
            </span>
          </button>
        ))}

        <div style={{ padding: '16px 20px', textAlign: 'center' }}>
          <button
            type="button"
            onClick={cancel}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--m-ink-3)',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              cursor: 'pointer',
            }}
          >
            CANCEL
          </button>
        </div>
      </div>
    </div>
  )
}
