import type { ReactNode } from 'react'

/**
 * Shared content-state primitives — empty · error · loading (Phase A of the
 * responsive consolidation, additive).
 *
 * Promoted from components/d/index.tsx into the shared kit so they are no
 * longer desktop-only. They emit the `d-state-*` class family (the
 * source-of-truth CSS lives in styles/d.css), so the desktop rendered output
 * is unchanged; `DEmptyState`/`DErrorState`/`DLoadingState` in
 * components/d/index.tsx are now thin re-export aliases over these.
 *
 * Note: components/m-states/index.tsx already provides the richer mobile
 * offline/permission/update states (`MEmptyState`/`MErrorState` etc.). These
 * neutral `EmptyState`/`ErrorState`/`LoadingState` are the lighter
 * command-center variants, now available to any surface from the shared kit.
 */

export function EmptyState({
  mark = '○',
  title = 'Nothing here yet',
  body = 'When data arrives it shows up here.',
  action,
}: {
  mark?: string
  title?: ReactNode
  body?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="d-state">
      <div className="d-state-mark" aria-hidden>
        <span className="d-state-sq d-state-sq-accent" />
        <span className="d-state-sq" />
        <span className="d-state-sq d-state-sq-ink">{mark}</span>
      </div>
      <div className="d-state-title">{title}</div>
      <div className="d-state-body">{body}</div>
      {action ? <div className="d-state-action">{action}</div> : null}
    </div>
  )
}

export function ErrorState({
  title = 'Couldn’t load',
  body = 'The server didn’t answer. Your work is safe.',
  code,
  actions,
}: {
  title?: ReactNode
  body?: ReactNode
  code?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="d-state">
      <div className="d-state-bang" aria-hidden>
        !
      </div>
      <div className="d-state-title" data-tone="bad">
        {title}
      </div>
      <div className="d-state-body">{body}</div>
      {code ? <div className="d-state-code">{code}</div> : null}
      {actions ? <div className="d-state-action">{actions}</div> : null}
    </div>
  )
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="d-state">
      <div className="d-state-mark" aria-hidden>
        <span className="d-state-sq d-state-sq-accent d-pulse" />
        <span className="d-state-sq d-pulse" />
        <span className="d-state-sq d-state-sq-ink d-pulse" />
      </div>
      <div className="d-state-body" style={{ marginTop: 18 }}>
        {label}
      </div>
    </div>
  )
}
