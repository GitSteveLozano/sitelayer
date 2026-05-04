/**
 * Rental dispatch — `rent-dispatch`. Send equipment to a project.
 * Picks: project · equipment · driver · billing toggle.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listInventoryItems, type BootstrapResponse, type InventoryItemRow } from '../../api.js'
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
  const [projectId, setProjectId] = useState<string>('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [billUpfront, setBillUpfront] = useState(true)

  useEffect(() => {
    listInventoryItems(companySlug).then((r) => setItems(r.inventoryItems.filter((i) => i.active)))
  }, [companySlug])

  const projects = (bootstrap?.projects ?? []).filter((p) => /progress|active/i.test(p.status))

  return (
    <>
      <MTopBar back title="Dispatch" onBack={() => navigate('/m/rentals')} />
      <MBody pad>
        <MSectionH>To project</MSectionH>
        <MSelect
          value={projectId}
          onChange={(e) => setProjectId(e.currentTarget.value)}
          style={{ width: '100%' }}
        >
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
        <div style={{ padding: 16, marginTop: 12 }}>
          <MButtonStack>
            <MButton
              variant="primary"
              disabled={!projectId || picked.size === 0}
              onClick={() => navigate('/m/rentals')}
            >
              Dispatch {picked.size || 0} {picked.size === 1 ? 'item' : 'items'}
            </MButton>
            <MButton variant="ghost" onClick={() => navigate('/m/rentals')}>
              Cancel
            </MButton>
          </MButtonStack>
        </div>
      </MBody>
    </>
  )
}