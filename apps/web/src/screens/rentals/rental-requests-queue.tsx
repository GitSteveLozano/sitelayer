/**
 * Rental requests review queue — operator-side surface for portal
 * customer submissions waiting on approval.
 *
 * Mirrors the customer flow handed off from
 * `apps/api/src/routes/portal-rentals.ts` (POST .../reserve creates a
 * `rental_requests` row) and the operator API in
 * `apps/api/src/routes/rental-requests.ts` (this file's read/approve/
 * decline counterpart). Only admin/office personas reach this screen.
 *
 * Headless: the list comes from GET /api/rental-requests, but each card's
 * actions are driven by the per-row workflow snapshot
 * (GET /api/rental-requests/:id → { state, state_version, next_events }).
 * Buttons render ONE-per-`next_events` entry so the UI can only dispatch a
 * transition the reducer allows, and every dispatch threads `state_version`
 * (POST /api/rental-requests/:id/events) so two operators acting on the
 * same request 409 on a stale version instead of silently racing.
 *
 * Layout:
 *   - MTopBar with back navigation to /rentals.
 *   - Banner at the top when a dispatch errors.
 *   - One MListInset per pending request, each showing customer name,
 *     line items + qty, requested date range, contact info, plus the
 *     reducer's next_events as action buttons.
 *   - Approve opens a confirmation Sheet with the line preview.
 *   - Decline opens a Sheet asking for an optional reason string.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBanner, MBody, MButton, MButtonRow, MI, MListInset, MListRow, MTopBar } from '@/components/m'
import {
  useDispatchRentalRequestEvent,
  useRentalRequests,
  useRentalRequestSnapshot,
  type RentalRequest,
  type RentalRequestApprovalEvent,
  type RentalRequestItem,
} from '@/lib/api'

type ActiveSheet =
  | { kind: 'approve'; request: RentalRequest; stateVersion: number }
  | { kind: 'decline'; request: RentalRequest; stateVersion: number }
  | null

export function RentalRequestsQueueScreen() {
  const navigate = useNavigate()
  const pending = useRentalRequests('pending', 50)
  const [errorBanner, setErrorBanner] = useState<string | null>(null)

  const requests = pending.data?.rentalRequests ?? []

  return (
    <>
      <MTopBar
        back
        title="Pending requests"
        sub={pending.isPending ? 'Loading…' : `${requests.length} awaiting review`}
        onBack={() => navigate('/rentals')}
      />
      <MBody pad>
        {errorBanner ? (
          <div style={{ marginBottom: 12 }}>
            <MBanner tone="error" title="Action failed" body={errorBanner} />
          </div>
        ) : null}

        {pending.isError ? (
          <MBanner
            tone="error"
            title="Couldn't load pending requests"
            body={String(pending.error?.message ?? 'Network error')}
          />
        ) : null}

        {!pending.isPending && requests.length === 0 ? (
          <MBanner tone="info" title="No pending rental requests" body="Customer portal submissions show up here." />
        ) : null}

        {requests.map((req) => (
          <RentalRequestCard key={req.id} request={req} onError={setErrorBanner} onActed={() => pending.refetch()} />
        ))}
      </MBody>
    </>
  )
}

interface RentalRequestCardProps {
  request: RentalRequest
  onError: (msg: string | null) => void
  onActed: () => void
}

function RentalRequestCard({ request, onError, onActed }: RentalRequestCardProps) {
  const snapshot = useRentalRequestSnapshot(request.id)
  const dispatch = useDispatchRentalRequestEvent(request.id)
  const [active, setActive] = useState<ActiveSheet>(null)

  const items = Array.isArray(request.items) ? request.items : []
  const dateRange = formatDateRange(request.requested_start, request.requested_end)
  const contactPieces = [request.contact_name, request.contact_email, request.contact_phone]
    .filter((p): p is string => Boolean(p && p.length > 0))
    .join(' · ')

  // Reducer-computed actions only. Until the snapshot loads, render no
  // buttons (the screen never invents a transition the machine disallows).
  const nextEvents = snapshot.data?.next_events ?? []
  const stateVersion = snapshot.data?.state_version ?? 0

  function runDispatch(event: RentalRequestApprovalEvent, declineReason?: string | null) {
    onError(null)
    dispatch.mutate(
      { event, state_version: stateVersion, decline_reason: declineReason ?? null },
      {
        onSuccess: () => {
          setActive(null)
          onActed()
        },
        onError: (err) => {
          // A 409 means another operator already acted; reload the snapshot
          // so the fresh next_events re-render (likely empty → terminal).
          snapshot.refetch()
          onError(String(err?.message ?? `${event} failed`))
        },
      },
    )
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <MListInset>
        <MListRow
          headline={request.customer_name ?? request.contact_name ?? 'Unknown customer'}
          supporting={dateRange ?? 'No date range provided'}
        />
        <MListRow headline={summarizeItems(items)} supporting={contactPieces || 'No contact info supplied'} />
        {request.notes ? <MListRow headline="Notes" supporting={request.notes} /> : null}
      </MListInset>
      <div style={{ marginTop: 8 }}>
        <MButtonRow>
          {nextEvents.map((evt) => (
            <MButton
              key={evt.type}
              variant={evt.type === 'APPROVE' ? 'primary' : 'ghost'}
              disabled={dispatch.isPending || snapshot.isPending}
              onClick={() => setActive({ kind: evt.type === 'APPROVE' ? 'approve' : 'decline', request, stateVersion })}
            >
              {evt.label}
            </MButton>
          ))}
        </MButtonRow>
      </div>

      {active?.kind === 'approve' ? (
        <MSheet title="Approve request?" onClose={() => setActive(null)}>
          <ApproveSheetBody
            request={active.request}
            isPending={dispatch.isPending}
            onCancel={() => setActive(null)}
            onConfirm={() => runDispatch('APPROVE')}
          />
        </MSheet>
      ) : null}

      {active?.kind === 'decline' ? (
        <MSheet title="Decline request" onClose={() => setActive(null)}>
          <DeclineSheetBody
            request={active.request}
            isPending={dispatch.isPending}
            onCancel={() => setActive(null)}
            onConfirm={(reason) => runDispatch('DECLINE', reason || null)}
          />
        </MSheet>
      ) : null}
    </div>
  )
}

/**
 * Bottom sheet in the `.m-sheet` idiom (styles/m.css — square corners, 2px
 * ink top rule, hard offset shadow). Replaces the legacy
 * mobile-kit Sheet (rounded-t-[24px]) this screen used pre-v2.
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

interface ApproveSheetBodyProps {
  request: RentalRequest
  isPending: boolean
  onCancel: () => void
  onConfirm: () => void
}

function ApproveSheetBody({ request, isPending, onCancel, onConfirm }: ApproveSheetBodyProps) {
  const items = Array.isArray(request.items) ? request.items : []
  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--m-ink-2)', marginBottom: 12 }}>
        This converts the request into {items.length || 1} rental row{items.length === 1 ? '' : 's'} for{' '}
        <strong>{request.customer_name ?? request.contact_name ?? 'this customer'}</strong>.
      </p>
      <MListInset>
        {items.length === 0 ? (
          <MListRow headline="No line items" supporting="The portal submission was empty." />
        ) : (
          items.map((item, idx) => (
            <MListRow
              key={idx}
              headline={
                (item.description as string | null | undefined) ??
                (item.inventory_item_id ? `Item ${item.inventory_item_id}` : 'Catalog item')
              }
              supporting={describeItemMeta(item)}
            />
          ))
        )}
      </MListInset>
      <div style={{ marginTop: 16 }}>
        <MButtonRow>
          <MButton variant="ghost" onClick={onCancel} disabled={isPending}>
            Cancel
          </MButton>
          <MButton variant="primary" onClick={onConfirm} disabled={isPending}>
            {isPending ? 'Approving…' : 'Confirm approval'}
          </MButton>
        </MButtonRow>
      </div>
    </div>
  )
}

interface DeclineSheetBodyProps {
  request: RentalRequest
  isPending: boolean
  onCancel: () => void
  onConfirm: (reason: string) => void
}

function DeclineSheetBody({ request, isPending, onCancel, onConfirm }: DeclineSheetBodyProps) {
  const [reason, setReason] = useState('')
  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--m-ink-2)', marginBottom: 8 }}>
        Decline this request from <strong>{request.customer_name ?? request.contact_name ?? 'this customer'}</strong>?
      </p>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--m-ink-3)', marginBottom: 4 }}>
        Reason (optional)
      </label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.currentTarget.value)}
        placeholder="e.g. Inventory unavailable for those dates"
        rows={3}
        style={{
          width: '100%',
          padding: 10,
          fontSize: 14,
          border: '1px solid var(--m-line-2, #ddd)',
          borderRadius: 0,
          fontFamily: 'inherit',
        }}
      />
      <div style={{ marginTop: 16 }}>
        <MButtonRow>
          <MButton variant="ghost" onClick={onCancel} disabled={isPending}>
            Cancel
          </MButton>
          <MButton variant="primary" onClick={() => onConfirm(reason.trim())} disabled={isPending}>
            {isPending ? 'Declining…' : 'Confirm decline'}
          </MButton>
        </MButtonRow>
      </div>
    </div>
  )
}

function summarizeItems(items: RentalRequestItem[]): ReactNode {
  if (items.length === 0) return 'No items requested'
  const totalQty = items.reduce((sum, i) => sum + (Number.isFinite(Number(i.qty)) ? Number(i.qty) : 0), 0)
  return `${items.length} line${items.length === 1 ? '' : 's'} · ${totalQty} unit${totalQty === 1 ? '' : 's'}`
}

function describeItemMeta(item: RentalRequestItem): string {
  const qty = Number.isFinite(Number(item.qty)) ? Number(item.qty) : 0
  const range = formatDateRange(item.start, item.end)
  const delivery = item.delivery ?? 'pickup'
  return [`Qty ${qty}`, range, delivery].filter(Boolean).join(' · ')
}

function formatDateRange(start: string | null, end: string | null): string {
  if (start && end) return `${start} → ${end}`
  if (start) return `From ${start}`
  if (end) return `Until ${end}`
  return ''
}
