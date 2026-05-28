/**
 * Rentals · Service log — `rent-service`. Maintenance / service history for
 * the rental yard (or a single asset when `:assetId` is present). Mirrors
 * Steve's v2 brutalist `V2RentService`: square borders, mono micro-labels,
 * a two-up KPI strip, a "LOG SERVICE" primary action that opens an inline
 * form, and a full-bleed list of past service entries.
 *
 * There is NO dedicated service-log API yet. We derive a (currently empty)
 * history from the inventory items so the screen has real asset context,
 * and keep newly-logged entries in local component state. When a
 * maintenance endpoint lands, swap `entries` over to a query/mutation pair.
 *
 * TODO(maintenance-api): wire a real `/api/inventory/service-log` (list +
 * POST) endpoint and replace the local-state `entries` array + `LOG SERVICE`
 * submit handler with `useQuery` / `useMutation` hooks in `@/lib/api/rentals`.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useInventoryItems, type InventoryItem } from '@/lib/api/rentals'
import {
  MBody,
  MButton,
  MI,
  MInput,
  MKpi,
  MKpiRow,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'

type ServiceStatus = 'open' | 'done'

type ServiceEntry = {
  id: string
  /** ISO date (yyyy-mm-dd) the service was performed / logged. */
  date: string
  /** Short maintenance type, e.g. "Oil change". */
  type: string
  notes: string
  status: ServiceStatus
}

export function MobileRentalsService() {
  const navigate = useNavigate()
  // `:assetId` is optional — the screen doubles as a yard-wide log and a
  // per-asset log depending on the mounted route.
  const { assetId } = useParams<{ assetId?: string }>()
  const { data, isLoading, isError } = useInventoryItems()

  // Locally-logged service entries. Persisted only in component state until a
  // maintenance endpoint exists (see file-level TODO).
  const [entries, setEntries] = useState<readonly ServiceEntry[]>([])
  const [showForm, setShowForm] = useState(false)
  const [formType, setFormType] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [formDate, setFormDate] = useState(() => new Date().toISOString().slice(0, 10))

  const asset: InventoryItem | undefined = useMemo(() => {
    if (!assetId) return undefined
    return data?.inventoryItems.find((i) => i.id === assetId)
  }, [data, assetId])

  const openCount = entries.filter((e) => e.status === 'open').length

  // Most-recent completed service date drives "Last service".
  const lastService = useMemo(() => {
    const done = entries
      .filter((e) => e.status === 'done')
      .map((e) => e.date)
      .sort()
    return done.length ? done[done.length - 1] : null
  }, [entries])

  const submit = () => {
    if (!formType.trim()) return
    // TODO(maintenance-api): POST to the service-log endpoint instead of
    // mutating local state. Idempotency + server id once that lands.
    const entry: ServiceEntry = {
      id: `local-${Date.now()}`,
      date: formDate,
      type: formType.trim(),
      notes: formNotes.trim(),
      status: 'open',
    }
    setEntries((prev) => [entry, ...prev])
    setFormType('')
    setFormNotes('')
    setFormDate(new Date().toISOString().slice(0, 10))
    setShowForm(false)
  }

  return (
    <>
      <MTopBar
        back
        eyebrow={asset ? asset.code : 'Inventory'}
        title="Service log"
        sub={asset ? asset.description : 'Maintenance history'}
        onBack={() => navigate(-1)}
      />
      <MBody>
        {/* KPI strip — square borders, mono micro-labels (Steve v2). */}
        <MKpiRow cols={3}>
          <MKpi label="Last service" value={lastService ? fmtDate(lastService) : '—'} />
          <MKpi label="Next due" value="—" />
          <MKpi label="Hours since" value="—" />
        </MKpiRow>

        <div style={{ padding: '4px 16px 8px' }}>
          <MButton variant="primary" onClick={() => setShowForm((s) => !s)} style={{ width: '100%' }}>
            <MI.Plus size={16} /> Log service
          </MButton>
        </div>

        {showForm ? (
          <div
            style={{
              margin: '0 16px 12px',
              border: '1px solid var(--m-line)',
              borderRadius: 'var(--m-r)',
              background: 'var(--m-card)',
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="m-kpi-eyebrow">Type</span>
              <MInput
                type="text"
                placeholder="e.g. Oil change, nozzle replaced"
                value={formType}
                onChange={(e) => setFormType(e.currentTarget.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="m-kpi-eyebrow">Notes</span>
              <MTextarea
                rows={3}
                placeholder="What was done"
                value={formNotes}
                onChange={(e) => setFormNotes(e.currentTarget.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="m-kpi-eyebrow">Date</span>
              <MInput type="date" value={formDate} onChange={(e) => setFormDate(e.currentTarget.value)} />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <MButton variant="primary" onClick={submit} disabled={!formType.trim()} style={{ flex: 1 }}>
                Save entry
              </MButton>
              <MButton variant="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </MButton>
            </div>
          </div>
        ) : null}

        <MSectionH>History{openCount > 0 ? ` · ${openCount} open` : ''}</MSectionH>

        {isLoading ? (
          <MSkeletonList count={3} />
        ) : isError ? (
          <div style={{ padding: 24, color: 'var(--m-red)', fontSize: 13 }}>Could not load inventory context.</div>
        ) : entries.length === 0 ? (
          <MEmptyState
            title="No service logged"
            body="Maintenance, inspections, and repairs will appear here once logged. Tap Log service to add the first entry."
            primaryLabel="Log service"
            onPrimary={() => setShowForm(true)}
          />
        ) : (
          <div style={{ paddingBottom: 40 }}>
            <MListInset>
              {entries.map((entry) => (
                <MListRow
                  key={entry.id}
                  leading={fmtDate(entry.date)}
                  leadingTone={entry.status === 'open' ? 'red' : 'green'}
                  headline={entry.type}
                  supporting={entry.notes || undefined}
                  badge={
                    <MPill tone={entry.status === 'open' ? 'red' : 'green'} dot>
                      {entry.status === 'open' ? 'open' : 'done'}
                    </MPill>
                  }
                />
              ))}
            </MListInset>
          </div>
        )}
      </MBody>
    </>
  )
}

/** Compact mono date for the leading column / KPI (e.g. "5/24"). */
function fmtDate(iso: string): string {
  const [, m, d] = iso.split('-')
  if (!m || !d) return iso
  return `${Number(m)}/${Number(d)}`
}
