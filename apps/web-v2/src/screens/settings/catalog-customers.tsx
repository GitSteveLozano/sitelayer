import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet } from '@/components/mobile'
import { useCreateCustomer, useCustomers, useDeleteCustomer, usePatchCustomer, type Customer } from '@/lib/api'

export function CatalogCustomersScreen() {
  const customers = useCustomers()
  const create = useCreateCustomer()
  const [editing, setEditing] = useState<Customer | 'new' | null>(null)

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more/catalog" className="text-[12px] text-ink-3">
        ← Catalog
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">Customers</h1>
          <p className="text-[12px] text-ink-3 mt-1">{customers.data?.customers.length ?? 0} active</p>
        </div>
        <MobileButton variant="primary" onClick={() => setEditing('new')}>
          + New
        </MobileButton>
      </div>

      <div className="mt-6 space-y-2">
        {customers.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : (customers.data?.customers ?? []).length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No customers yet.</div>
          </Card>
        ) : (
          customers.data?.customers.map((c) => (
            <button key={c.id} type="button" onClick={() => setEditing(c)} className="block w-full text-left">
              <Card tight>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold truncate">{c.name}</div>
                    <div className="text-[11px] text-ink-3 mt-0.5 truncate">
                      {c.external_id ? `QBO #${c.external_id}` : 'No QBO link'}
                    </div>
                  </div>
                  <Pill tone={c.source === 'qbo' ? 'good' : 'default'}>{c.source}</Pill>
                </div>
              </Card>
            </button>
          ))
        )}
      </div>

      {editing !== null ? (
        <CustomerSheet
          key={editing === 'new' ? 'new' : editing.id}
          customer={editing === 'new' ? null : editing}
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

function CustomerSheet({
  customer,
  onClose,
  onCreate,
}: {
  customer: Customer | null
  onClose: () => void
  onCreate: (input: { name: string; external_id?: string | null; source?: string }) => Promise<void>
}) {
  const patch = usePatchCustomer(customer?.id ?? '')
  const del = useDeleteCustomer()
  const [name, setName] = useState(customer?.name ?? '')
  const [externalId, setExternalId] = useState(customer?.external_id ?? '')
  const [error, setError] = useState<string | null>(null)
  const isNew = !customer

  const submit = async () => {
    setError(null)
    try {
      if (isNew) {
        await onCreate({ name: name.trim(), external_id: externalId.trim() || null })
      } else if (customer) {
        await patch.mutateAsync({
          name: name.trim(),
          external_id: externalId.trim() || null,
          expected_version: customer.version,
        })
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const remove = async () => {
    if (!customer) return
    if (typeof window !== 'undefined' && !window.confirm(`Delete "${customer.name}"?`)) return
    try {
      await del.mutateAsync({ id: customer.id, expected_version: customer.version })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <Sheet open onClose={onClose} title={isNew ? 'New customer' : 'Edit customer'}>
      <div className="space-y-3">
        <Field label="Name" value={name} onChange={setName} placeholder="Customer name" />
        <Field label="QBO external id (optional)" value={externalId} onChange={setExternalId} placeholder="123" />
        {error ? <div className="text-[12px] text-status-warn">{error}</div> : null}
        <div className={isNew ? '' : 'grid grid-cols-2 gap-2'}>
          <MobileButton variant="primary" onClick={submit} disabled={!name.trim() || patch.isPending}>
            {isNew ? 'Create' : 'Save'}
          </MobileButton>
          {!isNew ? (
            <MobileButton variant="ghost" onClick={remove} disabled={del.isPending}>
              Delete
            </MobileButton>
          ) : null}
        </div>
      </div>
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
