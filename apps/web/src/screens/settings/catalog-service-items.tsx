import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet, useConfirmSheet } from '@/components/mobile'
import {
  useCreateServiceItem,
  useDeleteServiceItem,
  usePatchServiceItem,
  useServiceItems,
  type ServiceItem,
} from '@/lib/api'

const CATEGORIES = ['labor', 'material', 'sub', 'rental', 'freight', 'other']
const UNITS = ['hr', 'sqft', 'lf', 'ea', 'cu yd', 'day']
const STATUSES = ['active', 'seasonal', 'retired'] as const
type ServiceItemStatus = (typeof STATUSES)[number]

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/**
 * Build the design's cost-history trail ("WAS $3.20 (MAR) · $2.95 (JAN) · UP 17%
 * YTD") from the item's `rate_history` (most-recent first). The history's first
 * entry mirrors the current rate, so the prior changes start at index 1. The YTD
 * delta compares the current rate to the oldest in-year entry. Returns null when
 * there is no prior change to show.
 */
function formatRateHistory(item: ServiceItem): string | null {
  const history = item.rate_history ?? []
  const current = item.default_rate == null ? null : Number(item.default_rate)
  // Prior changes = everything after the most-recent (current) snapshot.
  const prior = history.slice(1).filter((h) => h.rate != null)
  const parts = prior.slice(0, 2).map((h) => {
    const month = MONTHS[new Date(h.recorded_at).getUTCMonth()] ?? ''
    return `$${Number(h.rate).toFixed(2)}${month ? ` (${month})` : ''}`
  })
  let ytd = ''
  if (current != null) {
    const thisYear = new Date().getUTCFullYear()
    const inYear = history.filter((h) => h.rate != null && new Date(h.recorded_at).getUTCFullYear() === thisYear)
    const oldestInYear = inYear[inYear.length - 1]
    const base = oldestInYear?.rate != null ? Number(oldestInYear.rate) : null
    if (base != null && base > 0 && base !== current) {
      const pct = Math.round(((current - base) / base) * 100)
      ytd = `${pct >= 0 ? 'UP' : 'DOWN'} ${Math.abs(pct)}% YTD`
    }
  }
  // The first prior change leads the line with a "WAS" prefix; the rest of the
  // prior values and the YTD delta follow as dot-separated segments.
  if (parts.length === 0) return ytd || null
  const lead = `WAS ${parts[0]}`
  const rest = [...parts.slice(1), ...(ytd ? [ytd] : [])]
  return [lead, ...rest].join(' · ')
}

export function CatalogServiceItemsScreen() {
  const items = useServiceItems()
  const create = useCreateServiceItem()
  const [editing, setEditing] = useState<ServiceItem | 'new' | null>(null)

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more/catalog" className="text-[12px] text-ink-3">
        ← Catalog
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">Service items</h1>
          <p className="text-[12px] text-ink-3 mt-1">{items.data?.serviceItems.length ?? 0} items</p>
        </div>
        <MobileButton variant="primary" onClick={() => setEditing('new')}>
          + New
        </MobileButton>
      </div>

      <div className="mt-6 space-y-2">
        {items.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : (items.data?.serviceItems ?? []).length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No service items yet.</div>
          </Card>
        ) : (
          items.data?.serviceItems.map((item) => (
            <button key={item.code} type="button" onClick={() => setEditing(item)} className="block w-full text-left">
              <Card tight>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold truncate">
                      {item.code} · {item.name}
                    </div>
                    <div className="text-[11px] text-ink-3 mt-0.5">
                      {item.category} · {item.unit}
                      {item.default_rate ? ` · $${Number(item.default_rate).toFixed(2)}` : ''}
                    </div>
                  </div>
                  <Pill tone={item.source === 'qbo' ? 'good' : 'default'}>{item.source}</Pill>
                </div>
              </Card>
            </button>
          ))
        )}
      </div>

      {editing !== null ? (
        <ServiceItemForm
          key={editing === 'new' ? 'new' : editing.code}
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreate={async (input) => {
            await create.mutateAsync(input)
            setEditing(null)
          }}
        />
      ) : null}
    </div>
  )
}

