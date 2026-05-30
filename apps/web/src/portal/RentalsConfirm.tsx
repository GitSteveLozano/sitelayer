import { Link, useParams, useSearchParams } from 'react-router-dom'

/**
 * Public confirmation view for the customer rental portal.
 *
 * Lands here after the cart has POSTed `/portal/rentals/:share_token/reserve`.
 * The id arrives via `?id=…`. There's no live status follow-up surface today
 * (the operator approves out-of-band); this view exists so the customer
 * has a stable URL that names the reservation reference.
 */
export function RentalsConfirm() {
  const params = useParams<{ shareToken: string }>()
  const shareToken = params.shareToken ?? ''
  const [search] = useSearchParams()
  const requestId = search.get('id')

  return (
    <div className="p-app" style={{ maxWidth: 720, margin: '0 auto', padding: 32, textAlign: 'center' }}>
      <div style={{ fontSize: 48, color: 'var(--m-green)' }}>✓</div>
      <h1 style={{ fontSize: 24, margin: '8px 0' }}>Reservation submitted</h1>
      <p style={{ color: 'var(--p-text-3)', maxWidth: 520, margin: '8px auto 0' }}>
        Your reservation request has been submitted. The company will review and confirm by email or phone within their
        normal business hours.
      </p>
      {requestId ? (
        <p style={{ marginTop: 16, fontSize: 13, color: 'var(--p-text-2)' }}>
          Reference: <strong>{requestId}</strong>
        </p>
      ) : null}

      <div style={{ marginTop: 32 }}>
        <Link
          to={`/portal/rentals/${encodeURIComponent(shareToken)}`}
          style={{
            padding: '10px 20px',
            border: '1px solid var(--p-line)',
            borderRadius: 6,
            textDecoration: 'none',
            color: 'var(--p-ink)',
          }}
        >
          Browse more equipment
        </Link>
      </div>
    </div>
  )
}
