/**
 * Desktop onboarding shell (Desktop v2 · Onboarding). Ported from Steve's
 * `DOnbShell` mockup (dt / --d-* tokens) onto the repo's v2 brutalist tokens
 * (--m-*) and the shared `MButton` primitive.
 *
 * This is the pre-workspace, sidebar-less centered-card layout: a top brand
 * strip (SL mark + "Sitelayer" + "STEP n / total"), then a centered 560px
 * column with an optional eyebrow chip, a big Inter Tight title, the step's
 * children, and primary/secondary action buttons.
 *
 * Reusable: the multi-step wizard in `onboarding.tsx` renders every step
 * through this shell. Square corners, 2px hard ink borders, hi-vis accent —
 * see owner-dashboard.tsx for the d-content / --m-* inline-style pattern.
 */
import type { ReactNode } from 'react'
import { MButton } from '@/components/m'

export interface OnboardingShellProps {
  /** Current step number for the "STEP n / total" strip (omit on sign-in). */
  step?: number | undefined
  /** Total steps for the strip. */
  total?: number | undefined
  /** Small mono chip above the title (e.g. "STEP 1 · WORKSPACE"). */
  eyebrow?: ReactNode
  /** Large Inter Tight headline. */
  title?: ReactNode
  /** Step body content. */
  children?: ReactNode
  /** Primary action label; omit to hide the primary button. */
  primaryLabel?: ReactNode
  /** Secondary (ghost) action label; omit to hide the secondary button. */
  secondaryLabel?: ReactNode
  /** Primary button click handler. */
  onPrimary?: () => void
  /** Secondary button click handler. */
  onSecondary?: () => void
  /** Disable the primary action (e.g. required field empty). */
  primaryDisabled?: boolean
}

export function OnboardingShell({
  step,
  total,
  eyebrow,
  title,
  children,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
  primaryDisabled,
}: OnboardingShellProps) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--m-bg)',
        color: 'var(--m-ink)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'var(--m-font)',
      }}
    >
      {/* top brand strip */}
      <div
        style={{
          padding: '18px 28px',
          borderBottom: '2px solid var(--m-ink)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 34,
            height: 34,
            background: 'var(--m-accent)',
            color: 'var(--m-accent-ink)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--m-font-display)',
            fontWeight: 900,
            fontSize: 16,
          }}
        >
          SL
        </div>
        <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 18 }}>Sitelayer</div>
        {step ? (
          <div
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--m-ink-3)',
              letterSpacing: '0.06em',
            }}
          >
            STEP {step} / {total}
          </div>
        ) : null}
      </div>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <div style={{ width: 560, maxWidth: '100%' }}>
          {eyebrow ? (
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--m-accent-ink)',
                background: 'var(--m-accent)',
                display: 'inline-block',
                padding: '3px 8px',
                letterSpacing: '0.06em',
              }}
            >
              {eyebrow}
            </div>
          ) : null}
          {title ? (
            <h1
              style={{
                fontFamily: 'var(--m-font-display)',
                fontWeight: 800,
                fontSize: 52,
                letterSpacing: '-0.03em',
                lineHeight: 0.95,
                margin: '18px 0 24px',
              }}
            >
              {title}
            </h1>
          ) : null}

          {children}

          {primaryLabel || secondaryLabel ? (
            <div style={{ display: 'flex', gap: 10, marginTop: 28 }}>
              {primaryLabel ? (
                <div style={{ flex: 2, display: 'flex' }}>
                  <MButton
                    variant="primary"
                    onClick={onPrimary}
                    disabled={primaryDisabled}
                    style={{ flex: 1, width: '100%' }}
                  >
                    {primaryLabel}
                  </MButton>
                </div>
              ) : null}
              {secondaryLabel ? (
                <div style={{ flex: 1, display: 'flex' }}>
                  <MButton variant="ghost" onClick={onSecondary} style={{ flex: 1, width: '100%' }}>
                    {secondaryLabel}
                  </MButton>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
