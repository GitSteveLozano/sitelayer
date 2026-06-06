import { useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { MBanner } from '@/components/m'
import { EmptyState } from '@/components/shell/EmptyState'
import { useRentalsPortalContext } from './RentalsPortalProvider'
import type { PortalCartLine } from './RentalsPortal'

/**
 * Public cart + reservation submission for the customer rental portal.
 *
 * Renders + dispatches against the ONE lifted `rentalsPortal` machine
 * (via `useRentalsPortalContext`). The cart, the per-line edits, the
 * contact draft, and the `/reserve` POST all live on that machine —
 * this screen owns no business useState. On `RESERVE` the machine's
 * `reserveRequest` actor POSTs `/portal/rentals/:share_token/reserve`,
 * which lands a `rental_requests` row + a mutation_outbox entry; the
 * operator approves out-of-band. When the machine reaches `reserved`
 * we navigate to the confirm screen (UI nav on the React boundary).
 */

export function RentalsCart() {
  const params = useParams<{ shareToken: string }>()
  const shareToken = params.shareToken ?? ''
  const navigate = useNavigate()
  const portal = useRentalsPortalContext()
  const { cart, contact, range, requestId, reserveError, isReserving, isReserved } = portal

  // When the machine completes the reservation, hop to the confirm
  // screen with the request id deep-link (resume/refresh fallback). The
  // confirm screen reads the id from machine context first.
  useEffect(() => {
    if (isReserved && requestId) {
      navigate(`/portal/rentals/${encodeURIComponent(shareToken)}/confirm?id=${encodeURIComponent(requestId)}`)
    }
  }, [isReserved, requestId, navigate, shareToken])

  function onReserve() {
    if (cart.length === 0) return
    portal.reserve()
  }

  return (
    <div className="p-app" style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <Link to={`/portal/rentals/${encodeURIComponent(shareToken)}`} style={{ fontSize: 13 }}>
        ← Back to catalog
      </Link>
      <h1 style={{ fontSize: 24, marginTop: 16 }}>Cart</h1>

      {cart.length === 0 ? (
        <div style={{ marginTop: 16 }}>
          <EmptyState
            title="Cart is empty"
            body="Add equipment from the catalog to request a reservation."
            primaryAction={
              <Link
                to={`/portal/rentals/${encodeURIComponent(shareToken)}`}
                style={{
                  display: 'inline-block',
                  padding: '10px 16px',
                  borderRadius: 8,
                  background: 'var(--m-accent, #d9904a)',
                  color: '#fff',
                  textDecoration: 'none',
                }}
              >
                Browse catalog
              </Link>
            }
          />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          {cart.map((line, i) => (
            <div key={i} style={{ border: '1px solid #e5e5e5', borderRadius: 8, padding: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                <label>
                  <span style={{ fontSize: 11, color: '#666' }}>Qty</span>
                  <input
                    type="number"
                    min="1"
                    value={line.qty}
                    onChange={(e) =>
                      portal.updateLine(i, { qty: Math.max(1, Math.floor(Number(e.target.value || 1))) })
                    }
                    style={{ width: '100%', padding: 6, border: '1px solid #ddd', borderRadius: 4 }}
                  />
                </label>
                <label>
                  <span style={{ fontSize: 11, color: '#666' }}>Delivery</span>
                  <select
                    value={line.delivery}
                    onChange={(e) => portal.updateLine(i, { delivery: e.target.value as PortalCartLine['delivery'] })}
                    style={{ width: '100%', padding: 6 }}
                  >
                    <option value="pickup">Pickup</option>
                    <option value="delivery">Delivery</option>
                  </select>
                </label>
                <label>
                  <span style={{ fontSize: 11, color: '#666' }}>Start</span>
                  <input
                    type="date"
                    value={line.start}
                    onChange={(e) => portal.updateLine(i, { start: e.target.value })}
                    style={{ width: '100%', padding: 6, border: '1px solid #ddd', borderRadius: 4 }}
                  />
                </label>
                <label>
                  <span style={{ fontSize: 11, color: '#666' }}>End</span>
                  <input
                    type="date"
                    value={line.end}
                    onChange={(e) => portal.updateLine(i, { end: e.target.value })}
                    style={{ width: '100%', padding: 6, border: '1px solid #ddd', borderRadius: 4 }}
                  />
                </label>
              </div>
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#666' }}>Item id: {line.inventory_item_id.slice(0, 8)}…</span>
                <button
                  type="button"
                  onClick={() => portal.removeLine(i)}
                  style={{ background: 'none', border: 'none', color: '#a44', cursor: 'pointer' }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 16, marginTop: 32 }}>Contact</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        <input
          type="text"
          placeholder="Name"
          value={contact.name}
          onChange={(e) => portal.setContact('name', e.target.value)}
          style={{ padding: 8, border: '1px solid #ddd', borderRadius: 4 }}
        />
        <input
          type="email"
          placeholder="Email"
          value={contact.email}
          onChange={(e) => portal.setContact('email', e.target.value)}
          style={{ padding: 8, border: '1px solid #ddd', borderRadius: 4 }}
        />
        <input
          type="tel"
          placeholder="Phone"
          value={contact.phone}
          onChange={(e) => portal.setContact('phone', e.target.value)}
          style={{ padding: 8, border: '1px solid #ddd', borderRadius: 4 }}
        />
        <textarea
          placeholder="Notes (optional)"
          value={contact.notes}
          onChange={(e) => portal.setContact('notes', e.target.value)}
          rows={3}
          style={{ padding: 8, border: '1px solid #ddd', borderRadius: 4 }}
        />
      </div>

      {range.start || range.end ? (
        <p style={{ fontSize: 12, color: '#888', marginTop: 8 }}>
          Requested window: {range.start ?? '—'} → {range.end ?? '—'}
        </p>
      ) : null}

      {reserveError ? (
        <div style={{ marginTop: 16 }}>
          <MBanner tone="error" title="Could not reserve" body={reserveError} />
        </div>
      ) : null}

      <button
        type="button"
        onClick={onReserve}
        disabled={cart.length === 0 || isReserving}
        style={{
          marginTop: 24,
          padding: '12px 24px',
          background: cart.length === 0 || isReserving ? '#aaa' : '#222',
          color: 'white',
          border: 'none',
          borderRadius: 6,
          cursor: cart.length === 0 || isReserving ? 'not-allowed' : 'pointer',
        }}
      >
        {isReserving ? 'Submitting…' : 'Reserve'}
      </button>
      <p style={{ fontSize: 12, color: '#888', marginTop: 8 }}>
        The company will review your request and confirm by email or phone.
      </p>
    </div>
  )
}
