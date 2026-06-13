import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBody, MButton, MButtonRow, MI, MInput, MListPlain, MListRow, MPill, MTopBar } from '@/components/m'
import { useCreateCustomer, useCustomers, useDeleteCustomer, usePatchCustomer, type Customer } from '@/lib/api'

export function CatalogCustomersScreen() {
  const customers = useCustomers()
  const create = useCreateCustomer()
  const [editing, setEditing] = useState<Customer | 'new' | null>(null)
  const navigate = useNavigate()

  return (
    <>
      <MTopBar
        back
        eyebrow="Settings"
        title="Customers"
        sub={`${customers.data?.customers.length ?? 0} active`}
        actionLabel="New customer"
        actionIcon={<span style={{ fontSize: 22, fontWeight: 800 }}>+</span>}
        onBack={() => navigate('/more/catalog')}
        onAction={() => setEditing('new')}
      />
      <MBody>
        {customers.isPending ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            Loading…
          </div>
        ) : (customers.data?.customers ?? []).length === 0 ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            No customers yet.
          </div>
        ) : (
          <MListPlain>
            {customers.data?.customers.map((c) => (
              <MListRow
                key={c.id}
                headline={c.name}
                supporting={c.external_id ? `QBO #${c.external_id}` : 'No QBO link'}
                trailing={<MPill tone={c.source === 'qbo' ? 'green' : undefined}>{c.source}</MPill>}
                onTap={() => setEditing(c)}
              />
            ))}
          </MListPlain>
        )}
      </MBody>

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
    </>
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
  const [confirmNode, askConfirm] = useMConfirm()
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
    const ok = await askConfirm({
      title: 'Delete customer?',
      body: `Permanently remove "${customer.name}".`,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await del.mutateAsync({ id: customer.id, expected_version: customer.version })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <MSheet title={isNew ? 'New customer' : 'Edit customer'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 16 }}>
        <Field label="Name">
          <MInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name" />
        </Field>
        <Field label="QBO external id (optional)">
          <MInput value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="123" />
        </Field>
        {error ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
        {isNew ? (
          <MButton variant="primary" onClick={submit} disabled={!name.trim() || patch.isPending}>
            Create
          </MButton>
        ) : (
          <MButtonRow>
            <MButton variant="primary" onClick={submit} disabled={!name.trim() || patch.isPending}>
              Save
            </MButton>
            <MButton
              variant="ghost"
              onClick={remove}
              disabled={del.isPending}
              style={{ color: 'var(--m-red)', borderColor: 'var(--m-red)' }}
            >
              Delete
            </MButton>
          </MButtonRow>
        )}
      </div>
      {confirmNode}
    </MSheet>
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="m-topbar-eyebrow">{label}</span>
      {children}
    </label>
  )
}

/**
 * `.m-sheet` replacement for the legacy `useConfirmSheet` hook — same
 * `[node, ask]` API, resolves the promise with the user's choice.
 */
function useMConfirm() {
  const [state, setState] = useState<{
    title: string
    body: string
    confirmLabel: string
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
              style={{ background: 'var(--m-red)', borderColor: 'var(--m-red)', color: '#fff' }}
            >
              {state.confirmLabel}
            </MButton>
          </MButtonRow>
        </div>
      </MSheet>
    ) : null

  const ask = (props: { title: string; body: string; confirmLabel: string }): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      setState({ ...props, resolve })
    })

  return [node, ask] as const
}
