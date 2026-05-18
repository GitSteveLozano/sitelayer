import type { ReactNode } from 'react'

export type MSectionHProps = {
  children: ReactNode
  link?: ReactNode
  onLinkClick?: () => void
  /**
   * Heading level for the eyebrow. Defaults to `2` (an `<h2>`) so screen
   * readers can jump between sections with the heading shortcut. Pass
   * a different level (3-6) when the section is nested under another
   * heading hierarchy on the page.
   */
  level?: 2 | 3 | 4 | 5 | 6
}

/**
 * Section eyebrow with optional right-side link action. 11px uppercase,
 * 0.06em letter-spacing per the design system. Renders an `<hN>` so
 * screen readers see it as a navigable heading — the visual treatment
 * comes from `.m-section-h` and is unchanged.
 */
export function MSectionH({ children, link, onLinkClick, level = 2 }: MSectionHProps) {
  const Heading = `h${level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  if (!link) {
    return <Heading className="m-section-h">{children}</Heading>
  }
  return (
    <div className="m-section-h m-section-h-row">
      <Heading className="m-section-h-row-title">{children}</Heading>
      <button type="button" className="m-link" onClick={onLinkClick}>
        {link}
      </button>
    </div>
  )
}

export function MShell({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return <div className={`m${className ? ` ${className}` : ''}`}>{children}</div>
}

export function MBody({ children, pad }: { children?: ReactNode | undefined; pad?: boolean | undefined }) {
  return <div className={`m-body${pad ? ' m-body-pad' : ''}`}>{children}</div>
}

export function MStatStrip({ children }: { children: ReactNode }) {
  return <div className="m-stat-strip">{children}</div>
}

export function MStat({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div>
      <div className="m-stat-strip-l">{label}</div>
      <div className="m-stat-strip-v num">{value}</div>
    </div>
  )
}
