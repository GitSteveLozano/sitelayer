import type { ReactNode } from 'react'
import { MI } from './icons.js'
import { TraceIdFooter } from '../shell/TraceIdFooter.js'

export type MBannerTone = 'info' | 'error' | 'ok' | 'warn'

export type MBannerProps = {
  tone?: MBannerTone | undefined
  title: ReactNode
  body?: ReactNode | undefined
  icon?: ReactNode | undefined
  action?: ReactNode | undefined
  /**
   * Customer-facing correlation id (ApiError.requestId). When present an
   * unobtrusive "Trace ID: xxx · Copy" footer renders below the body so
   * support can drill into `/api/debug/traces/:traceId`. Pass null/undefined
   * (the default) to suppress — non-API banners stay clean.
   */
  requestId?: string | null | undefined
}

/**
 * Inline alert banner. 4 tones (info / ok / warn / error). Default tone
 * is amber-warn; set tone to override. Title is required, body and action
 * are optional.
 *
 * Accessibility: error banners use `role="alert"` + `aria-live="assertive"`
 * (interrupt the screen reader); status banners (`ok` / `info` / `warn`)
 * use `role="status"` + `aria-live="polite"` so toast-like updates such
 * as "Estimate posted" or "Time review approved" are announced without
 * yanking focus.
 */
export function MBanner({ tone, title, body, icon, action, requestId }: MBannerProps) {
  const dataTone = tone === 'warn' ? undefined : tone
  const isError = tone === 'error'
  return (
    <div
      className="m-banner"
      data-tone={dataTone}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
    >
      <span className="m-banner-icon">{icon ?? <DefaultIcon tone={tone} />}</span>
      <div className="m-banner-body">
        <div className="m-banner-title">{title}</div>
        {body ? <div className="m-banner-text">{body}</div> : null}
        {requestId ? <TraceIdFooter requestId={requestId} /> : null}
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
