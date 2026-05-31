import { useEffect, useState } from 'react'
import { MShell, MBody } from '@/components/m/section'
import { MLargeHead } from '@/components/m/large-head'
import { MButton, MButtonStack } from '@/components/m/button'
import { MInput } from '@/components/m/form'
import { MBanner } from '@/components/m/banner'
import { request, ApiError } from '@/lib/api/client'

/**
 * Demo-tier landing + access-code gate + Clerk magic-link role picker.
 *
 * Lives at `/demo`. The demo tier (APP_TIER=demo,
 * demo.preview.sitelayer.sandolab.xyz) runs Clerk-ON, so the dev act-as
 * header bypass is NOT available — role switching has to mint a real Clerk
 * session. This screen:
 *   1. Confirms the running tier is `demo` via `/api/features` (a public
 *      route). On any other tier it renders nothing reachable (a bare 404),
 *      so the magic-link surface is structurally absent off the demo tier.
 *   2. Asks for the shared ACCESS CODE (validated server-side against
 *      DEMO_ACCESS_CODE — never compared in the client).
 *   3. Shows role buttons (Owner / Estimator / Foreman / Crew). Tapping one
 *      POSTs `/api/demo/sign-in-link`, which mints a Clerk sign-in token and
 *      returns a `?__clerk_ticket=` redirect URL. We navigate the browser
 *      there; Clerk auto-signs-in and lands in-app as that role.
 *   4. Offers "Sign in normally" → the real Clerk sign-in (`/sign-in`).
 *
 * NO-INDEX: a robots `noindex` meta tag is installed on mount (the API also
 * stamps `X-Robots-Tag: noindex` on `/api/demo/*`).
 */

type DemoRole = 'owner' | 'estimator' | 'foreman' | 'crew'

const ROLES: Array<{ role: DemoRole; label: string; blurb: string }> = [
  { role: 'owner', label: 'Owner', blurb: 'Full command center — money, crews, every project.' },
  { role: 'estimator', label: 'Estimator', blurb: 'Takeoffs, estimates, and the bid pipeline.' },
  { role: 'foreman', label: 'Foreman', blurb: 'Today’s crew, daily logs, field issues.' },
  { role: 'crew', label: 'Crew', blurb: 'Clock in/out, assignments, problems.' },
]

const NOINDEX_META_ID = 'demo-robots-noindex'

function useNoIndexMeta() {
  useEffect(() => {
    if (typeof document === 'undefined') return
    let meta = document.getElementById(NOINDEX_META_ID) as HTMLMetaElement | null
    const created = !meta
    if (!meta) {
      meta = document.createElement('meta')
      meta.id = NOINDEX_META_ID
      meta.name = 'robots'
      document.head.appendChild(meta)
    }
    meta.content = 'noindex, nofollow'
    return () => {
      // Only remove the tag if this screen created it.
      if (created && meta && meta.parentNode) meta.parentNode.removeChild(meta)
    }
  }, [])
}

type TierState = { status: 'loading' } | { status: 'demo' } | { status: 'not-demo' }

function useDemoTier(): TierState {
  const [state, setState] = useState<TierState>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    request<{ tier: string | null }>('/api/features', { skipAuth: true })
      .then((res) => {
        if (cancelled) return
        setState(res.tier === 'demo' ? { status: 'demo' } : { status: 'not-demo' })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'not-demo' })
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

export function DemoLanding() {
  useNoIndexMeta()
  const tier = useDemoTier()
  const [accessCode, setAccessCode] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [pendingRole, setPendingRole] = useState<DemoRole | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Off the demo tier this surface does not exist. Render a bare 404 so the
  // magic-link picker is unreachable anywhere but the demo deployment.
  if (tier.status === 'loading') {
    return (
      <MShell>
        <MBody pad>
          <MLargeHead title="Loading…" />
        </MBody>
      </MShell>
    )
  }
  if (tier.status === 'not-demo') {
    return (
      <MShell>
        <MBody pad>
          <MLargeHead title="404" sub="Not found." />
        </MBody>
      </MShell>
    )
  }

  async function pickRole(role: DemoRole) {
    setError(null)
    setPendingRole(role)
    try {
      const res = await request<{ redirect_url: string }>('/api/demo/sign-in-link', {
        method: 'POST',
        skipAuth: true,
        json: { role, accessCode },
      })
      // Hand the browser to Clerk's ticket URL; Clerk auto-signs-in.
      window.location.assign(res.redirect_url)
    } catch (err) {
      setPendingRole(null)
      if (err instanceof ApiError) {
        if (err.status === 401) {
          // Access code went stale (e.g. rotated). Re-lock and prompt again.
          setUnlocked(false)
          setError('That access code is no longer valid. Enter the current one.')
          return
        }
        setError(err.message || 'Could not start the demo session.')
        return
      }
      setError('Could not reach the server. Try again.')
    }
  }

  return (
    <MShell>
      <MBody pad>
        <MLargeHead
          eyebrow="DEMO"
          title="Sitelayer demo"
          sub="Sample data, public showcase. Pick a role to look around — no signup."
        />

        {error ? <MBanner tone="error" title="Couldn’t continue" body={error} /> : null}

        {!unlocked ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setError(null)
              if (accessCode.trim()) setUnlocked(true)
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}
          >
            <label className="m-section-h" htmlFor="demo-access-code">
              Access code
            </label>
            <MInput
              id="demo-access-code"
              type="password"
              autoComplete="off"
              autoFocus
              placeholder="Enter the shared access code"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
            />
            <MButton type="submit" variant="primary" disabled={!accessCode.trim()}>
              Continue
            </MButton>
            <MButton
              type="button"
              variant="quiet"
              onClick={() => window.location.assign('/sign-in')}
            >
              Sign in normally
            </MButton>
          </form>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
            <div className="m-section-h">Choose a role</div>
            <MButtonStack>
              {ROLES.map(({ role, label, blurb }) => (
                <MButton
                  key={role}
                  type="button"
                  variant="primary"
                  disabled={pendingRole !== null}
                  onClick={() => pickRole(role)}
                >
                  {pendingRole === role ? `Signing in as ${label}…` : `${label} — ${blurb}`}
                </MButton>
              ))}
            </MButtonStack>
            <MButton
              type="button"
              variant="quiet"
              disabled={pendingRole !== null}
              onClick={() => window.location.assign('/sign-in')}
            >
              Sign in normally
            </MButton>
          </div>
        )}
      </MBody>
    </MShell>
  )
}
