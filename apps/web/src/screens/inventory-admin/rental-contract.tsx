import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { MButton, MButtonRow, MI, MPill } from '@/components/m'
import { Attribution } from '@/components/ai'
import {
  useCreateContractLine,
  useCreateRentalContract,
  useCreateRentalRateTier,
  useDeleteContractLine,
  useDeleteRentalRateTier,
  useGenerateBillingRun,
  useInventoryItems,
  usePatchContractLine,
  usePatchRentalContract,
  usePreviewBillingRun,
  useProject,
  useProjectRentalContracts,
  useRentalContractLines,
  useRentalRateTiers,
  type BillingRunPreview,
  type JobRentalContract,
  type RentalContractLine,
  type RentalRateUnit,
} from '@/lib/api'
import { RentalReturnSheet } from '@/screens/rentals/rental-return-sheet'
import { RentalTransferSheet } from '@/screens/rentals/rental-transfer-sheet'

const RATE_UNITS = ['day', 'cycle', 'week', 'month', 'each']

export function ProjectRentalContractScreen() {
  const { id: projectId } = useParams<{ id: string }>()
  const project = useProject(projectId)
  const contracts = useProjectRentalContracts(projectId)
  const create = useCreateRentalContract(projectId ?? '')
  const [creatingContract, setCreatingContract] = useState(false)

  if (!projectId) {
    return (
      <div className="px-5 pt-8">
        <Link to="/projects" className="text-accent text-[13px] font-medium">
          ← projects
        </Link>
      </div>
    )
  }

  const activeContract = (contracts.data?.contracts ?? []).find(
    (c) => c.status === 'active' || c.status === 'draft' || c.status === 'paused',
  )

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to={`/projects/${projectId}`} className="text-[12px] text-ink-3">
        ← {project.data?.project.name ?? 'Project'}
      </Link>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">Rental contract</h1>
        <Link to={`/projects/${projectId}/boms`} className="shrink-0 text-[12px] font-medium text-accent">
          Scaffold BOMs →
        </Link>
      </div>
      <p className="text-[12px] text-ink-3 mt-1">
        25-day cycles by default — generate billing runs to land invoices in QBO.
      </p>

      {contracts.isPending ? (
        <div className="m-card m-card-tight mt-6">
          <div className="text-[12px] text-ink-3">Loading…</div>
        </div>
      ) : !activeContract ? (
        <div className="mt-6 space-y-3">
          <div className="m-card">
            <div className="text-[13px] font-semibold">No active contract</div>
            <div className="text-[12px] text-ink-3 mt-1">Create one to start billing rentals on this project.</div>
            <div className="mt-3">
              <MButton variant="primary" onClick={() => setCreatingContract(true)}>
                + New contract
              </MButton>
            </div>
          </div>
          {creatingContract ? (
            <NewContractSheet
              onClose={() => setCreatingContract(false)}
              onCreate={async (input) => {
                await create.mutateAsync(input)
                setCreatingContract(false)
              }}
            />
          ) : null}
        </div>
      ) : (
        <ActiveContractView contract={activeContract} />
      )}
    </div>
  )
}

