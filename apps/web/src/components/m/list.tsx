import type { ReactNode } from 'react'
import { MI } from './icons.js'

export type MTone = 'accent' | 'green' | 'red' | 'amber' | 'blue'

export type MListRowProps = {
  leading?: ReactNode | undefined
  leadingTone?: MTone | undefined
  headline: ReactNode
  supporting?: ReactNode | undefined
  trailing?: ReactNode | undefined
  badge?: ReactNode | undefined
  chev?: boolean | undefined
  onTap?: (() => void) | undefined
}

/**
 * Workhorse list row. Leading icon (32×32, optional tone), headline +
 * supporting copy, trailing meta + optional chevron. Wrap rows in
 * <MListInset> for the rounded card group, or <MListPlain> for full-bleed.
 */
export function MListRow({
  leading,
  leadingTone,
  headline,
  supporting,
  trailing,
  badge,
  chev,
  onTap,
}: MListRowProps) {
  const Tag = onTap ? 'button' : 'div'
  return (
    <Tag
      type={onTap ? 'button' : undefined}
      className="m-list-row"
      data-tap={onTap ? 'true' : undefined}
      onClick={onTap}
      style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none' }}
    >
      {leading ? (
        <span className="m-l-leading" data-tone={leadingTone}>
          {leading}
        </span>
      ) : null}
      <div className="m-l-body">
        <div className="m-l-headline">{headline}</div>
        {supporting ? <div className="m-l-supporting">{supporting}</div> : null}
      </div>
      {trailing || badge ? (
        <div className="m-l-trailing">
          {trailing}
          {badge}
        </div>
      ) : null}
      {chev ? <MI.ChevRight className="m-chev" size={14} /> : null}
    </Tag>
  )
}

export function MListInset({ children }: { children: ReactNode }) {
  return <div className="m-list-inset">{children}</div>
}

export function MListPlain({ children }: { children: ReactNode }) {
  return <div className="m-list-plain">{children}</div>
}
