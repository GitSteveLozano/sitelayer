/**
 * STOP WORK · safety interrupt (v2 system state). The one genuinely net-new
 * system state — a full-screen red hazard takeover shown when a worker (or
 * foreman) flags an active safety stop on a site. Everything else halts until
 * it's acknowledged.
 *
 * Uses --m-stop-hatch (the 135° hazard overlay) + the m-pulse keyframe, which
 * is already reduced-motion-safe via the global @media rule in m.css. No new
 * global CSS — all inline on v2 tokens.
 */
import { useNavigate, useParams } from 'react-router-dom'
import { MButton } from '@/components/m'

export function MobileStopWork() {
  const navigate = useNavigate()
  const { projectId } = useParams()

  return (
    <div
      role="alertdialog"
      aria-label="Stop work — safety interrupt"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'var(--m-red)',
        backgroundImage: 'var(--m-stop-hatch)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 24px calc(env(safe-area-inset-bottom, 0px) + 32px)',
        textAlign: 'center',
        gap: 20,
      }}
    >
      {/* Pulsing hazard indicator — static under prefers-reduced-motion. */}
      <div
        aria-hidden
        style={{
          width: 88,
          height: 88,
          border: '6px solid #fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          animation: 'm-pulse 1.1s ease-in-out infinite',
        }}
      >
        <span style={{ fontFamily: 'var(--m-font-display)', fontWeight: 900, fontSize: 44, lineHeight: 1 }}>!</span>
      </div>

      <div
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
        }}
      >
        ● Stop work · safety
      </div>
      <div
        style={{
          fontFamily: 'var(--m-font-display)',
          fontWeight: 800,
          fontSize: 40,
          lineHeight: 0.96,
          letterSpacing: '-0.025em',
          maxWidth: 360,
        }}
      >
        All crew, stop work now.
      </div>
      <p style={{ fontSize: 15, lineHeight: 1.4, maxWidth: 320, opacity: 0.92 }}>
        A safety stop was flagged on this site. Down tools, move to the muster point, and wait for the foreman’s
        all-clear before resuming.
      </p>

      <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
        {/* Ghost-on-red acknowledge; full-width gloved target. */}
        <button
          type="button"
          onClick={() => navigate(projectId ? `/projects/${projectId}` : '/')}
          style={{
            minHeight: 64,
            background: '#fff',
            color: 'var(--m-red)',
            border: 'none',
            fontFamily: 'var(--m-font)',
            fontSize: 19,
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: '-0.005em',
            cursor: 'pointer',
          }}
        >
          I’m clear & safe
        </button>
        <MButton variant="ghost" onClick={() => navigate(projectId ? `/projects/${projectId}/recovery` : '/')}>
          View incident
        </MButton>
      </div>
    </div>
  )
}
