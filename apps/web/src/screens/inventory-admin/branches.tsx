import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBody, MButton, MButtonRow, MI, MInput, MListPlain, MListRow, MPill, MTopBar } from '@/components/m'
import { useBranches, useCreateBranch, usePatchBranch, type Branch } from '@/lib/api/scaffold-ops'

export function BranchesAdminScreen() {
  const branches = useBranches()
  const create = useCreateBranch()
  const patch = usePatchBranch()
  const [editing, setEditing] = useState<Branch | 'new' | null>(null)
  const rows = branches.data?.branches ?? []
  const navigate = useNavigate()

  function onSubmit(form: FormData) {
    const code = String(form.get('code') ?? '').trim()
    const name = String(form.get('name') ?? '').trim()
    const address = String(form.get('address') ?? '').trim() || null
    const isDefault = form.get('is_default') === 'on'
    if (!code || !name) return
    if (editing === 'new') {
      create.mutate({ code, name, address, is_default: isDefault }, { onSuccess: () => setEditing(null) })
    } else if (editing) {
      patch.mutate({ id: editing.id, name, address, is_default: isDefault }, { onSuccess: () => setEditing(null) })
    }
  }

  return (
    <>
      <MTopBar
        back
        eyebrow="Inventory admin"
        title="Branches"
        sub={`${rows.length} active`}
        actionLabel="New branch"
        actionIcon={<span style={{ fontSize: 22, fontWeight: 800 }}>+</span>}
        onBack={() => navigate('/more/inventory')}
        onAction={() => setEditing('new')}
      />
      <MBody>
        <p className="m-quiet-sm" style={{ padding: '14px 16px 4px', margin: 0 }}>
          Locations / yards / jobsites roll up into a branch. The default branch is used when an inventory location is
          created without one specified.
        </p>
        {branches.isPending ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            No branches yet.
          </div>
        ) : (
          <MListPlain>
            {rows.map((b) => (
              <MListRow
                key={b.id}
                headline={b.name}
                supporting={
                  <>
                    <span style={{ fontFamily: 'var(--m-num)' }}>{b.code}</span>
                    {b.address ? <> · {b.address}</> : null}
                  </>
                }
                trailing={b.is_default ? <MPill tone="green">default</MPill> : undefined}
                onTap={() => setEditing(b)}
              />
            ))}
          </MListPlain>
        )}
      </MBody>

      {editing !== null ? (
        <MSheet title={editing === 'new' ? 'New branch' : `Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              onSubmit(new FormData(e.currentTarget))
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 16 }}
          >
            <Field label="Code">
              <MInput
                name="code"
                defaultValue={editing === 'new' ? '' : editing.code}
                disabled={editing !== 'new'}
                style={{ fontFamily: 'var(--m-num)' }}
                required
              />
            </Field>
            <Field label="Name">
              <MInput name="name" defaultValue={editing === 'new' ? '' : editing.name} required />
            </Field>
            <Field label="Address">
              <MInput name="address" defaultValue={editing === 'new' ? '' : (editing.address ?? '')} />
            </Field>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" name="is_default" defaultChecked={editing !== 'new' && editing.is_default} />
              <span>Make default branch</span>
            </label>
            <MButtonRow>
              <MButton type="button" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </MButton>
              <MButton type="submit" variant="primary" disabled={create.isPending || patch.isPending}>
                Save
              </MButton>
            </MButtonRow>
          </form>
        </MSheet>
      ) : null}
    </>
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
