/**
 * Five system states required for every list / detail / async surface.
 * Per the design handoff (Design Overview/design_system/screenshots/st-*.png):
 *
 *   - Offline   — header banner + queued count
 *   - Error     — integration-specific error with retry CTA
 *   - Empty     — first-run state, one CTA, no decorative illustrations
 *   - Loading   — skeleton matching the real layout (no spinners on lists)
 *   - Permission — explains *why* we need the capability + Open settings
 */
import type { ReactNode } from 'react'
import { MBanner } from '../m/banner.js'
import { MButton, MButtonStack } from '../m/button.js'
import { MI } from '../m/icons.js'

export function MOfflineHeader({
  queuedCount,
  onRetry,
}: {
  queuedCount: number
  onRetry?: () => void
}) {
  return (
    <div
      style={{
        background: '#1c1816',
        color: '#f3ecdf',
        padding: '12px 14px',
        margin: '10px 16px',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--m-amber)' }} />
      <div style={{ flex: 1, fontSize: 13 }}>
        Offline · {queuedCount} change{queuedCount === 1 ? '' : 's'} will sync when you're back
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          style={{
            background: 'transparent',
            border: '1px solid #3a3329',
            color: '#f3ecdf',
            borderRadius: 999,
            padding: '4px 12px',
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          Retry
        </button>
      ) : null}
    </div>
  )
}

export function MErrorState({
  title,
  body,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
}: {
  title: ReactNode
  body: ReactNode
  primaryLabel?: string
  onPrimary?: () => void
  secondaryLabel?: string
  onSecondary?: () => void
}) {
  return (
    <div style={{ padding: '40px 24px', textAlign: 'center' }}>
      <div
        style={{
          width: 56,
          height: 56,
          margin: '0 auto 16px',
          borderRadius: 14,
          background: 'var(--m-red-soft)',
          color: 'var(--m-red)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <MI.Alert size={26} />
      </div>
      <div style={{ fontSize: 19, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.5, marginBottom: 18 }}>{body}</div>
      <MButtonStack>
        {primaryLabel ? (
          <MButton variant="primary" onClick={onPrimary}>
            {primaryLabel}
          </MButton>
        ) : null}
        {secondaryLabel ? (
          <MButton variant="ghost" onClick={onSecondary}>
            {secondaryLabel}
          </MButton>
        ) : null}
      </MButtonStack>
    </div>
  )
}

export function MEmptyState({
  title,
  body,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
}: {
  title: ReactNode
  body: ReactNode
  primaryLabel?: string
  onPrimary?: () => void
  secondaryLabel?: string
  onSecondary?: () => void
}) {
  return (
    <div style={{ padding: '60px 24px 24px', textAlign: 'center' }}>
      <div
        style={{
          width: 96,
          height: 80,
          margin: '0 auto 18px',
          borderRadius: 12,
          background: 'var(--m-accent-soft)',
          border: '2px dashed var(--m-accent)',
          color: 'var(--m-accent)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <MI.FileText size={28} />
      </div>
      <div style={{ fontSize: 19, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.5, marginBottom: 18 }}>{body}</div>
      <MButtonStack>
        {primaryLabel ? (
          <MButton variant="primary" onClick={onPrimary}>
            {primaryLabel}
          </MButton>
        ) : null}
        {secondaryLabel ? (
          <MButton variant="ghost" onClick={onSecondary}>
            {secondaryLabel}
          </MButton>
        ) : null}
      </MButtonStack>
    </div>
  )
}

/**
 * Skeleton loading row. Render N of these in a list to show the same
 * structure that the real data will fill — no spinners, no shimmer,
 * just the layout with placeholder bars.
 */
export function MSkeletonRow() {
  return (
    <div className="m-list-row" aria-busy="true">
      <span className="m-l-leading" style={{ background: 'var(--m-card-soft)' }} />
      <div className="m-l-body">
        <div
          style={{
            width: '50%',
            height: 11,
            borderRadius: 4,
            background: 'var(--m-card-soft)',
            marginBottom: 6,
          }}
        />
        <div
          style={{
            width: '32%',
            height: 9,
            borderRadius: 4,
            background: 'var(--m-card-soft)',
          }}
        />
      </div>
    </div>
  )
}

export function MSkeletonList({ count = 5 }: { count?: number }) {
  return (
    <div className="m-list-inset">
      {Array.from({ length: count }).map((_, i) => (
        <MSkeletonRow key={i} />
      ))}
    </div>
  )
}

export function MPermissionState({
  title,
  body,
  primaryLabel = 'Open settings',
  onPrimary,
  secondaryLabel,
  onSecondary,
  icon,
}: {
  title: ReactNode
  body: ReactNode
  primaryLabel?: string
  onPrimary?: () => void
  secondaryLabel?: string
  onSecondary?: () => void
  icon?: ReactNode
}) {
  return (
    <div style={{ padding: '50px 24px 24px', textAlign: 'center' }}>
      <div
        style={{
          width: 56,
          height: 56,
          margin: '0 auto 18px',
          borderRadius: 14,
          background: 'var(--m-accent-soft)',
          color: 'var(--m-accent-ink)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon ?? <MI.MapPin size={26} />}
      </div>
      <div style={{ fontSize: 19, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.5, marginBottom: 18 }}>{body}</div>
      <MButtonStack>
        <MButton variant="primary" onClick={onPrimary}>
          {primaryLabel}
        </MButton>
        {secondaryLabel ? (
          <MButton variant="ghost" onClick={onSecondary}>
            {secondaryLabel}
          </MButton>
        ) : null}
      </MButtonStack>
    </div>
  )
}

/**
 * Re-export MBanner for callers that just want the simple banner state
 * without going to apps/web/src/components/m directly.
 */
export { MBanner }
