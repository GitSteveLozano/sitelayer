/**
 * Rental dispatch — `rent-dispatch`. Send equipment to a project.
 * Picks: project · equipment · driver · billing toggle.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  apiPost,
  listInventoryItems,
  listInventoryLocations,
  type BootstrapResponse,
  type InventoryItemRow,
  type InventoryLocationRow,
} from '../../api-v1-compat.js'
import {
  MBody,
  MButton,
  MButtonStack,
  MChip,
  MChipRow,
  MI,
  MListInset,
  MListRow,
  MSectionH,
  MSelect,
  MTopBar,
} from '../../components/m/index.js'

export function MobileRentalDispatch({
  bootstrap,
  companySlug,
}: {
  bootstrap: BootstrapResponse | null
  companySlug: string
}) {
  const navigate = useNavigate()
  const [items, setItems] = useState<readonly InventoryItemRow[]>([])
  const [yards, setYards] = useState<readonly InventoryLocationRow[]>([])
  const [projectId, setProjectId] = useState<string>('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
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

  const projects = (bootstrap?.projects ?? []).filter((p) => /progress|active/i.test(p.status))

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
            movement_type: 'dispatch',
            bill_mode: billUpfront ? 'upfront' : 'on_return',
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

  return (
    <>
      <MTopBar back title="Dispatch" onBack={() => navigate('/rentals')} />
      <MBody pad>
        <MSectionH>To project</MSectionH>
        <MSelect value={projectId} onChange={(e) => setProjectId(e.currentTarget.value)} style={{ width: '100%' }}>
          <option value="">Pick a project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </MSelect>
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
        <MSectionH>Billing</MSectionH>
        <MChipRow>
          <MChip active={billUpfront} onClick={() => setBillUpfront(true)}>
            Bill upfront
          </MChip>
          <MChip active={!billUpfront} onClick={() => setBillUpfront(false)}>
            At return
          </MChip>
        </MChipRow>
        {error ? <div style={{ padding: '8px 16px 0', color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
        <div style={{ padding: 16, marginTop: 12 }}>
          <MButtonStack>
            <MButton
              variant="primary"
              disabled={!projectId || picked.size === 0 || busy || yards.length === 0}
              onClick={handleDispatch}
            >
              {busy ? 'Dispatching…' : `Dispatch ${picked.size || 0} ${picked.size === 1 ? 'item' : 'items'}`}
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
