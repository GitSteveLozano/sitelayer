import { useEffect, useState, type ReactNode } from 'react'
import { Attribution } from '@/components/ai'
import { MBanner, MButton, MI, MPill } from '@/components/m'
import { useProjects, useRentalTransfer, type RentalTransferResponse } from '@/lib/api'

/**
 * `rnt-transfer-sheet` — pick a target project to transfer a rental to.
 *
 * Wires `POST /api/rentals/:id/transfer` which closes the source rental
 * and creates a new active rental on the destination project, copying
 * item/qty/rate and pointing `transferred_from_rental_id` at the source.
 *
 * The list of project candidates is filtered to active/lead so foremen
 * don't accidentally transfer onto a closed/archived project.
 */
export interface RentalTransferSheetProps {
  open: boolean
  onClose: () => void
  rentalId: string
  /** The current project the rental sits on — excluded from the picker. */
  currentProjectId: string | null
  /** Humanized label for the rental row (used in the sheet header). */
  itemLabel?: string
  onSuccess?: (response: RentalTransferResponse) => void
}

export function RentalTransferSheet({
  open,
  onClose,
  rentalId,
  currentProjectId,
  itemLabel,
  onSuccess,
}: RentalTransferSheetProps) {
  const projects = useProjects({ status: 'active' })
  const transfer = useRentalTransfer(rentalId)
  const [targetId, setTargetId] = useState<string>('')
  const [transferAt, setTransferAt] = useState<string>(new Date().toISOString().slice(0, 10))
  const [error, setError] = useState<string | null>(null)

  const candidates = (projects.data?.projects ?? []).filter((p) => p.id !== currentProjectId)

  const onSubmit = async () => {
    setError(null)
    if (!targetId) {
      setError('Pick a target project')
      return
    }
    try {
      const response = await transfer.mutateAsync({ to_project_id: targetId, transferred_at: transferAt })
      onSuccess?.(response)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transfer failed')
    }
  }

  if (!open) return null

  return (
    <MSheet title={itemLabel ? `Transfer — ${itemLabel}` : 'Transfer rental'} onClose={onClose}>
      <div className="space-y-3">
        <div className="m-card m-card-tight">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-2">Target project</div>
          {projects.isPending ? (
            <div className="text-[12px] text-ink-3">Loading projects…</div>
          ) : candidates.length === 0 ? (
            <div className="text-[12px] text-ink-3">No other active projects to transfer to.</div>
          ) : (
            <div className="space-y-1">
              {candidates.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => setTargetId(p.id)}
                  aria-pressed={targetId === p.id}
                  className={
                    targetId === p.id
                      ? 'block w-full text-left bg-accent/10 border border-accent px-3 py-2'
                      : 'block w-full text-left border border-line px-3 py-2'
                  }
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold truncate">{p.name}</div>
                      <div className="text-[11px] text-ink-3 mt-0.5">{p.customer_name ?? 'no customer'}</div>
                    </div>
                    <MPill>{p.status}</MPill>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="m-card m-card-tight">
          <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
            Transferred on
          </label>
          <input
            type="date"
            value={transferAt}
            onChange={(e) => setTransferAt(e.target.value)}
            className="mt-1 w-full text-[15px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
          />
          <div className="text-[11px] text-ink-3 mt-1">
            Source rental closes on this date and a new active rental opens on the target project.
          </div>
        </div>

        {error ? <MBanner tone="error" title="Could not transfer" body={error} /> : null}

        <Attribution source="POST /api/rentals/:id/transfer — closes source + creates a new linked rental" />

        <MButton variant="primary" onClick={onSubmit} disabled={!targetId || transfer.isPending}>
          {transfer.isPending ? 'Transferring…' : 'Transfer rental'}
        </MButton>
      </div>
    </MSheet>
  )
}

/**
 * Bottom sheet in the `.m-sheet` idiom (styles/m.css — square corners, 2px
 * ink top rule, hard offset shadow). Replaces the legacy
 * mobile-kit Sheet (rounded-t-[24px]) this sheet used pre-v2.
 * ESC and backdrop-tap dismiss. Same local-helper pattern as
 * screens/mobile/schedule.tsx and screens/financial/generate-payroll-export-sheet.tsx.
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
