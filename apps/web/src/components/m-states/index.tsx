/**
 * Five system states required for every list / detail / async surface.
 * v2 brutalist (Steve's v2, 2026-05-28) — square corners, hard 2px ink
 * borders, mono UPPERCASE micro-labels, big numbers, full-fill state
 * colors (no soft tints). Matches the V2State* components in the design
 * handoff (steve.html · Section 18 system states).
 *
 *   - Offline   — ink banner + queued count (MOfflineHeader)
 *   - Error     — "ERROR CODE" block: SLR_xxx · GATEWAY TIMEOUT + path/time
 *   - Empty     — left-aligned 3-square graphic mark, "NO PROJECTS", CTA
 *   - Loading   — skeleton as square 2px-ink slabs (no border-radius)
 *   - Permission — explains *why* + Open settings, square accent mark
 *
 * All colors come from the `--m-*` tokens so the worker dark theme
 * (`.m-dark` shell wrapper) inverts these for free.
 */
import type { ReactNode } from 'react'
import { MBanner } from '../m/banner.js'
import { MButton, MButtonStack } from '../m/button.js'
import { MI } from '../m/icons.js'

export function MOfflineHeader({ queuedCount, onRetry }: { queuedCount: number; onRetry?: () => void }) {
  return (
    <div
      style={{
        background: 'var(--m-ink)',
        color: 'var(--m-sand)',
        padding: '14px 20px',
        margin: '10px 16px',
        border: '2px solid var(--m-ink)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <span style={{ width: 14, height: 14, background: 'var(--m-red)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--m-red)',
          }}
        >
          Offline
        </div>
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--m-ink-4)',
            marginTop: 3,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {queuedCount} change{queuedCount === 1 ? '' : 's'} will sync when you're back
        </div>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          style={{
            background: 'transparent',
            border: '1.5px solid var(--m-sand-2)',
            color: 'var(--m-sand)',
            borderRadius: 0,
            padding: '6px 12px',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            flexShrink: 0,
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
  code = 'SLR_504 · GATEWAY TIMEOUT',
  detail,
}: {
  title: ReactNode
  body: ReactNode
  primaryLabel?: string
  onPrimary?: () => void
  secondaryLabel?: string
  onSecondary?: () => void
  /** Mono error code line, e.g. "SLR_504 · GATEWAY TIMEOUT". */
  code?: string
  /** Mono path/timestamp line under the code, e.g. "3:24 PM · projects/x/photos". */
  detail?: string
}) {
  return (
    <div style={{ padding: '32px 20px 24px' }}>
      {/* Square error mark — full-fill red, hard ink border, big "!" */}
      <div
        style={{
          width: 72,
          height: 72,
          background: 'var(--m-red)',
          color: '#fff',
          border: '2px solid var(--m-ink)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--m-font-display)',
          fontWeight: 800,
          fontSize: 42,
          lineHeight: 1,
        }}
        aria-hidden="true"
      >
        !
      </div>
      <div
        style={{
          fontFamily: 'var(--m-font-display)',
          fontSize: 28,
          fontWeight: 800,
          letterSpacing: '-0.02em',
          lineHeight: 1,
          marginTop: 24,
          color: 'var(--m-red)',
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 14, color: 'var(--m-ink-2)', lineHeight: 1.5, marginTop: 12 }}>{body}</div>

      {/* ERROR CODE block — mono code + path/time. */}
      <div
        style={{
          marginTop: 24,
          padding: 16,
          background: 'var(--m-card-soft)',
          border: '2px solid var(--m-ink)',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 500,
            color: 'var(--m-ink-3)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          Error code
        </div>
        <div style={{ fontFamily: 'var(--m-num)', fontSize: 14, fontWeight: 700, marginTop: 8 }}>{code}</div>
        {detail ? (
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--m-ink-3)',
              marginTop: 6,
            }}
          >
            {detail}
          </div>
        ) : null}
      </div>

      {primaryLabel || secondaryLabel ? (
        <div style={{ marginTop: 24 }}>
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
      ) : null}
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
    <div
      style={{
        padding: '48px 24px 24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
      }}
    >
      {/* Left-aligned 3-square graphic mark: accent / sand / ink, shared 2px ink border. */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 32 }} aria-hidden="true">
        <div style={{ width: 60, height: 60, background: 'var(--m-accent)', border: '2px solid var(--m-ink)' }} />
        <div
          style={{
            width: 60,
            height: 60,
            background: 'var(--m-sand)',
            border: '2px solid var(--m-ink)',
            borderLeft: 'none',
          }}
        />
        <div
          style={{
            width: 60,
            height: 60,
            background: 'var(--m-ink)',
            border: '2px solid var(--m-ink)',
            borderLeft: 'none',
          }}
        />
      </div>
      <div
        style={{
          fontFamily: 'var(--m-font-display)',
          fontSize: 28,
          fontWeight: 800,
          letterSpacing: '-0.02em',
          lineHeight: 1,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 14, color: 'var(--m-ink-2)', lineHeight: 1.5, marginTop: 14, maxWidth: 280 }}>{body}</div>

      {primaryLabel || secondaryLabel ? (
        <div style={{ marginTop: 32, width: '100%' }}>
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
      ) : null}
    </div>
  )
}

/**
 * Skeleton loading row. Render N of these in a list to show the same
 * structure that the real data will fill — no spinners, no shimmer.
 * v2: square 2px-ink slabs (placeholder bars have square corners and
 * use the ink-3 token at low opacity, never a soft tint).
 */
export function MSkeletonRow() {
  return (
    <div className="m-list-row" aria-busy="true">
      <span
        className="m-l-leading"
        style={{ background: 'var(--m-ink-3)', opacity: 0.3, borderRadius: 0 }}
      />
      <div className="m-l-body">
        <div
          style={{
            width: '50%',
            height: 12,
            borderRadius: 0,
            background: 'var(--m-line-2)',
            marginBottom: 6,
          }}
        />
        <div
          style={{
            width: '32%',
            height: 9,
            borderRadius: 0,
            background: 'var(--m-line-2)',
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
    <div style={{ padding: '32px 20px 24px' }}>
      {/* Square accent mark — hard ink border, no radius. */}
      <div
        style={{
          width: 72,
          height: 72,
          background: 'var(--m-accent)',
          color: 'var(--m-accent-ink)',
          border: '2px solid var(--m-ink)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon ?? <MI.MapPin size={30} />}
      </div>
      <div
        style={{
          fontFamily: 'var(--m-font-display)',
          fontSize: 28,
          fontWeight: 800,
          letterSpacing: '-0.02em',
          lineHeight: 1,
          marginTop: 24,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 14, color: 'var(--m-ink-2)', lineHeight: 1.5, marginTop: 12 }}>{body}</div>

      <div style={{ marginTop: 32 }}>
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
    </div>
  )
}

/**
 * Re-export MBanner for callers that just want the simple banner state
 * without going to apps/web/src/components/m directly.
 */
export { MBanner }