function ActiveContractView({ contract }: { contract: JobRentalContract }) {
  const lines = useRentalContractLines(contract.id)
  const items = useInventoryItems()
  const patch = usePatchRentalContract(contract.id)
  const createLine = useCreateContractLine(contract.id)
  const preview = usePreviewBillingRun(contract.id)
  const generate = useGenerateBillingRun(contract.id)
  const [confirmNode, askConfirm] = useMConfirm()
  const [editingLine, setEditingLine] = useState<RentalContractLine | 'new' | null>(null)
  const [previewData, setPreviewData] = useState<BillingRunPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingHeader, setEditingHeader] = useState(false)
  // Returns reconciliation + transfer entrypoints — operate on the
  // Avontus-style /api/rentals row (separate ledger from the contract
  // lines on this page). Paste in a rental id to launch the sheet.
  const [reconcileRentalId, setReconcileRentalId] = useState<string>('')
  const [returnSheetOpen, setReturnSheetOpen] = useState(false)
  const [transferSheetOpen, setTransferSheetOpen] = useState(false)

  const onPreview = async () => {
    setError(null)
    try {
      const data = await preview.mutateAsync({})
      setPreviewData(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed')
    }
  }

  const onGenerate = async () => {
    setError(null)
    const ok = await askConfirm({
      title: 'Generate billing run?',
      body: 'This creates an approvable run. Approval + post happens on the Financial tab.',
      confirmLabel: 'Generate',
    })
    if (!ok) return
    try {
      await generate.mutateAsync({})
      setPreviewData(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generate failed')
    }
  }

  return (
    <div className="mt-6 space-y-3">
      <div className="m-card">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Contract</div>
            <div className="text-[13px] font-semibold mt-1">
              {contract.billing_cycle_days}-day cycle · {contract.billing_mode}
            </div>
            <div className="text-[11px] text-ink-3 mt-1">
              start {contract.billing_start_date} · next {contract.next_billing_date}
              {contract.last_billed_through ? ` · last ${contract.last_billed_through}` : ''}
            </div>
          </div>
          <MPill tone={contract.status === 'active' ? 'green' : undefined}>{contract.status}</MPill>
        </div>
        <div className="mt-3">
          <MButton variant="ghost" onClick={() => setEditingHeader(true)}>
            Edit contract
          </MButton>
        </div>
      </div>

      <div className="flex items-center justify-between pt-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Lines</div>
        <button type="button" onClick={() => setEditingLine('new')} className="text-[12px] text-accent font-medium">
          + Add line
        </button>
      </div>

      <div className="space-y-2">
        {lines.isPending ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">Loading…</div>
          </div>
        ) : (lines.data?.lines ?? []).length === 0 ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">No lines yet — add the first one.</div>
          </div>
        ) : (
          lines.data?.lines.map((line) => {
            const item = items.data?.inventoryItems.find((i) => i.id === line.inventory_item_id)
            return (
              <button
                key={line.id}
                type="button"
                onClick={() => setEditingLine(line)}
                className="block w-full text-left"
              >
                <div className="m-card m-card-tight">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold truncate">
                        {item?.code ?? line.inventory_item_id} · {Number(line.quantity).toFixed(0)}
                      </div>
                      <div className="text-[11px] text-ink-3 mt-0.5">
                        ${Number(line.agreed_rate).toFixed(2)}/{line.rate_unit} · on {line.on_rent_date}
                        {line.off_rent_date ? ` → off ${line.off_rent_date}` : ''}
                      </div>
                    </div>
                    <MPill tone={line.status === 'active' ? 'green' : undefined}>{line.status}</MPill>
                  </div>
                </div>
              </button>
            )
          })
        )}
      </div>

      <div className="m-card mt-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Generate billing run</div>
        <div className="text-[12px] text-ink-3 mt-1">
          Preview the next cycle, then generate an approvable run. Approval + post happens on the Financial tab.
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <MButton variant="ghost" onClick={onPreview} disabled={preview.isPending}>
            {preview.isPending ? 'Computing…' : 'Preview'}
          </MButton>
          <MButton variant="primary" onClick={onGenerate} disabled={generate.isPending || !previewData}>
            {generate.isPending ? 'Generating…' : 'Generate run'}
          </MButton>
        </div>
        {previewData ? (
          <div className="mt-3 pt-3 border-t border-dashed border-line-2">
            <div className="text-[12px] text-ink-2">
              {previewData.period_start} → {previewData.period_end}
            </div>
            <div className="num text-[20px] font-bold tracking-tight mt-1">
              ${previewData.subtotal.toLocaleString()}
            </div>
            <div className="text-[11px] text-ink-3 mt-1">
              {previewData.lines.length} line{previewData.lines.length === 1 ? '' : 's'}
            </div>
          </div>
        ) : null}
        {error ? <div className="text-[12px] text-warn mt-2">{error}</div> : null}
      </div>

      <div className="mt-2">
        <Attribution source="POST /api/rental-contracts/:id/billing-runs[/preview] · then approve via Financial tab" />
      </div>

      {/* Returns reconciliation + transfer — operates on the parallel
          /api/rentals ledger by rental id. Operators reach this surface
          when the contract-line return path doesn't yet apply (Avontus
          style rentals, ad-hoc dispatches). */}
      <div className="m-card mt-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Reconcile rental return</div>
        <div className="text-[12px] text-ink-3 mt-1">
          Paste a rental id to record returned counts (good / damaged / lost) or transfer it to another project.
        </div>
        <input
          type="text"
          value={reconcileRentalId}
          onChange={(e) => setReconcileRentalId(e.target.value.trim())}
          placeholder="rental id (uuid)"
          className="mt-2 w-full text-[13px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
        />
        <div className="grid grid-cols-2 gap-2 mt-2">
          <MButton variant="ghost" onClick={() => setReturnSheetOpen(true)} disabled={!reconcileRentalId}>
            Receive return
          </MButton>
          <MButton variant="ghost" onClick={() => setTransferSheetOpen(true)} disabled={!reconcileRentalId}>
            Transfer
          </MButton>
        </div>
      </div>

      {reconcileRentalId ? (
        <>
          <RentalReturnSheet
            open={returnSheetOpen}
            onClose={() => setReturnSheetOpen(false)}
            rentalId={reconcileRentalId}
          />
          <RentalTransferSheet
            open={transferSheetOpen}
            onClose={() => setTransferSheetOpen(false)}
            rentalId={reconcileRentalId}
            currentProjectId={contract.project_id}
          />
        </>
      ) : null}

      {editingLine !== null ? (
        <LineForm
          key={editingLine === 'new' ? 'new' : editingLine.id}
          line={editingLine === 'new' ? null : editingLine}
          contractStartDate={contract.billing_start_date}
          onClose={() => setEditingLine(null)}
          onCreate={async (input) => {
            await createLine.mutateAsync(input)
            setEditingLine(null)
          }}
        />
      ) : null}

      {editingHeader ? (
        <ContractHeaderSheet
          contract={contract}
          onClose={() => setEditingHeader(false)}
          onSave={async (input) => {
            await patch.mutateAsync({ ...input, expected_version: contract.version })
            setEditingHeader(false)
          }}
        />
      ) : null}
      {confirmNode}
    </div>
  )
}

