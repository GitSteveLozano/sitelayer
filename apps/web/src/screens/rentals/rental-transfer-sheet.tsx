import { useState } from 'react'
import { Card, MobileButton, Pill, Sheet } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { MBanner } from '@/components/m'
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

  return (
    <Sheet open={open} onClose={onClose} title={itemLabel ? `Transfer — ${itemLabel}` : 'Transfer rental'}>
      <div className="space-y-3">
        <Card tight>
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
                      ? 'block w-full text-left rounded-md bg-accent/10 border border-accent px-3 py-2'
                      : 'block w-full text-left rounded-md border border-line px-3 py-2'
                  }
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold truncate">{p.name}</div>
                      <div className="text-[11px] text-ink-3 mt-0.5">{p.customer_name ?? 'no customer'}</div>
                    </div>
                    <Pill tone="default">{p.status}</Pill>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card tight>
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
        </Card>

        {error ? <MBanner tone="error" title="Could not transfer" body={error} /> : null}

        <Attribution source="POST /api/rentals/:id/transfer — closes source + creates a new linked rental" />

        <MobileButton variant="primary" onClick={onSubmit} disabled={!targetId || transfer.isPending}>
          {transfer.isPending ? 'Transferring…' : 'Transfer rental'}
        </MobileButton>
      </div>
    </Sheet>
  )
}
