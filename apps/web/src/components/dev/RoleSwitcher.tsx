import { useState } from 'react'
import { ACT_AS_STORAGE_KEY, getActAsUserId } from '@/lib/api/client'

/**
 * Dev-only role-switcher panel. Floats in the bottom-right corner and
 * lets a developer flip the active `x-sitelayer-act-as` header without
 * standing up a Clerk org. Wired into App.tsx behind a
 * `!isClerkConfigured() && import.meta.env.MODE !== 'production'` gate,
 * so it never renders against a real Clerk-backed tenant and never ships
 * in the production bundle.
 *
 * Clicking a role:
 *   1. writes `localStorage[ACT_AS_STORAGE_KEY] = e2e-<role>`
 *   2. reloads the page so every cached fetch (TanStack Query, the
 *      XState machines that already booted) re-runs against the new
 *      identity. Trying to swap identities without a reload would leave
 *      half the app on the previous role's data.
 *
 * The API tier check (`appConfig.tier !== 'prod'`) in
 * `apps/api/src/auth.ts:resolveActAsOverride` is the hard guarantee
 * that this header can never escalate in a real environment — this
 * panel is just the convenient way to set it during local/preview work.
 */

const ROLES = [
  { id: 'e2e-admin', label: 'admin' },
  { id: 'e2e-foreman', label: 'foreman' },
  { id: 'e2e-office', label: 'office' },
  { id: 'e2e-member', label: 'member' },
  { id: 'e2e-bookkeeper', label: 'bookkeeper' },
] as const

export function RoleSwitcher() {
  const [collapsed, setCollapsed] = useState(false)
  const [active, setActive] = useState<string | null>(() => getActAsUserId())

  const select = (userId: string) => {
    try {
      window.localStorage.setItem(ACT_AS_STORAGE_KEY, userId)
    } catch {
      // localStorage can throw in private-browsing / sandboxed iframes.
      // Without it we can't persist the role-switch, so bail loudly
      // (this panel is dev-only — a console.warn is fine).
      console.warn('[RoleSwitcher] localStorage unavailable; cannot persist act-as')
      return
    }
    setActive(userId)
    // Navigate to the site root (not reload-in-place): each persona has a
    // different home surface — owner lands on /desktop via the gate, while
    // field roles (foreman/worker) land on their mobile field app. Reloading
    // in place would strand a field role on the desktop shell.
    window.location.assign('/')
  }

  const clear = () => {
    try {
      window.localStorage.removeItem(ACT_AS_STORAGE_KEY)
    } catch {
      console.warn('[RoleSwitcher] localStorage unavailable; cannot clear act-as')
      return
    }
    setActive(null)
    window.location.reload()
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="Show role switcher"
        data-testid="role-switcher-handle"
        style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          zIndex: 9999,
          background: '#1a1a1a',
          color: '#f3ecdf',
          border: '1px solid #3a342d',
          borderRadius: 999,
          padding: '6px 12px',
          fontSize: 11,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          cursor: 'pointer',
        }}
      >
        role: {active ? active.replace(/^e2e-/, '') : 'default'}
      </button>
    )
  }

  return (
    <div
      data-testid="role-switcher"
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 9999,
        background: '#1a1a1a',
        color: '#f3ecdf',
        border: '1px solid #3a342d',
        borderRadius: 8,
        padding: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
        minWidth: 180,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: '#aea69a' }}>
          dev · act-as
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse role switcher"
          style={{
            background: 'transparent',
            color: '#aea69a',
            border: 'none',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {ROLES.map((role) => {
          const isActive = role.id === active
          return (
            <button
              key={role.id}
              type="button"
              onClick={() => select(role.id)}
              data-testid={`role-switcher-${role.label}`}
              aria-pressed={isActive}
              style={{
                background: isActive ? '#d9904a' : '#2a2a2a',
                color: isActive ? '#1a1a1a' : '#f3ecdf',
                border: '1px solid',
                borderColor: isActive ? '#d9904a' : '#3a342d',
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 11,
                fontFamily: 'inherit',
                cursor: 'pointer',
                textAlign: 'left',
                fontWeight: isActive ? 600 : 400,
              }}
            >
              {role.label}
            </button>
          )
        })}
      </div>
      {active ? (
        <button
          type="button"
          onClick={clear}
          data-testid="role-switcher-clear"
          style={{
            marginTop: 8,
            width: '100%',
            background: 'transparent',
            color: '#8a8278',
            border: '1px dashed #3a342d',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 10,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          clear override
        </button>
      ) : null}
    </div>
  )
}