function NewContractSheet({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (input: {
    customer_id?: string | null
    billing_cycle_days?: number
    billing_mode?: string
    billing_start_date: string
    notes?: string | null
  }) => Promise<void>
}) {
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10))
  const [cycle, setCycle] = useState('25')
  const [mode, setMode] = useState('arrears')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    try {
      await onCreate({
        billing_start_date: start,
        billing_cycle_days: Number(cycle) || 25,
        billing_mode: mode,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed')
    }
  }

  return (
    <MSheet title="New contract" onClose={onClose}>
      <div className="space-y-3 pb-4">
        <Field label="Billing start date" value={start} onChange={setStart} type="date" />
        <Field label="Cycle days" value={cycle} onChange={setCycle} placeholder="25" />
        <Select label="Mode" value={mode} onChange={setMode} options={['arrears', 'in_advance']} />
        {error ? <div className="text-[12px] text-warn">{error}</div> : null}
        <MButton variant="primary" onClick={submit} disabled={!start}>
          Create
        </MButton>
      </div>
    </MSheet>
  )
}

function ContractHeaderSheet({
  contract,
  onClose,
  onSave,
}: {
  contract: JobRentalContract
  onClose: () => void
  onSave: (input: {
    billing_cycle_days?: number
    billing_mode?: string
    billing_start_date?: string
    next_billing_date?: string
    status?: string
    notes?: string | null
  }) => Promise<void>
}) {
  const [start, setStart] = useState(contract.billing_start_date)
  const [next, setNext] = useState(contract.next_billing_date)
  const [cycle, setCycle] = useState(String(contract.billing_cycle_days))
  const [mode, setMode] = useState(contract.billing_mode)
  const [status, setStatus] = useState<string>(contract.status)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    try {
      await onSave({
        billing_start_date: start,
        next_billing_date: next,
        billing_cycle_days: Number(cycle) || contract.billing_cycle_days,
        billing_mode: mode,
        status,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  return (
    <MSheet title="Edit contract" onClose={onClose}>
      <div className="space-y-3 pb-4">
        <Field label="Billing start date" value={start} onChange={setStart} type="date" />
        <Field label="Next billing date" value={next} onChange={setNext} type="date" />
        <Field label="Cycle days" value={cycle} onChange={setCycle} placeholder="25" />
        <Select label="Mode" value={mode} onChange={setMode} options={['arrears', 'in_advance']} />
        <Select label="Status" value={status} onChange={setStatus} options={['draft', 'active', 'paused', 'closed']} />
        {error ? <div className="text-[12px] text-warn">{error}</div> : null}
        <MButton variant="primary" onClick={submit}>
          Save
        </MButton>
      </div>
    </MSheet>
  )
}

function LineForm({
  line,
  contractStartDate,
  onClose,
  onCreate,
}: {
  line: RentalContractLine | null
  contractStartDate: string
  onClose: () => void
  onCreate: (input: {
    inventory_item_id: string
    quantity: number
    agreed_rate: number
    rate_unit?: string
    on_rent_date: string
    off_rent_date?: string | null
  }) => Promise<void>
}) {
  const items = useInventoryItems()
  const patch = usePatchContractLine(line?.id ?? '')
  const del = useDeleteContractLine()
  const [confirmNode, askConfirm] = useMConfirm()
  const [itemId, setItemId] = useState(line?.inventory_item_id ?? '')
  const [quantity, setQuantity] = useState(line?.quantity ?? '1')
  const [rate, setRate] = useState(line?.agreed_rate ?? '0')
  const [rateUnit, setRateUnit] = useState(line?.rate_unit ?? 'day')
  const [onRent, setOnRent] = useState(line?.on_rent_date ?? contractStartDate)
  const [offRent, setOffRent] = useState(line?.off_rent_date ?? '')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    try {
      const input = {
        inventory_item_id: itemId,
        quantity: Number(quantity),
        agreed_rate: Number(rate),
        rate_unit: rateUnit,
        on_rent_date: onRent,
        off_rent_date: offRent || null,
      }
      if (!line) {
        await onCreate(input)
      } else {
        await patch.mutateAsync({ ...input, expected_version: line.version })
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const remove = async () => {
    if (!line) return
    const ok = await askConfirm({
      title: 'Delete contract line?',
      body: 'This removes the line from the contract; existing billing runs are unaffected.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await del.mutateAsync({ id: line.id, expected_version: line.version })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <MSheet title={line ? 'Edit line' : 'New line'} onClose={onClose}>
      <div className="space-y-3 pb-4">
        <Select
          label="Item"
          value={itemId}
          onChange={setItemId}
          options={[
            { value: '', label: 'Pick an item…' },
            ...(items.data?.inventoryItems ?? []).map((it) => ({
              value: it.id,
              label: `${it.code} — ${it.description}`,
            })),
          ]}
        />
        <Field label="Quantity" value={String(quantity)} onChange={setQuantity} placeholder="1" />
        <Field label="Agreed rate" value={String(rate)} onChange={setRate} placeholder="2.50" />
        <Select
          label="Rate unit"
          value={rateUnit}
          onChange={setRateUnit}
          options={RATE_UNITS.map((u) => ({ value: u, label: u }))}
        />
        <Field label="On-rent date" value={onRent} onChange={setOnRent} type="date" />
        <Field label="Off-rent date (optional)" value={offRent} onChange={setOffRent} type="date" />
        {error ? <div className="text-[12px] text-warn">{error}</div> : null}
        {line ? <RateTierPanel lineId={line.id} /> : null}
        <div className={line ? 'grid grid-cols-2 gap-2' : ''}>
          <MButton variant="primary" onClick={submit} disabled={!itemId || Number(quantity) <= 0 || patch.isPending}>
            {line ? 'Save' : 'Add'}
          </MButton>
          {line ? (
            <MButton
              variant="ghost"
              onClick={remove}
              disabled={del.isPending}
              style={{ color: 'var(--m-red)', borderColor: 'var(--m-red)' }}
            >
              Delete
            </MButton>
          ) : null}
        </div>
      </div>
      {confirmNode}
    </MSheet>
  )
}

/**
 * Per-line tiered pricing editor (migration 067 + audit follow-up).
 * Tiers are append/remove — to "edit" a tier, delete + re-create. This
 * keeps the audit trail simple and matches how rental shops actually
 * negotiate tier structures (whole-table revisions, not line-edits).
 */
function RateTierPanel({ lineId }: { lineId: string }) {
  const tiers = useRentalRateTiers(lineId)
  const create = useCreateRentalRateTier(lineId)
  const del = useDeleteRentalRateTier(lineId)
  const [minDays, setMinDays] = useState('1')
  const [maxDays, setMaxDays] = useState('')
  const [rate, setRate] = useState('')
  const [rateUnit, setRateUnit] = useState<RentalRateUnit>('day')
  const [err, setErr] = useState<string | null>(null)

  const addTier = async () => {
    setErr(null)
    const minN = Number(minDays)
    const maxN = maxDays.trim() === '' ? null : Number(maxDays)
    const rateN = Number(rate)
    if (!Number.isFinite(minN) || minN < 1) return setErr('min days must be ≥ 1')
    if (maxN !== null && (!Number.isFinite(maxN) || maxN < minN)) return setErr('max days must be ≥ min or blank')
    if (!Number.isFinite(rateN) || rateN < 0) return setErr('rate must be a non-negative number')
    try {
      const existing = tiers.data?.rateTiers.length ?? 0
      await create.mutateAsync({
        rate_unit: rateUnit,
        min_days: minN,
        max_days: maxN,
        rate: rateN,
        sort_order: existing + 1,
      })
      setMinDays('1')
      setMaxDays('')
      setRate('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to add tier')
    }
  }

  return (
    <div className="border-t border-line pt-3 mt-1">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-2">
        Rate tiers (overrides agreed rate when billable days fall in window)
      </div>
      {(tiers.data?.rateTiers ?? []).length === 0 ? (
        <div className="text-[11px] text-ink-3">No tiers — billing uses the line's agreed rate for all durations.</div>
      ) : (
        <ul className="space-y-1 mb-2">
          {tiers.data!.rateTiers.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 text-[12px]">
              <span>
                {t.min_days}
                {'–'}
                {t.max_days ?? '∞'} days @ ${Number(t.rate).toFixed(2)}/{t.rate_unit}
              </span>
              <button
                type="button"
                onClick={() => void del.mutateAsync({ tierId: t.id })}
                className="text-[11px] text-warn hover:underline"
                disabled={del.isPending}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-4 gap-1">
        <Field label="Min" value={minDays} onChange={setMinDays} placeholder="1" />
        <Field label="Max" value={maxDays} onChange={setMaxDays} placeholder="∞" />
        <Field label="Rate" value={rate} onChange={setRate} placeholder="0.00" />
        <Select
          label="Unit"
          value={rateUnit}
          onChange={(v) => setRateUnit(v as RentalRateUnit)}
          options={RATE_UNITS.map((u) => ({ value: u, label: u }))}
        />
      </div>
      {err ? <div className="text-[11px] text-warn mt-1">{err}</div> : null}
      <MButton variant="ghost" size="sm" onClick={addTier} disabled={create.isPending} className="mt-2">
        Add tier
      </MButton>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: 'text' | 'date'
}) {
  return (
    <label className="block">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full text-[15px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
      />
    </label>
  )
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: ReadonlyArray<string | { value: string; label: string }>
}) {
  const normalized = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
  return (
    <label className="block">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
      >
        {normalized.map((o) => (
          <option key={o.value || '_'} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * Bottom sheet in the `.m-sheet` idiom (styles/m.css — square corners, 2px
 * ink top rule, hard offset shadow, no grabber/blur). Same pattern as the
 * AssignmentSheet swap in screens/mobile/schedule.tsx (e9b7c7f3); replaces
 * the retired wave-2 kit Sheet. ESC and backdrop-tap dismiss.
 */
function MSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'rgba(15, 14, 12, 0.5)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="m-sheet" style={{ maxWidth: 720 }}>
        <div className="m-sheet-header">
          <div className="m-sheet-title">{title}</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 4,
              color: 'var(--m-ink)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <MI.X size={20} />
          </button>
        </div>
        <div className="m-sheet-body" style={{ padding: '16px 20px 0' }}>
          {children}
        </div>
      </div>
    </div>
  )
}

/**
 * `.m-sheet` replacement for the legacy `useConfirmSheet` hook — same
 * `[node, ask]` API, resolves the promise with the user's choice.
 * `destructive` keeps the legacy red-confirm treatment.
 */
function useMConfirm() {
  const [state, setState] = useState<{
    title: string
    body: string
    confirmLabel: string
    destructive?: boolean
    resolve: (ok: boolean) => void
  } | null>(null)

  const settle = (ok: boolean) => {
    state?.resolve(ok)
    setState(null)
  }

  const node =
    state !== null ? (
      <MSheet title={state.title} onClose={() => settle(false)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 16 }}>
          <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.5 }}>{state.body}</div>
          <MButtonRow>
            <MButton variant="ghost" onClick={() => settle(false)}>
              Cancel
            </MButton>
            <MButton
              variant="primary"
              onClick={() => settle(true)}
              style={
                state.destructive ? { background: 'var(--m-red)', borderColor: 'var(--m-red)', color: '#fff' } : {}
              }
            >
              {state.confirmLabel}
            </MButton>
          </MButtonRow>
        </div>
      </MSheet>
    ) : null

  const ask = (props: { title: string; body: string; confirmLabel: string; destructive?: boolean }): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      setState({ ...props, resolve })
    })

  return [node, ask] as const
}
