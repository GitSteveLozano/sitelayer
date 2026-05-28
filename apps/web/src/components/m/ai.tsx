import type { ReactNode } from 'react'
import { MI, Spark } from './icons.js'

/**
 * AI surface atoms — see Design Overview/design_system/README.md § AI rules.
 *
 * Three layers:
 *   - <MAiEyebrow>  — inline mention inside an existing card. Lightest touch.
 *   - <MAiStripe>   — accented left-border card. Standard intelligence surface.
 *   - <MAiAgent>    — dashed border + soft tint. Reserved for autonomous draft
 *                     output that needs explicit human approval.
 *
 * Rules baked in:
 *   - The Spark is the only AI marker (5-pointed star). Never sparkles.
 *   - Stripes are dismissible. AI is offered, never imposed.
 *   - Attribution is shown by default ("Based on 7 closed jobs.") so the
 *     data moat is visible.
 *   - No numeric confidence scores anywhere.
 */

export function MAiEyebrow({ tone, children }: { tone?: 'warn' | undefined; children: ReactNode }) {
  return (
    <span className="m-ai-eyebrow" data-tone={tone}>
      <Spark size={11} state="strong" />
      {children}
    </span>
  )
}

export type MAttributionProps = {
  children: ReactNode
}

/**
 * The "Based on …" line. Bold the data quantity, leave the rest plain.
 * Callers pass JSX so emphasis lands on the right token:
 *   <Attribution>Based on <strong>7 closed jobs</strong>.</Attribution>
 */
export function MAttribution({ children }: MAttributionProps) {
  return <span className="m-ai-attr">{children}</span>
}

export type MAiStripeProps = {
  tone?: 'warn' | 'good' | undefined
  eyebrow?: ReactNode | undefined
  title?: ReactNode | undefined
  children: ReactNode
  attribution?: ReactNode | undefined
  action?: ReactNode | undefined
  onDismiss?: (() => void) | undefined
}

export function MAiStripe({ tone, eyebrow, title, children, attribution, action, onDismiss }: MAiStripeProps) {
  return (
    <div className="m-ai-stripe" data-tone={tone}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {eyebrow ? (
            <div style={{ marginBottom: 4 }}>
              <MAiEyebrow tone={tone === 'warn' ? 'warn' : undefined}>{eyebrow}</MAiEyebrow>
            </div>
          ) : null}
          {title ? (
            <div style={{ fontFamily: 'var(--m-font-display)', fontSize: 16, fontWeight: 700, letterSpacing: '-0.015em', marginBottom: 4 }}>
              {title}
            </div>
          ) : null}
          <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.4 }}>{children}</div>
          {attribution ? (
            <div style={{ marginTop: 8 }}>
              <MAttribution>{attribution}</MAttribution>
            </div>
          ) : null}
        </div>
        {onDismiss ? (
          <button type="button" className="m-ai-dismiss" aria-label="Dismiss" onClick={onDismiss}>
            <MI.X size={12} />
          </button>
        ) : null}
      </div>
      {action ? <div style={{ marginTop: 10 }}>{action}</div> : null}
    </div>
  )
}

export type MAiAgentProps = {
  children: ReactNode
  attribution?: ReactNode | undefined
  onDismiss?: (() => void) | undefined
}

/**
 * Dashed accent-border container. The "Agent draft · review before sending"
 * label is positioned absolute by `.m-ai-agent::before` so callers don't
 * need to repeat it.
 */
export function MAiAgent({ children, attribution, onDismiss }: MAiAgentProps) {
  return (
    <div className="m-ai-agent">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 14, color: 'var(--m-ink)' }}>{children}</div>
        {onDismiss ? (
          <button type="button" className="m-ai-dismiss" aria-label="Dismiss" onClick={onDismiss}>
            <MI.X size={12} />
          </button>
        ) : null}
      </div>
      {attribution ? (
        <div style={{ marginTop: 8 }}>
          <MAttribution>{attribution}</MAttribution>
        </div>
      ) : null}
    </div>
  )
}

export { Spark }