function ServiceItemForm({
  item,
  onClose,
  onCreate,
}: {
  item: ServiceItem | null
  onClose: () => void
  onCreate: (input: {
    code: string
    name: string
    category?: string
    unit?: string
    default_rate?: number | null
    labor_multiplier?: number | null
    status?: ServiceItemStatus
  }) => Promise<void>
}) {
  const patch = usePatchServiceItem(item?.code ?? '')
  const del = useDeleteServiceItem()
  const [confirmNode, askConfirm] = useConfirmSheet()
  const [code, setCode] = useState(item?.code ?? '')
  const [name, setName] = useState(item?.name ?? '')
  const [category, setCategory] = useState(item?.category ?? 'labor')
  const [unit, setUnit] = useState(item?.unit ?? 'hr')
  const [rate, setRate] = useState(item?.default_rate ?? '')
  const [multiplier, setMultiplier] = useState(item?.labor_multiplier ?? '')
  const [status, setStatus] = useState<ServiceItemStatus>(item?.status ?? 'active')
  const [error, setError] = useState<string | null>(null)

  const historyLine = item ? formatRateHistory(item) : null

  const submit = async () => {
    setError(null)
    try {
      const numericRate = rate === '' || rate === null ? null : Number(rate)
      const numericMultiplier = multiplier === '' || multiplier === null ? null : Number(multiplier)
      if (!item) {
        await onCreate({
          code: code.trim(),
          name: name.trim(),
          category,
          unit,
          default_rate: numericRate,
          labor_multiplier: numericMultiplier,
          status,
        })
      } else {
        await patch.mutateAsync({
          name: name.trim(),
          category,
          unit,
          default_rate: numericRate,
          labor_multiplier: numericMultiplier,
          status,
          expected_version: item.version,
        })
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const remove = async () => {
    if (!item) return
    const ok = await askConfirm({
      title: 'Delete service item?',
      body: `Permanently remove "${item.code}".`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await del.mutateAsync({ code: item.code, expected_version: item.version })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <Sheet open onClose={onClose} title={item ? 'Edit service item' : 'New service item'}>
      <div className="space-y-3">
        {!item ? (
          <Field label="Code" value={code} onChange={setCode} placeholder="LBR-FRMR" />
        ) : (
          <>
            {/* CURRENT COST KPI header (msg__85) — the big-number current rate
                + unit, derived from the item's stored default_rate. */}
            <div className="flex items-baseline gap-2">
              <span className="font-display text-[44px] font-extrabold leading-none tracking-tight">
                {item.default_rate == null ? '$—' : `$${Number(item.default_rate).toFixed(2)}`}
              </span>
              <span className="text-[11px] font-mono uppercase tracking-[0.06em] bg-accent text-ink px-1.5 py-0.5">
                / {item.unit || 'ea'}
              </span>
            </div>
            <div className="text-[10px] font-mono uppercase tracking-[0.06em] text-ink-3">Current cost</div>
            {/* Cost-history trail (msg__85 "WAS $3.20 (MAR) · $2.95 (JAN) · UP
                17% YTD"), derived from the item's recorded rate changes. */}
            {historyLine ? (
              <div className="text-[11px] font-mono uppercase tracking-[0.04em] text-ink-3">{historyLine}</div>
            ) : null}
            <div className="text-[12px] text-ink-3">
              Code: <span className="font-mono">{item.code}</span> (immutable)
            </div>
          </>
        )}
        <Field label="Name" value={name} onChange={setName} placeholder="Foreman labor" />
        <Select label="Category" value={category} onChange={setCategory} options={CATEGORIES} />
        <Select label="Unit" value={unit} onChange={setUnit} options={UNITS} />
        <Field
          label={item ? 'New cost' : 'Default rate (optional)'}
          value={String(rate ?? '')}
          onChange={setRate}
          placeholder="0.00"
        />
        {/* Labor multiplier (msg__85 "1.25× STD INSTALL") — productivity factor
            on top of the catalog rate. */}
        <Field label="Labor multiplier" value={String(multiplier ?? '')} onChange={setMultiplier} placeholder="1.00" />
        {/* Lifecycle status (msg__85 ACTIVE / SEASONAL / RETIRED), distinct from
            delete — a brutalist square segmented control. */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Status</div>
          <div className="mt-1 grid grid-cols-3 border border-line">
            {STATUSES.map((s, i) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                className={`py-2 text-[12px] font-semibold uppercase tracking-[0.06em] ${
                  i > 0 ? 'border-l border-line' : ''
                } ${status === s ? 'bg-accent text-ink' : 'bg-transparent text-ink-3'}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        {error ? <div className="text-[12px] text-warn">{error}</div> : null}
        <div className={item ? 'grid grid-cols-2 gap-2' : ''}>
          <MobileButton
            variant="primary"
            onClick={submit}
            disabled={(!item && !code.trim()) || !name.trim() || patch.isPending}
          >
            {item ? 'Save' : 'Create'}
          </MobileButton>
          {item ? (
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
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <label className="block">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <input
        type="text"
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
  options: readonly string[]
}) {
  return (
    <label className="block">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}
