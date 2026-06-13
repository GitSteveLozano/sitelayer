import { useEffect, useState, type ReactNode } from 'react'
import { MButton, MI } from '@/components/m'

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
    <MSheet title={title} onClose={busy ? () => {} : onCancel}>
      <div className="space-y-4">
        {body ? <p className="text-[13px] text-ink-2 leading-relaxed">{body}</p> : null}
        <div className="flex flex-wrap gap-2">
          {reasons.map((r) => (
            <button
              key={r}
              type="button"
              className="m-chip"
              data-active={picked === r ? 'true' : undefined}
              onClick={() => setPicked(r)}
              disabled={busy}
              aria-pressed={picked === r}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <MButton variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </MButton>
          <MButton variant="primary" onClick={submit} disabled={!picked || busy}>
            {busy ? 'Working…' : 'Dismiss'}
          </MButton>
        </div>
      </div>
    </MSheet>
  )
}

/**
 * Bottom sheet in the `.m-sheet` idiom (styles/m.css — square corners, 2px
 * ink top rule, hard offset shadow). Replaces the legacy mobile-kit Sheet
 * (rounded-t-[24px]) this surface used pre-v2. ESC and backdrop-tap dismiss.
 * Same local-helper pattern as screens/mobile/schedule.tsx and
 * screens/rentals/rental-return-sheet.tsx.
 */
function MSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'rgba(15, 14, 12, 0.5)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="m-sheet" style={{ maxWidth: 720 }}>
        <div className="m-sheet-header">
          <div className="m-sheet-title">{title}</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 4,
              color: 'var(--m-ink)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <MI.X size={20} />
          </button>
        </div>
        <div className="m-sheet-body" style={{ padding: '16px 20px' }}>
          {children}
        </div>
      </div>
    </div>
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
