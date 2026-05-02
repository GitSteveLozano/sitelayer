import { useState } from 'react'
import { MobileButton, Sheet } from '@/components/mobile'

/**
 * `RejectSheet` — the canonical "why are you dismissing?" surface.
 *
 * AI Rules (`AI Rules.html` §08, anti-patterns):
 *   > Free-text reject reasons. Reject is 4 chips. The dump-into-a-
 *   > textarea pattern produces unusable training data.
 *
 * The four default chips come from the AI Rules manifesto:
 *   - too low
 *   - wrong scope
 *   - not how I bid
 *   - other
 *
 * Callers can override `reasons` for context-specific phrasing
 * ("foreman couldn't reach worker" etc.) but should keep the count at
 * 4 and avoid a textarea fallback.
 *
 * Pair with `useRejectSheet()` for one-shot promise-style use from a
 * Dismiss button onClick:
 *
 *   const [rejectNode, askReject] = useRejectSheet()
 *   const reason = await askReject({ title: 'Dismiss agent draft?' })
 *   if (reason !== null) await dismiss.mutateAsync({ id, reason })
 */
export const DEFAULT_REJECT_REASONS = ['too low', 'wrong scope', 'not how I bid', 'other'] as const

export interface RejectSheetProps {
  open: boolean
  title: string
  body?: string
  reasons?: ReadonlyArray<string>
  onCancel: () => void
  onConfirm: (reason: string) => void | Promise<void>
}

export function RejectSheet({
  open,
  title,
  body,
  reasons = DEFAULT_REJECT_REASONS,
  onCancel,
  onConfirm,
}: RejectSheetProps) {
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!open) return null

  const submit = async () => {
    if (!picked || busy) return
    setBusy(true)
    try {
      await onConfirm(picked)
    } finally {
      setBusy(false)
      setPicked(null)
    }
  }

  return (
    <Sheet open onClose={busy ? () => {} : onCancel} title={title}>
      <div className="space-y-4">
        {body ? <p className="text-[13px] text-ink-2 leading-relaxed">{body}</p> : null}
        <div className="flex flex-wrap gap-2">
          {reasons.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setPicked(r)}
              disabled={busy}
              aria-pressed={picked === r}
              className={
                picked === r
                  ? 'inline-flex items-center px-3.5 py-1.5 rounded-full text-[13px] font-medium bg-accent text-white border border-transparent'
                  : 'inline-flex items-center px-3.5 py-1.5 rounded-full text-[13px] font-medium bg-card-soft text-ink-2 border border-line'
              }
            >
              {r}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <MobileButton variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </MobileButton>
          <MobileButton variant="primary" onClick={submit} disabled={!picked || busy}>
            {busy ? 'Working…' : 'Dismiss'}
          </MobileButton>
        </div>
      </div>
    </Sheet>
  )
}

/**
 * Promise-returning hook variant. Returns `[node, ask]`. `ask` resolves
 * with the chosen reason, or `null` if the user cancelled.
 */
export function useRejectSheet() {
  const [state, setState] = useState<{
    open: boolean
    props: Omit<RejectSheetProps, 'open' | 'onCancel' | 'onConfirm'>
    resolve: (reason: string | null) => void
  }>({
    open: false,
    props: { title: '' },
    resolve: () => {},
  })

  const onCancel = () => {
    setState((s) => ({ ...s, open: false }))
    state.resolve(null)
  }
  const onConfirm = (reason: string) => {
    setState((s) => ({ ...s, open: false }))
    state.resolve(reason)
  }

  const node = <RejectSheet open={state.open} {...state.props} onCancel={onCancel} onConfirm={onConfirm} />

  const ask = (props: Omit<RejectSheetProps, 'open' | 'onCancel' | 'onConfirm'>): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      setState({ open: true, props, resolve })
    })
  }

  return [node, ask] as const
}
