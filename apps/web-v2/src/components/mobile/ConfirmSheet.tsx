import { useState, type ReactNode } from 'react'
import { MobileButton } from './Button'
import { Sheet } from './Sheet'

/**
 * Mobile-friendly replacement for `window.confirm`. Used wherever a
 * destructive action (delete, void, generate) needs explicit human
 * sign-off. Works as a controlled component when paired with a state
 * variable, OR via the `useConfirm()` hook for one-shot calls from
 * inside event handlers.
 *
 * Rationale: the design system never uses raw browser modals — they
 * lose the safe-area styling, can't surface a destructive-tone
 * button, and on iOS the native sheet dismisses in ways the
 * surrounding app can't observe (e.g., for AI Layer's
 * dismiss-as-signal rule).
 */
export interface ConfirmSheetProps {
  open: boolean
  title: string
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onCancel: () => void
  onConfirm: () => void | Promise<void>
}

export function ConfirmSheet({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onCancel,
  onConfirm,
}: ConfirmSheetProps) {
  const [busy, setBusy] = useState(false)
  if (!open) return null
  const handle = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet open={open} onClose={busy ? () => {} : onCancel} title={title}>
      <div className="space-y-4">
        {body ? <div className="text-[13px] text-ink-2 leading-relaxed">{body}</div> : null}
        <div className="grid grid-cols-2 gap-2">
          <MobileButton variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </MobileButton>
          <MobileButton variant={destructive ? 'destructive' : 'primary'} onClick={handle} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </MobileButton>
        </div>
      </div>
    </Sheet>
  )
}

/**
 * Hook variant for one-shot confirm-then-do flows. Returns a
 * `[node, ask]` tuple — render the node next to your other markup
 * and call `ask({...})` from your event handler. Resolves with the
 * user's choice.
 */
export function useConfirmSheet() {
  const [state, setState] = useState<{
    open: boolean
    props: Omit<ConfirmSheetProps, 'open' | 'onConfirm' | 'onCancel'>
    resolve: (ok: boolean) => void
  }>({
    open: false,
    props: { title: '' },
    resolve: () => {},
  })

  const onCancel = () => {
    setState((s) => ({ ...s, open: false }))
    state.resolve(false)
  }
  const onConfirm = () => {
    setState((s) => ({ ...s, open: false }))
    state.resolve(true)
  }
  // Spread the captured props so `exactOptionalPropertyTypes` doesn't
  // see explicit `undefined` for omitted optional props.
  const node = <ConfirmSheet open={state.open} {...state.props} onCancel={onCancel} onConfirm={onConfirm} />

  const ask = (props: Omit<ConfirmSheetProps, 'open' | 'onConfirm' | 'onCancel'>): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setState({ open: true, props, resolve })
    })
  }

  return [node, ask] as const
}
