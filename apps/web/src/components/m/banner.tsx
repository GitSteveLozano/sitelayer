import type { ReactNode } from 'react'
import { MI } from './icons.js'

export type MBannerTone = 'info' | 'error' | 'ok' | 'warn'

export type MBannerProps = {
  tone?: MBannerTone | undefined
  title: ReactNode
  body?: ReactNode | undefined
  icon?: ReactNode | undefined
  action?: ReactNode | undefined
}

/**
 * Inline alert banner. 4 tones (info / ok / warn / error). Default tone
 * is amber-warn; set tone to override. Title is required, body and action
 * are optional.
 */
export function MBanner({ tone, title, body, icon, action }: MBannerProps) {
  const dataTone = tone === 'warn' ? undefined : tone
  return (
    <div className="m-banner" data-tone={dataTone}>
      <span className="m-banner-icon">{icon ?? <DefaultIcon tone={tone} />}</span>
      <div className="m-banner-body">
        <div className="m-banner-title">{title}</div>
        {body ? <div className="m-banner-text">{body}</div> : null}
      </div>
      {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
    </div>
  )
}

function DefaultIcon({ tone }: { tone?: MBannerTone | undefined }) {
  if (tone === 'ok') return <MI.Check size={18} />
  if (tone === 'error') return <MI.Alert size={18} />
  if (tone === 'info') return <MI.AlertTri size={18} />
  return <MI.AlertTri size={18} />
}
