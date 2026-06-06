/**
 * Rental dispatch — `rent-dispatch`. Send equipment to a project.
 * Picks: project · equipment · driver · billing toggle.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  apiPost,
  listInventoryItems,
  listInventoryLocations,
  type BootstrapResponse,
  type InventoryItem,
  type InventoryLocation,
} from '@/lib/api'
import {
  MBody,
  MButton,
  MButtonStack,
  MChip,
  MChipRow,
  MI,
  MInput,
  MListInset,
  MListRow,
  MSectionH,
  MSelect,
  MTopBar,
} from '../../components/m/index.js'
import { formatMoney } from './format.js'

export function MobileRentalDispatch({
  bootstrap,
  companySlug,
}: {
  bootstrap: BootstrapResponse | null
  companySlug: string
}) {
  const navigate = useNavigate()
  // When dispatch is entered from an asset detail it carries `?asset=<id>`,
  // so the screen can lead with a single ASSET subject header (msg__72)
  // instead of the multi-select equipment list.
  const [params] = useSearchParams()
  const assetParam = params.get('asset')
  const [items, setItems] = useState<readonly InventoryItem[]>([])
  const [yards, setYards] = useState<readonly InventoryLocation[]>([])
  const [projectId, setProjectId] = useState<string>('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [workerId, setWorkerId] = useState<string>('')
  const [estReturn, setEstReturn] = useState<string>('')
  const [billUpfront, setBillUpfront] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listInventoryItems(companySlug).then((r) => setItems(r.inventoryItems.filter((i) => i.active)))
    listInventoryLocations(companySlug).then((r) =>
      // Yards first (default sort), then job-site/service. The API
      // already excludes soft-deleted rows.
      setYards(r.inventoryLocations.filter((l) => l.location_type === 'yard')),
    )
  }, [companySlug])

  // If launched from an asset, preselect it so the picked set + projected
  // revenue line up with the single-asset header.
  useEffect(() => {
    if (assetParam) setPicked(new Set([assetParam]))
  }, [assetParam])

  const projects = (bootstrap?.projects ?? []).filter((p) => /progress|active/i.test(p.status))
  const workers = (bootstrap?.workers ?? []).filter((w) => !w.deleted_at)
  const subjectAsset = useMemo(
    () => (assetParam ? (items.find((i) => i.id === assetParam) ?? null) : null),
    [assetParam, items],
  )

  // Projected revenue preview = picked day-rates × estimated rental days.
  const dayRateTotal = Array.from(picked).reduce((sum, id) => {
    const it = items.find((i) => i.id === id)
    return sum + Number(it?.default_rental_rate ?? 0)
  }, 0)
  const rentalDays = estReturn ? daysFromToday(estReturn) : null
  const projectedRevenue = rentalDays && dayRateTotal ? rentalDays * dayRateTotal : 0

  const handleDispatch = async () => {
    if (!projectId || picked.size === 0 || yards.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const fromLocationId = yards[0]!.id
      const ids = Array.from(picked)
      // Sequential POSTs so a single 4xx shows up clearly to the user
      // instead of being lost in a parallel rejection.
      for (const itemId of ids) {
        await apiPost(
          '/api/inventory/movements',
          {
            inventory_item_id: itemId,
            quantity: 1,
            from_location_id: fromLocationId,
            project_id: projectId,
            worker_id: workerId || null,
            movement_type: 'dispatch',
            bill_mode: billUpfront ? 'upfront' : 'on_return',
            expected_return_at: estReturn || null,
          },
          companySlug,
        )
      }
      navigate('/rentals')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const canDispatch = !!projectId && picked.size > 0 && !busy && yards.length > 0
  const dispatchYard = yards[0]

  return (
    <>
      <MTopBar back title="DISPATCH" onBack={() => navigate('/rentals')} />
      <MBody pad>
        {/* ASSET subject header — when launched from a single asset (msg__72). */}
        {subjectAsset ? (
          <>
            <MSectionH>Asset</MSectionH>
            <div style={{ marginBottom: 4 }}>
              <div
                style={{
                  fontFamily: 'var(--m-font-display)',
                  fontWeight: 800,
                  fontSize: 24,
                  lineHeight: 1.1,
                  letterSpacing: '-0.01em',
                }}
              >
                {subjectAsset.description}
              </div>
              <div
                className="num"
                style={{ marginTop: 6, color: 'var(--m-ink-3)', fontWeight: 600, letterSpacing: '0.04em' }}
              >
                {subjectAsset.code} · {formatMoney(Number(subjectAsset.default_rental_rate ?? 0))}/
                {subjectAsset.unit || 'DAY'}
              </div>
            </div>
          </>
        ) : null}

        {/* TO PROJECT — square accent picker field, mono micro-label */}
        <MSectionH>To project</MSectionH>
        <MSelect
          value={projectId}
          onChange={(e) => setProjectId(e.currentTarget.value)}
          style={{
            width: '100%',
            background: 'var(--m-accent)',
            color: 'var(--m-accent-ink)',
            fontFamily: 'var(--m-font-display)',
            fontWeight: 700,
            fontSize: 16,
          }}
        >
          <option value="">PICK A PROJECT…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </MSelect>

        {/* FROM YARD — mono micro-label readout of the dispatch origin */}
        <MSectionH>From yard</MSectionH>
        <div
          style={{
            padding: '14px 16px',
            background: 'var(--m-card-soft)',
            border: '2px solid var(--m-ink)',
            fontFamily: 'var(--m-num)',
            fontWeight: 600,
            fontSize: 12,
            color: dispatchYard ? 'var(--m-ink)' : 'var(--m-red)',
            textTransform: 'uppercase',
          }}
        >
          {dispatchYard ? dispatchYard.name : 'NO YARD AVAILABLE'}
        </div>

        {/* HANDOFF TO — required foreman/driver for the dispatch (msg__72). */}
        <MSectionH>Handoff to</MSectionH>
        <MSelect value={workerId} onChange={(e) => setWorkerId(e.currentTarget.value)} style={{ width: '100%' }}>
          <option value="">PICK A FOREMAN / DRIVER…</option>
          {workers.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </MSelect>

        {/* EQUIPMENT — square tap rows (skipped when a single asset is the subject). */}
        {subjectAsset ? null : (
          <>
            <MSectionH>Equipment</MSectionH>
            <MListInset>
              {items.length === 0 ? (
                <MListRow headline="No equipment available" supporting="Add inventory first." />
              ) : (
                items.slice(0, 12).map((item) => {
                  const isPicked = picked.has(item.id)
                  return (
                    <MListRow
                      key={item.id}
                      leading={<MI.Truck size={18} />}
                      leadingTone={isPicked ? 'accent' : undefined}
                      headline={item.description}
                      supporting={`${item.code} · $${item.default_rental_rate}/${item.unit || 'day'}`}
                      trailing={isPicked ? <MI.Check size={18} /> : null}
                      onTap={() => {
                        setPicked((cur) => {
                          const next = new Set(cur)
                          if (next.has(item.id)) next.delete(item.id)
                          else next.add(item.id)
                          return next
                        })
                      }}
                    />
                  )
                })
              )}
            </MListInset>
          </>
        )}

        {/* ESTIMATED RETURN — big date + projected-revenue meta (msg__72). */}
        <MSectionH>Estimated return</MSectionH>
        <MInput
          type="date"
          value={estReturn}
          onChange={(e) => setEstReturn(e.currentTarget.value)}
          style={{ width: '100%', fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 20 }}
        />
        {rentalDays ? (
          <div
            className="num"
            style={{ marginTop: 8, color: 'var(--m-ink-3)', fontWeight: 600, letterSpacing: '0.04em' }}
          >
            {rentalDays} {rentalDays === 1 ? 'DAY' : 'DAYS'}
            {projectedRevenue ? ` · ~${formatMoney(projectedRevenue)} REVENUE` : ''}
          </div>
        ) : null}

        {/* BILLING — square chip toggle */}
        <MSectionH>Billing</MSectionH>
        <MChipRow>
          <MChip active={billUpfront} onClick={() => setBillUpfront(true)}>
            Bill upfront
          </MChip>
          <MChip active={!billUpfront} onClick={() => setBillUpfront(false)}>
            At return
          </MChip>
        </MChipRow>

        {error ? (
          <div
            style={{
              marginTop: 12,
              padding: '12px 16px',
              border: '2px solid var(--m-red)',
              color: 'var(--m-red)',
              fontFamily: 'var(--m-num)',
              fontWeight: 600,
              fontSize: 12,
            }}
          >
            {error}
          </div>
        ) : null}

        {/* CONFIRM — full-width primary CTA on a top-bordered footer */}
        <div
          style={{
            marginTop: 24,
            paddingTop: 16,
            borderTop: '2px solid var(--m-ink)',
          }}
        >
          <MButtonStack>
            <MButton variant="primary" disabled={!canDispatch} onClick={handleDispatch}>
              {busy ? 'DISPATCHING…' : `CONFIRM · DISPATCH ${picked.size || 0} ${picked.size === 1 ? 'ITEM' : 'ITEMS'}`}
            </MButton>
            <MButton variant="ghost" onClick={() => navigate('/rentals')}>
              Cancel
            </MButton>
          </MButtonStack>
        </div>
      </MBody>
    </>
  )
}

/** Whole rental days from today to a `YYYY-MM-DD` return date (>= 0). */
function daysFromToday(returnDate: string): number {
  const [y, m, d] = returnDate.split('-').map(Number)
  if (!y || !m || !d) return 0
  const end = new Date(y, m - 1, d).valueOf()
  const today = new Date()
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).valueOf()
  return Math.max(0, Math.round((end - start) / 86_400_000))
}
