import { Link, useParams } from 'react-router-dom'
import { EmptyState } from '@/components/shell/EmptyState'
import {
  readCart as machineReadCart,
  useRentalsPortal,
  writeCart as machineWriteCart,
  type PortalCartLine as MachinePortalCartLine,
  type PortalCatalogItem as MachinePortalCatalogItem,
} from '@/machines/rentals-portal'

/**
 * Public customer rental portal — Browse view.
 *
 * Mirrors the sales-loop slice's `apps/web/src/portal/` layout: signed-token
 * gated, no Clerk auth, plain `fetch` to public endpoints (no Bearer / no
 * `x-sitelayer-company-slug` header). The token comes in via the URL slug
 * `:shareToken` and is included verbatim on every request; the API verifies
 * the HMAC before returning data.
 *
 * State (catalog snapshot, filters, cart, loading/error) lives in the
 * `rentalsPortal` XState machine. Cart persistence is performed inside
 * the machine via a `persistCart` side-effect action that writes to
 * localStorage on every mutation.
 *
 * Reservation submit (in `RentalsCart.tsx`) hits
 * `POST /portal/rentals/:share_token/reserve` which lands a row in
 * `rental_requests` for the operator to approve.
 *
 * Note: `RentalsCart.tsx` still imports `readCart`, `writeCart`, and
 * `PortalCartLine` from this module, so we re-export the machine's
 * versions for compatibility. The storage key contract between the two
 * screens is preserved.
 */

export type PortalCatalogItem = MachinePortalCatalogItem
export type PortalCartLine = MachinePortalCartLine
export const readCart = machineReadCart
export const writeCart = machineWriteCart

export function RentalsPortal() {
  const params = useParams<{ shareToken: string }>()
  const shareToken = params.shareToken ?? ''
  const portal = useRentalsPortal(shareToken)

  if (!shareToken) {
    return <div style={{ padding: 32 }}>Missing share token.</div>
  }
  if (portal.isLoading) {
    return <div style={{ padding: 32 }}>Loading catalog…</div>
  }
  if (portal.error) {
    return (
      <div style={{ padding: 32, color: 'var(--m-red)' }}>
        Catalog unavailable: {portal.error}
        <p style={{ fontSize: 12, marginTop: 8 }}>
          The link may have expired. Contact the company that sent it for a fresh share link.
        </p>
      </div>
    )
  }

  return (
    <div className="p-app">
      <header
        style={{
          padding: '16px 24px',
          borderBottom: '1px solid var(--p-line-2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <strong style={{ fontSize: 18 }}>Rental catalog</strong>
          <p style={{ fontSize: 12, margin: 0, color: 'var(--p-text-3)' }}>
            {portal.items.length} item{portal.items.length === 1 ? '' : 's'} available
          </p>
        </div>
        <Link
          to={`/portal/rentals/${encodeURIComponent(shareToken)}/cart`}
          style={{ textDecoration: 'none', padding: '8px 16px', border: '1px solid var(--p-line)', borderRadius: 6 }}
        >
          Cart ({portal.cart.length})
        </Link>
      </header>

      <div style={{ display: 'flex', gap: 12, padding: '16px 24px', borderBottom: '1px solid var(--p-line-3)' }}>
        <input
          type="text"
          placeholder="Search…"
          value={portal.query}
          onChange={(e) => portal.setQuery(e.target.value)}
          style={{ flex: 1, padding: 8, border: '1px solid var(--p-line)', borderRadius: 4 }}
        />
        <select value={portal.category} onChange={(e) => portal.setCategory(e.target.value)} style={{ padding: 8 }}>
          {portal.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div
        style={{
          padding: 24,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 16,
        }}
      >
        {portal.filtered.map((item) => (
          <CatalogCard key={item.id} item={item} onAdd={portal.addToCart} />
        ))}
      </div>

      {portal.filtered.length === 0 ? (
        <EmptyState
          title={portal.query || portal.category !== 'All' ? 'No items match' : 'Catalog is empty'}
          body={
            portal.query || portal.category !== 'All'
              ? 'Try clearing the search or category filter.'
              : 'Ask the operator to publish inventory items.'
          }
        />
      ) : null}
    </div>
  )
}

function CatalogCard({ item, onAdd }: { item: PortalCatalogItem; onAdd: (line: PortalCartLine) => void }) {
  const today = new Date().toISOString().slice(0, 10)
  const inOneWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return (
    <div style={{ border: '1px solid var(--p-line-2)', borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 11, color: 'var(--p-text-4)', textTransform: 'uppercase', letterSpacing: 1 }}>
        {item.category}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{item.code}</div>
      <p style={{ fontSize: 13, color: 'var(--p-text-2)', margin: '4px 0 8px' }}>{item.description}</p>
      <div style={{ fontSize: 14, fontWeight: 600 }}>
        ${Number(item.default_rental_rate).toFixed(2)}
        <span style={{ fontSize: 11, color: 'var(--p-text-4)' }}>/{item.unit}</span>
      </div>
      <button
        type="button"
        onClick={() =>
          onAdd({
            inventory_item_id: item.id,
            qty: 1,
            start: today,
            end: inOneWeek,
            delivery: 'pickup',
          })
        }
        style={{
          marginTop: 12,
          width: '100%',
          padding: '8px 12px',
          background: 'var(--p-ink)',
          color: 'var(--p-paper)',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        Add to cart
      </button>
    </div>
  )
}
