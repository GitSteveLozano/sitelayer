/**
 * Owner desktop rentals — DISPATCH (Desktop v2 · RENTALS · DISPATCH, registry
 * id m-rentd / DRentDispatch).
 *
 * Split layout: left column = a to-project picker + handoff details
 * (driver/foreman + ticket + estimated-return) form; right aside = a live
 * summary of the dispatch (asset · from-yard · to-project · est. return)
 * with the CONFIRM button. The desktop twin of the mobile
 * `MobileRentalDispatch` flow (rentals-dispatch.tsx) — same
 * `useInventoryLocations` + `useDispatchMovement` plumbing, same project
 * filter (active / in-progress projects only), composed dense for the
 * >=1024px owner surface.
 *
 * Reached from the asset detail screen
 * (`/desktop/rentals/:itemId/dispatch`). Parent (DesktopWorkspace) wires
 * the route + passes bootstrap (projects + workers come from it). On
 * success we navigate back to the asset detail.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { useDispatchMovement, useInventoryItems, useInventoryLocations } from '@/lib/api/rentals'
import { DEyebrow, DH1 } from '@/components/d'
import { MButton, MInput, MSelect } from '@/components/m'
import { formatMoney, todayIso } from '../mobile/format.js'

const fieldLabel = {
  fontFamily: 'var(--m-num)',
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--m-ink-3)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase' as const,
}

function Fact({ label, value, valueTone }: { label: string; value: string; valueTone?: 'accent' | undefined }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 0',
        borderBottom: '1px solid var(--m-line-2)',
      }}
    >
      <span style={{ fontSize: 13, color: 'var(--m-ink-3)' }}>{label}</span>
      <span
        className="num"
        style={{ fontSize: 14, fontWeight: 700, color: valueTone === 'accent' ? 'var(--m-accent)' : 'var(--m-ink)' }}
      >
        {value}
      </span>
    </div>
  )
}

export function OwnerRentalsDispatch({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const params = useParams<{ itemId: string }>()
  const navigate = useNavigate()
  const itemId = params.itemId ?? ''

  const itemsQuery = useInventoryItems()
  const locationsQuery = useInventoryLocations()
  const dispatch = useDispatchMovement()

  const item = useMemo(
    () => (itemsQuery.data?.inventoryItems ?? []).find((i) => i.id === itemId) ?? null,
    [itemsQuery.data?.inventoryItems, itemId],
  )

  // Yards first (default sort) — the dispatch origin. The API already
  // excludes soft-deleted rows.
  const yards = useMemo(
    () => (locationsQuery.data?.inventoryLocations ?? []).filter((l) => l.location_type === 'yard'),
    [locationsQuery.data?.inventoryLocations],
  )
  const allLocations = useMemo(
    () => locationsQuery.data?.inventoryLocations ?? [],
    [locationsQuery.data?.inventoryLocations],
  )

  // Only active / in-progress projects are dispatch targets (mirrors the
  // mobile dispatch filter).
  const projects = useMemo(
    () => (bootstrap?.projects ?? []).filter((p) => /progress|active/i.test(p.status)),
    [bootstrap?.projects],
  )
  const workers = bootstrap?.workers ?? []

  const [projectId, setProjectId] = useState('')
  const [workerId, setWorkerId] = useState('')
  const [ticket, setTicket] = useState('')
  const [estReturn, setEstReturn] = useState('')

  const fromYard = yards[0] ?? null
  const toProject = projects.find((p) => p.id === projectId) ?? null
  // The destination location is the project's own inventory location when
  // one exists (mirrors the mobile rentals-scan dispatch). The movements
  // POST stamps project_id regardless, so the movement still binds to the
  // project even when the company has no per-project location row.
  const toLocation = useMemo(
    () => (projectId ? (allLocations.find((l) => l.project_id === projectId) ?? null) : null),
    [allLocations, projectId],
  )
  const handoffWorker = workers.find((w) => w.id === workerId) ?? null
  const canDispatch = Boolean(projectId) && Boolean(fromYard) && Boolean(item) && !dispatch.isPending

  const handleDispatch = () => {
    if (!canDispatch || !item || !fromYard) return
    // `deliver` is the canonical dispatch movement type (rental-inventory
    // MOVEMENT_TYPES). from = yard, to = the project location (when present),
    // project_id binds the movement to the job. The movements API has no
    // estimated-return column, so the handoff date rides in notes.
    dispatch.mutate(
      {
        inventory_item_id: item.id,
        quantity: 1,
        movement_type: 'deliver',
        from_location_id: fromYard.id,
        to_location_id: toLocation?.id ?? null,
        project_id: projectId,
        ticket_number: ticket.trim() || null,
        notes: estReturn ? `Est. return ${estReturn}` : null,
        worker_id: workerId || null,
      },
      { onSuccess: () => navigate(`/desktop/rentals/${item.id}`) },
    )
  }

  if (!item) {
    return (
      <div className="d-content">
        <div className="d-stack">
          <div>
            <DEyebrow>Owner · Rentals · Dispatch</DEyebrow>
            <DH1>{itemsQuery.isPending ? 'Loading asset…' : 'Asset not found'}</DH1>
          </div>
          {!itemsQuery.isPending ? (
            <div className="d-card" style={{ color: 'var(--m-ink-2)' }}>
              This asset may have been removed from inventory.
              <div style={{ marginTop: 14 }}>
                <MButton variant="primary" onClick={() => navigate('/desktop/rentals')}>
                  Back to rentals
                </MButton>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  const rate = Number(item.default_rental_rate ?? 0)

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Rentals · Dispatch · {item.code}</DEyebrow>
          <DH1>Dispatch {item.description}</DH1>
        </div>

        <div className="d-split">
          <div className="d-card">
            <div style={fieldLabel}>To project</div>
            {/* The picker reads as a large highlighted card once a project is
                chosen (design: To-project picker is a yellow card with the
                project name + foreman/customer meta and a dropdown affordance),
                while the underlying MSelect still drives the selection. */}
            <div
              style={{
                position: 'relative',
                marginTop: 8,
                border: '2px solid var(--m-ink)',
                background: toProject ? 'var(--m-accent)' : 'var(--m-card-soft)',
                color: toProject ? 'var(--m-accent-ink)' : 'var(--m-ink)',
              }}
            >
              <div style={{ padding: '16px 18px', minHeight: 56 }}>
                {toProject ? (
                  <>
                    <div style={{ fontSize: 18, fontWeight: 800 }}>{toProject.name}</div>
                    {toProject.customer_name ? (
                      <div style={{ ...fieldLabel, color: 'var(--m-accent-ink)', opacity: 0.8, marginTop: 4 }}>
                        {toProject.customer_name}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--m-ink-3)' }}>Pick a project…</div>
                )}
              </div>
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  right: 16,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  fontSize: 14,
                  fontWeight: 800,
                  pointerEvents: 'none',
                }}
              >
                ▾
              </span>
              <MSelect
                value={projectId}
                onChange={(e) => setProjectId(e.currentTarget.value)}
                aria-label="To project"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  opacity: 0,
                  cursor: 'pointer',
                  border: 'none',
                }}
              >
                <option value="">Pick a project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.customer_name ? ` · ${p.customer_name}` : ''}
                  </option>
                ))}
              </MSelect>
            </div>
            {projects.length === 0 ? (
              <div style={{ marginTop: 8, fontSize: 13, color: 'var(--m-ink-3)' }}>
                No active projects to dispatch to.
              </div>
            ) : null}

            <div style={{ ...fieldLabel, marginTop: 22 }}>From yard</div>
            <div
              style={{
                marginTop: 8,
                padding: '12px 14px',
                border: '2px solid var(--m-ink)',
                background: 'var(--m-card-soft)',
                fontFamily: 'var(--m-num)',
                fontWeight: 600,
                fontSize: 13,
                color: fromYard ? 'var(--m-ink)' : 'var(--m-red)',
                textTransform: 'uppercase',
              }}
            >
              {fromYard ? fromYard.name : 'No yard available'}
            </div>

            <div style={{ ...fieldLabel, marginTop: 22 }}>Handoff to</div>
            <MSelect
              value={workerId}
              onChange={(e) => setWorkerId(e.currentTarget.value)}
              style={{ width: '100%', marginTop: 8 }}
            >
              <option value="">Unassigned…</option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </MSelect>

            <div style={{ ...fieldLabel, marginTop: 22 }}>Ticket #</div>
            <MInput
              value={ticket}
              onChange={(e) => setTicket(e.currentTarget.value)}
              placeholder="Optional delivery ticket"
              style={{ marginTop: 8 }}
            />

            <div style={{ ...fieldLabel, marginTop: 22 }}>Estimated return</div>
            <MInput
              type="date"
              value={estReturn}
              min={todayIso()}
              onChange={(e) => setEstReturn(e.currentTarget.value)}
              style={{ marginTop: 8 }}
            />

            {dispatch.isError ? (
              <div
                style={{
                  marginTop: 16,
                  padding: '12px 14px',
                  border: '2px solid var(--m-red)',
                  color: 'var(--m-red)',
                  fontFamily: 'var(--m-num)',
                  fontWeight: 600,
                  fontSize: 12,
                }}
              >
                {dispatch.error instanceof Error ? dispatch.error.message : 'Dispatch failed.'}
              </div>
            ) : null}
          </div>

          <aside className="d-card" style={{ position: 'sticky', top: 16, alignSelf: 'start' }}>
            <div className="d-eyebrow">Dispatch summary</div>
            <Fact label="Asset" value={`${item.code} · ${item.description}`} />
            <Fact label="Day rate" value={`${formatMoney(rate)}/${item.unit || 'day'}`} />
            <Fact label="From" value={fromYard?.name ?? '—'} />
            <Fact label="To" value={toProject?.name ?? '—'} valueTone={toProject ? 'accent' : undefined} />
            <Fact label="Handoff" value={handoffWorker?.name ?? 'Unassigned'} />
            <Fact label="Est. return" value={estReturn || '—'} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 22 }}>
              <MButton variant="primary" disabled={!canDispatch} onClick={handleDispatch}>
                {dispatch.isPending ? 'Dispatching…' : 'Confirm · Dispatch now'}
              </MButton>
              <MButton variant="ghost" onClick={() => navigate(`/desktop/rentals/${item.id}`)}>
                Cancel
              </MButton>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
