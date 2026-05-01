import { useState } from 'react'
import { MobileButton, Sheet } from '@/components/mobile'

/**
 * `wk-issue` — flag-a-problem bottom sheet.
 *
 * Phase 1D.2 ships the visual + form. Wiring to the API lands when the
 * backend exposes a worker-issue endpoint (Phase 2 — owner dashboard
 * surfaces the foreman ping). For now `onSubmit` is a no-op the screen
 * resolves so the UX flow is testable end-to-end.
 *
 * Issue kinds match the design's chip row:
 *   materials_out   — out of EPS / mesh / etc.
 *   crew_short      — crew didn't show up / left
 *   safety          — anything safety-flagged
 *   other           — free-text fallback
 */
export type IssueKind = 'materials_out' | 'crew_short' | 'safety' | 'other'

const KIND_LABELS: Record<IssueKind, string> = {
  materials_out: 'Out of materials',
  crew_short: 'Crew short',
  safety: 'Safety',
  other: 'Something else',
}

export interface IssueModalProps {
  open: boolean
  onClose: () => void
  onSubmit: (input: { kind: IssueKind; message: string }) => Promise<void> | void
}

export function IssueModal({ open, onClose, onSubmit }: IssueModalProps) {
  const [kind, setKind] = useState<IssueKind>('materials_out')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSend = async () => {
    setSubmitting(true)
    try {
      await onSubmit({ kind, message: message.trim() })
      setMessage('')
      setKind('materials_out')
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Flag a problem">
      <div className="text-[12px] text-ink-3 mb-3">
        Sends a push to your foreman. Add detail so they can act without calling.
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {(Object.keys(KIND_LABELS) as IssueKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`px-3.5 py-1.5 rounded-full text-[13px] font-medium border transition-colors ${
              kind === k ? 'bg-accent text-white border-transparent' : 'bg-card-soft text-ink-2 border-line'
            }`}
          >
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>

      <label className="block text-[12px] font-medium text-ink-3 mb-1.5">Detail</label>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="A few words…"
        rows={3}
        className="w-full p-3 text-[14px] rounded border border-line-2 bg-card focus:outline-none focus:border-accent resize-none"
      />

      <div className="mt-4 flex gap-2">
        <MobileButton variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </MobileButton>
        <MobileButton variant="primary" onClick={handleSend} disabled={submitting || !message.trim()}>
          {submitting ? 'Sending…' : 'Send'}
        </MobileButton>
      </div>
    </Sheet>
  )
}
