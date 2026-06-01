/**
 * Mobile rental billing-run list — read-only index of `rental_billing_run`
 * rows, each linking to the headless detail renderer at
 * `rentals/billing/:id`. Mirrors the desktop `billing-run-list.tsx`: it uses
 * the read-only TanStack hook `useBillingRuns` plus a single local state
 * filter chip (no workflow transitions happen here, so ad-hoc useState is
 * fine — the dossier explicitly sanctions this for the list surface).
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useBillingRuns, type RentalBillingRunRow, type RentalBillingState } from '@/lib/api'
import { MBody, MChip, MChipRow, MListPlain, MListRow, MPill, MTopBar } from '../../components/m/index.js'
import type { MTone } from '../../components/m/list.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'
import { formatMoney, shortDate } from './format.js'

type Filter = 'all' | RentalBillingState

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'generated', label: 'Generated' },
  { key: 'approved', label: 'Approved' },
  { key: 'posting', label: 'Posting' },
  { key: 'failed', label: 'Failed' },
  { key: 'posted', label: 'Posted' },
]

const STATE_TONE: Record<RentalBillingState, MTone | undefined> = {
  generated: undefined,
  approved: 'accent',
  posting: 'amber',
  posted: 'green',
  failed: 'red',
  voided: undefined,
}

export function MobileRentalBillingList() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<Filter>('all')
  const { data, isLoading, error } = useBillingRuns(filter === 'all' ? {} : { state: filter })
  const runs = data?.billingRuns ?? []

  return (
    <>
      <MTopBar back title="Billing runs" sub="Rental invoicing" onBack={() => navigate('/rentals')} />
      <MBody>
        <MChipRow>
          {FILTERS.map((f) => (
            <MChip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
            </MChip>
          ))}
        </MChipRow>
        {error ? (
          <div style={{ padding: 24, color: 'var(--m-red)', fontSize: 13 }}>
            {error instanceof Error ? error.message : 'Failed to load billing runs.'}
          </div>
        ) : isLoading ? (
          <MSkeletonList count={4} />
        ) : runs.length === 0 ? (
          <MEmptyState
            title="No billing runs"
            body="Generate a billing run from a rental contract to start the approve → post arc."
          />
        ) : (
          <div style={{ paddingBottom: 80 }}>
            <MListPlain>
              {runs.map((run) => (
                <BillingRunRow key={run.id} run={run} onOpen={() => navigate(`/rentals/billing/${run.id}`)} />
              ))}
            </MListPlain>
          </div>
        )}
      </MBody>
    </>
  )
}

function BillingRunRow({ run, onOpen }: { run: RentalBillingRunRow; onOpen: () => void }) {
  return (
    <MListRow
      headline={formatMoney(run.subtotal)}
      supporting={`${shortDate(run.period_start)} → ${shortDate(run.period_end)} · v${run.state_version}`}
      badge={
        <MPill tone={STATE_TONE[run.status]} dot>
          {run.status}
        </MPill>
      }
      chev
      onTap={onOpen}
    />
  )
}
