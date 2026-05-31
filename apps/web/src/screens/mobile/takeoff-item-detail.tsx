/**
 * `mb-takeoff-item-detail` — scope-item live quantity + assembly breakdown (msg24).
 *
 * Implements Steve's handoff `ITEM · 09 24 00 / EPS BOARD · 2"`: tapping a
 * running-quantity row on the takeoff canvas opens this screen, which shows a
 * LIVE QUANTITY hero ("4,785 SF · 9 polygons · 3 sheets" — total + measurement
 * + sheet provenance), and, when the item resolves to an assembly recipe, the
 * STUCCO-ASSEMBLY parts table (each component's extended price) with an
 * ASSEMBLY SUBTOTAL.
 *
 * All values are REAL: the quantity + provenance sum the item's
 * `takeoff_measurements` for the active draft (useProjectMeasurements); the
 * parts come from the matching assembly (useAssemblies + useAssembly). When no
 * assembly is attached the screen shows the flat item rate instead.
 *
 * Route: projects/:projectId/takeoff-item/:code?draft=<id>
 */
import { useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { MButton, MI } from '../../components/m/index.js'
import { useAssemblies, useAssembly, useProjectMeasurements, type TakeoffMeasurement } from '../../lib/api/takeoff.js'
import { useServiceItems } from '../../lib/api'

export function TakeoffItemDetail({ companySlug }: { companySlug: string }) {
  void companySlug
  const params = useParams<{ projectId: string; code: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const projectId = params.projectId ?? ''
  const code = decodeURIComponent(params.code ?? '')
  const draftId = searchParams.get('draft')

  const measurementsQuery = useProjectMeasurements(projectId, { draftId })
  const all = useMemo(() => measurementsQuery.data?.measurements ?? [], [measurementsQuery.data])
  const rows = useMemo(() => all.filter((m) => m.service_item_code === code), [all, code])

  const serviceItems = useServiceItems()
  const item = (serviceItems.data?.serviceItems ?? []).find((s) => s.code === code) ?? null

  // Assembly (if any) attached to this item — the parts table source.
  const assembliesQuery = useAssemblies(code)
  const attachedId = rows.find((m) => m.assembly_id)?.assembly_id ?? null
  const assemblyId = attachedId ?? assembliesQuery.data?.assemblies[0]?.id ?? null
  const assemblyQuery = useAssembly(assemblyId)

  const totals = useMemo(() => summarise(rows), [rows])
  const unit = (item?.unit ?? rows[0]?.unit ?? '').toUpperCase()

  const back = () => navigate(-1)

  const components = assemblyQuery.data?.components ?? []
  const assembly = assemblyQuery.data?.assembly ?? null
  const flatRate = item?.default_rate ? Number(item.default_rate) : null

  // Per-component extended price = qty/unit × waste × measured quantity × unit cost.
  const pricedParts = components.map((c) => {
    const qtyPer = Number(c.quantity_per_unit) || 0
    const waste = 1 + (Number(c.waste_pct) || 0) / 100
    const unitCost = Number(c.unit_cost) || 0
    const extended = totals.quantity * qtyPer * waste * unitCost
    return { id: c.id, name: c.name, kind: c.kind, unit: c.unit, extended }
  })
  const assemblySubtotal = pricedParts.reduce((s, p) => s + p.extended, 0)
  const flatSubtotal = flatRate != null ? totals.quantity * flatRate : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div className="m-topbar">
        <button type="button" className="m-topbar-back" aria-label="Back" onClick={back}>
          <MI.ChevLeft size={22} />
        </button>
        <div className="m-topbar-title">
          <div className="m-topbar-eyebrow">ITEM · {code}</div>
          <div className="m-h1">{item?.name ?? code}</div>
        </div>
      </div>

      {/* LIVE QUANTITY hero. */}
      <div style={{ padding: '20px', borderBottom: '2px solid var(--m-ink)' }}>
        <div className="m-topbar-eyebrow">LIVE QUANTITY</div>
        <div
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 800,
            fontSize: 56,
            lineHeight: 0.9,
            letterSpacing: '-0.03em',
            marginTop: 8,
            color: 'var(--m-ink)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatQty(totals.quantity)}
          <span style={{ fontSize: 22, color: 'var(--m-ink-3)', marginLeft: 8 }}>{unit}</span>
        </div>
        <div
          style={{ fontFamily: 'var(--m-num)', fontSize: 12, fontWeight: 600, marginTop: 10, color: 'var(--m-ink-2)' }}
        >
          {totals.polygons} POLYGON{totals.polygons === 1 ? '' : 'S'} · {totals.sheets} SHEET
          {totals.sheets === 1 ? '' : 'S'}
          {totals.count !== totals.polygons ? ` · ${totals.count} MEASUREMENT${totals.count === 1 ? '' : 'S'}` : ''}
        </div>
      </div>

      {/* PARTS / assembly breakdown. */}
      <div
        style={{
          padding: '12px 20px',
          background: 'var(--m-card-soft)',
          borderBottom: '2px solid var(--m-ink)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <span className="m-topbar-eyebrow">PARTS</span>
        {assembly ? (
          <span
            style={{
              padding: '4px 8px',
              background: 'var(--m-accent)',
              color: 'var(--m-accent-ink)',
              fontFamily: 'var(--m-num)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            {assembly.name}
          </span>
        ) : null}
      </div>

      <div style={{ flex: 1 }}>
        {assemblyQuery.isLoading ? (
          <div
            style={{ padding: 20, fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-ink-3)', fontWeight: 600 }}
          >
            Loading parts…
          </div>
        ) : pricedParts.length > 0 ? (
          pricedParts.map((p) => (
            <div
              key={p.id}
              style={{
                padding: '14px 20px',
                borderBottom: '1px solid var(--m-line-2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 14 }}>{p.name}</div>
                <div
                  style={{
                    fontFamily: 'var(--m-num)',
                    fontSize: 10,
                    fontWeight: 600,
                    color: 'var(--m-ink-3)',
                    marginTop: 3,
                  }}
                >
                  {formatQty(totals.quantity)} {unit} · {p.kind.toUpperCase()}
                </div>
              </div>
              <div
                style={{
                  fontFamily: 'var(--m-font-display)',
                  fontWeight: 800,
                  fontSize: 18,
                  fontVariantNumeric: 'tabular-nums',
                  flexShrink: 0,
                }}
              >
                {formatMoney(p.extended)}
              </div>
            </div>
          ))
        ) : (
          <div
            style={{
              padding: '14px 20px',
              borderBottom: '1px solid var(--m-line-2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 14 }}>
                {item?.name ?? code}
              </div>
              <div
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--m-ink-3)',
                  marginTop: 3,
                }}
              >
                {flatRate != null ? `FLAT · ${formatMoney(flatRate)} / ${unit}` : 'NO RATE SET'}
              </div>
            </div>
            {flatSubtotal != null ? (
              <div
                style={{
                  fontFamily: 'var(--m-font-display)',
                  fontWeight: 800,
                  fontSize: 18,
                  fontVariantNumeric: 'tabular-nums',
                  flexShrink: 0,
                }}
              >
                {formatMoney(flatSubtotal)}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Subtotal slab. */}
      <div
        style={{
          padding: '16px 20px',
          background: 'var(--m-ink)',
          color: 'var(--m-sand)',
          borderTop: '2px solid var(--m-ink)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color: 'var(--m-ink-4)',
          }}
        >
          {assembly ? 'ASSEMBLY SUBTOTAL' : 'ITEM SUBTOTAL'}
        </span>
        <span
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 800,
            fontSize: 28,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatMoney(assembly ? assemblySubtotal : (flatSubtotal ?? 0))}
        </span>
      </div>

      <div style={{ padding: '14px 20px 18px', borderTop: '2px solid var(--m-ink)' }}>
        <MButton variant="ghost" onClick={back}>
          Back to takeoff
        </MButton>
      </div>
    </div>
  )
}

interface ItemSummary {
  quantity: number
  count: number
  polygons: number
  sheets: number
}

function summarise(rows: TakeoffMeasurement[]): ItemSummary {
  let quantity = 0
  let polygons = 0
  const sheets = new Set<string>()
  for (const m of rows) {
    quantity += Number(m.quantity) || 0
    const geo = m.geometry as { kind?: string }
    if (geo.kind === 'polygon') polygons += 1
    if (m.blueprint_document_id) sheets.add(m.page_id ?? m.blueprint_document_id)
  }
  return { quantity: round2(quantity), count: rows.length, polygons, sheets: sheets.size }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function formatQty(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (Number.isInteger(n)) return String(n)
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

function formatMoney(n: number): string {
  if (!Number.isFinite(n)) return '$0'
  return `$${Math.round(n).toLocaleString()}`
}
