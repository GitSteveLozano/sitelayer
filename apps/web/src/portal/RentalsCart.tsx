import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { API_URL } from '@/lib/api'
import { MBanner } from '@/components/m'
import { EmptyState } from '@/components/shell/EmptyState'
import { readCart, writeCart, type PortalCartLine } from './RentalsPortal'

/**
 * Public cart + reservation submission for the customer rental portal.
 *
 * Reads the cart out of localStorage (same key as the catalog view), lets
 * the customer adjust qty / dates / delivery method, and submits to
 * `POST /portal/rentals/:share_token/reserve`. The server lands a
 * `rental_requests` row + a mutation_outbox entry so operators see the
 * request in the standard sync feed; there's no live confirmation here —
 * the operator review approves it out-of-band.
 */

export interface ReserveResponse {
  id: string
  status: string
  created_at: string
}

async function postReserve(
  shareToken: string,
  body: {
    items: PortalCartLine[]
    requested_start: string | null
    requested_end: string | null
    contact_name: string
    contact_email: string
    contact_phone: string
    notes: string | null
  },
): Promise<ReserveResponse> {
  const url = `${API_URL}/api/portal/rentals/${encodeURIComponent(shareToken)}/reserve`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error ?? `Reserve failed (${response.status})`)
  }
  return (await response.json()) as ReserveResponse
}

export function RentalsCart() {
  const params = useParams<{ shareToken: string }>()
  const shareToken = params.shareToken ?? ''
  const navigate = useNavigate()
  const [cart, setCart] = useState<PortalCartLine[]>(() => readCart())
  const [contactName, setContactName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    writeCart(cart)
  }, [cart])

  const range = useMemo(() => {
    if (cart.length === 0) return { start: null, end: null }
    const start = cart.reduce((min, l) => (l.start && (!min || l.start < min) ? l.start : min), '')
    const end = cart.reduce((max, l) => (l.end && (!max || l.end > max) ? l.end : max), '')
    return { start: start || null, end: end || null }
  }, [cart])

  function updateLine(index: number, patch: Partial<PortalCartLine>) {
    setCart((cur) => cur.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }
  function removeLine(index: number) {
    setCart((cur) => cur.filter((_, i) => i !== index))
  }

  async function onSubmit() {
    setError(null)
    if (cart.length === 0) {
      setError('Cart is empty.')
      return
    }
    setSubmitting(true)
    try {
      const response = await postReserve(shareToken, {
        items: cart,
        requested_start: range.start,
        requested_end: range.end,
        contact_name: contactName,
        contact_email: contactEmail,
        contact_phone: contactPhone,
        notes: notes || null,
      })
      // Clear the cart so the confirm screen is the only place the
      // request id is referenced from this device.
      setCart([])
      navigate(`/portal/rentals/${encodeURIComponent(shareToken)}/confirm?id=${encodeURIComponent(response.id)}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reserve failed')
    } finally {
      setSubmitting(false)
    }
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
                    onChange={(e) => updateLine(i, { qty: Math.max(1, Math.floor(Number(e.target.value || 1))) })}
                    style={{ width: '100%', padding: 6, border: '1px solid #ddd', borderRadius: 4 }}
                  />
                </label>
                <label>
                  <span style={{ fontSize: 11, color: '#666' }}>Delivery</span>
                  <select
                    value={line.delivery}
                    onChange={(e) => updateLine(i, { delivery: e.target.value as PortalCartLine['delivery'] })}
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
                    onChange={(e) => updateLine(i, { start: e.target.value })}
                    style={{ width: '100%', padding: 6, border: '1px solid #ddd', borderRadius: 4 }}
                  />
                </label>
                <label>
                  <span style={{ fontSize: 11, color: '#666' }}>End</span>
                  <input
                    type="date"
                    value={line.end}
                    onChange={(e) => updateLine(i, { end: e.target.value })}
                    style={{ width: '100%', padding: 6, border: '1px solid #ddd', borderRadius: 4 }}
                  />
                </label>
              </div>
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#666' }}>Item id: {line.inventory_item_id.slice(0, 8)}…</span>
                <button
                  type="button"
                  onClick={() => removeLine(i)}
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
          value={contactName}
          onChange={(e) => setContactName(e.target.value)}
          style={{ padding: 8, border: '1px solid #ddd', borderRadius: 4 }}
        />
        <input
          type="email"
          placeholder="Email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          style={{ padding: 8, border: '1px solid #ddd', borderRadius: 4 }}
        />
        <input
          type="tel"
          placeholder="Phone"
          value={contactPhone}
          onChange={(e) => setContactPhone(e.target.value)}
          style={{ padding: 8, border: '1px solid #ddd', borderRadius: 4 }}
        />
        <textarea
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          style={{ padding: 8, border: '1px solid #ddd', borderRadius: 4 }}
        />
      </div>

      {error ? (
        <div style={{ marginTop: 16 }}>
          <MBanner tone="error" title="Could not reserve" body={error} />
        </div>
      ) : null}

      <button
        type="button"
        onClick={onSubmit}
        disabled={cart.length === 0 || submitting}
        style={{
          marginTop: 24,
          padding: '12px 24px',
          background: cart.length === 0 || submitting ? '#aaa' : '#222',
          color: 'white',
          border: 'none',
          borderRadius: 6,
          cursor: cart.length === 0 || submitting ? 'not-allowed' : 'pointer',
        }}
      >
        {submitting ? 'Submitting…' : 'Reserve'}
      </button>
      <p style={{ fontSize: 12, color: '#888', marginTop: 8 }}>
        The company will review your request and confirm by email or phone.
      </p>
    </div>
  )
}
