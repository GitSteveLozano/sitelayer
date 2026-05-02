import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet, useConfirmSheet } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import {
  useCreateContractLine,
  useCreateRentalContract,
  useDeleteContractLine,
  useGenerateBillingRun,
  useInventoryItems,
  usePatchContractLine,
  usePatchRentalContract,
  usePreviewBillingRun,
  useProject,
  useProjectRentalContracts,
  useRentalContractLines,
  type BillingRunPreview,
  type JobRentalContract,
  type RentalContractLine,
} from '@/lib/api'

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
      <h1 className="mt-2 font-display text-[24px] font-bold tracking-tight leading-tight">Rental contract</h1>
      <p className="text-[12px] text-ink-3 mt-1">
        25-day cycles by default — generate billing runs to land invoices in QBO.
      </p>

      {contracts.isPending ? (
        <Card tight className="mt-6">
          <div className="text-[12px] text-ink-3">Loading…</div>
        </Card>
      ) : !activeContract ? (
        <div className="mt-6 space-y-3">
          <Card>
            <div className="text-[13px] font-semibold">No active contract</div>
            <div className="text-[12px] text-ink-3 mt-1">Create one to start billing rentals on this project.</div>
            <div className="mt-3">
              <MobileButton variant="primary" onClick={() => setCreatingContract(true)}>
                + New contract
              </MobileButton>
            </div>
          </Card>
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
  const [confirmNode, askConfirm] = useConfirmSheet()
  const [editingLine, setEditingLine] = useState<RentalContractLine | 'new' | null>(null)
  const [previewData, setPreviewData] = useState<BillingRunPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingHeader, setEditingHeader] = useState(false)

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
      <Card>
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
          <Pill tone={contract.status === 'active' ? 'good' : 'default'}>{contract.status}</Pill>
        </div>
        <div className="mt-3">
          <MobileButton variant="ghost" onClick={() => setEditingHeader(true)}>
            Edit contract
          </MobileButton>
        </div>
      </Card>

      <div className="flex items-center justify-between pt-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Lines</div>
        <button type="button" onClick={() => setEditingLine('new')} className="text-[12px] text-accent font-medium">
          + Add line
        </button>
      </div>

      <div className="space-y-2">
        {lines.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : (lines.data?.lines ?? []).length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No lines yet — add the first one.</div>
          </Card>
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
                <Card tight>
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
                    <Pill tone={line.status === 'active' ? 'good' : 'default'}>{line.status}</Pill>
                  </div>
                </Card>
              </button>
            )
          })
        )}
      </div>

      <Card className="mt-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Generate billing run</div>
        <div className="text-[12px] text-ink-3 mt-1">
          Preview the next cycle, then generate an approvable run. Approval + post happens on the Financial tab.
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <MobileButton variant="ghost" onClick={onPreview} disabled={preview.isPending}>
            {preview.isPending ? 'Computing…' : 'Preview'}
          </MobileButton>
          <MobileButton variant="primary" onClick={onGenerate} disabled={generate.isPending || !previewData}>
            {generate.isPending ? 'Generating…' : 'Generate run'}
          </MobileButton>
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
        {error ? <div className="text-[12px] text-status-warn mt-2">{error}</div> : null}
      </Card>

      <div className="mt-2">
        <Attribution source="POST /api/rental-contracts/:id/billing-runs[/preview] · then approve via Financial tab" />
      </div>

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
    <Sheet open onClose={onClose} title="New contract">
      <div className="space-y-3">
        <Field label="Billing start date" value={start} onChange={setStart} type="date" />
        <Field label="Cycle days" value={cycle} onChange={setCycle} placeholder="25" />
        <Select label="Mode" value={mode} onChange={setMode} options={['arrears', 'in_advance']} />
        {error ? <div className="text-[12px] text-status-warn">{error}</div> : null}
        <MobileButton variant="primary" onClick={submit} disabled={!start}>
          Create
        </MobileButton>
      </div>
    </Sheet>
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
    <Sheet open onClose={onClose} title="Edit contract">
      <div className="space-y-3">
        <Field label="Billing start date" value={start} onChange={setStart} type="date" />
        <Field label="Next billing date" value={next} onChange={setNext} type="date" />
        <Field label="Cycle days" value={cycle} onChange={setCycle} placeholder="25" />
        <Select label="Mode" value={mode} onChange={setMode} options={['arrears', 'in_advance']} />
        <Select label="Status" value={status} onChange={setStatus} options={['draft', 'active', 'paused', 'closed']} />
        {error ? <div className="text-[12px] text-status-warn">{error}</div> : null}
        <MobileButton variant="primary" onClick={submit}>
          Save
        </MobileButton>
      </div>
    </Sheet>
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
  const [confirmNode, askConfirm] = useConfirmSheet()
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
    <Sheet open onClose={onClose} title={line ? 'Edit line' : 'New line'}>
      <div className="space-y-3">
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
        {error ? <div className="text-[12px] text-status-warn">{error}</div> : null}
        <div className={line ? 'grid grid-cols-2 gap-2' : ''}>
          <MobileButton
            variant="primary"
            onClick={submit}
            disabled={!itemId || Number(quantity) <= 0 || patch.isPending}
          >
            {line ? 'Save' : 'Add'}
          </MobileButton>
          {line ? (
            <MobileButton variant="ghost" onClick={remove} disabled={del.isPending}>
              Delete
            </MobileButton>
          ) : null}
        </div>
      </div>
      {confirmNode}
    </Sheet>
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
