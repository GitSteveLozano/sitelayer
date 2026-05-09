import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { API_URL } from '@/lib/api'

/**
 * Public customer rental portal — Browse view.
 *
 * Mirrors the sales-loop slice's `apps/web/src/portal/` layout: signed-token
 * gated, no Clerk auth, plain `fetch` to public endpoints (no Bearer / no
 * `x-sitelayer-company-slug` header). The token comes in via the URL slug
 * `:shareToken` and is included verbatim on every request; the API verifies
 * the HMAC before returning data.
 *
 * Cart state lives in localStorage so refresh persists what the customer
 * built up. Reservation submit hits `POST /portal/rentals/:share_token/reserve`
 * which lands a row in `rental_requests` for the operator to approve.
 */

export interface PortalCatalogItem {
  id: string
  code: string
  description: string
  category: string
  unit: string
  default_rental_rate: string
  replacement_value: string | null
}

export interface PortalCartLine {
  inventory_item_id: string
  qty: number
  start: string
  end: string
  delivery: 'pickup' | 'delivery'
}

const CART_STORAGE_KEY = 'sitelayer:portal:rentals:cart'

export function readCart(): PortalCartLine[] {
  try {
    const raw = window.localStorage.getItem(CART_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as PortalCartLine[]) : []
  } catch {
    return []
  }
}

export function writeCart(cart: PortalCartLine[]): void {
  try {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart))
  } catch {
    // localStorage blocked (incognito, full disk) — silently degrade. The
    // session-only state still works because the in-memory cart is the
    // source of truth.
  }
}

async function fetchCatalog(shareToken: string): Promise<{ items: PortalCatalogItem[] }> {
  const url = `${API_URL}/portal/rentals/${encodeURIComponent(shareToken)}/catalog`
  const response = await fetch(url, { method: 'GET' })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Catalog request failed (${response.status})`)
  }
  return (await response.json()) as { items: PortalCatalogItem[] }
}

export function RentalsPortal() {
  const params = useParams<{ shareToken: string }>()
  const shareToken = params.shareToken ?? ''
  const [items, setItems] = useState<PortalCatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('All')
  const [cart, setCart] = useState<PortalCartLine[]>(() => readCart())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchCatalog(shareToken)
      .then((res) => {
        if (cancelled) return
        setItems(res.items)
        setError(null)
      })
      .catch((err: Error) => {
        if (cancelled) return
        setError(err.message)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [shareToken])

  useEffect(() => {
    writeCart(cart)
  }, [cart])

  const categories = useMemo(() => {
    const set = new Set<string>(['All'])
    for (const i of items) if (i.category) set.add(i.category)
    return Array.from(set)
  }, [items])

  const filtered = items.filter((i) => {
    if (category !== 'All' && i.category !== category) return false
    if (query && !`${i.code} ${i.description}`.toLowerCase().includes(query.toLowerCase())) return false
    return true
  })

  function addToCart(line: PortalCartLine) {
    setCart((cur) => [...cur, line])
  }

  if (!shareToken) {
    return <div style={{ padding: 32 }}>Missing share token.</div>
  }
  if (loading) {
    return <div style={{ padding: 32 }}>Loading catalog…</div>
  }
  if (error) {
    return (
      <div style={{ padding: 32, color: '#a44' }}>
        Catalog unavailable: {error}
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
          borderBottom: '1px solid #e5e5e5',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <strong style={{ fontSize: 18 }}>Rental catalog</strong>
          <p style={{ fontSize: 12, margin: 0, color: '#666' }}>
            {items.length} item{items.length === 1 ? '' : 's'} available
          </p>
        </div>
        <Link
          to={`/portal/rentals/${encodeURIComponent(shareToken)}/cart`}
          style={{ textDecoration: 'none', padding: '8px 16px', border: '1px solid #ddd', borderRadius: 6 }}
        >
          Cart ({cart.length})
        </Link>
      </header>

      <div style={{ display: 'flex', gap: 12, padding: '16px 24px', borderBottom: '1px solid #f1f1f1' }}>
        <input
          type="text"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, padding: 8, border: '1px solid #ddd', borderRadius: 4 }}
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ padding: 8 }}>
          {categories.map((c) => (
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
        {filtered.map((item) => (
          <CatalogCard key={item.id} item={item} onAdd={addToCart} />
        ))}
      </div>

      {filtered.length === 0 ? <div style={{ padding: 24, color: '#888' }}>No items matched your search.</div> : null}
    </div>
  )
}

function CatalogCard({ item, onAdd }: { item: PortalCatalogItem; onAdd: (line: PortalCartLine) => void }) {
  const today = new Date().toISOString().slice(0, 10)
  const inOneWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return (
    <div style={{ border: '1px solid #e5e5e5', borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>{item.category}</div>
      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{item.code}</div>
      <p style={{ fontSize: 13, color: '#444', margin: '4px 0 8px' }}>{item.description}</p>
      <div style={{ fontSize: 14, fontWeight: 600 }}>
        ${Number(item.default_rental_rate).toFixed(2)}
        <span style={{ fontSize: 11, color: '#888' }}>/{item.unit}</span>
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
          background: '#222',
          color: 'white',
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
