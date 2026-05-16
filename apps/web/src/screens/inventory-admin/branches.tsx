import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet } from '@/components/mobile'
import { useBranches, useCreateBranch, usePatchBranch, type Branch } from '@/lib/api/scaffold-ops'

export function BranchesAdminScreen() {
  const branches = useBranches()
  const create = useCreateBranch()
  const patch = usePatchBranch()
  const [editing, setEditing] = useState<Branch | 'new' | null>(null)
  const rows = branches.data?.branches ?? []

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
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more/inventory" className="text-[12px] text-ink-3">
        ← Inventory admin
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">Branches</h1>
          <p className="text-[12px] text-ink-3 mt-1">{rows.length} active</p>
          <p className="text-[12px] text-ink-3 mt-1">
            Locations / yards / jobsites roll up into a branch. The default branch is used when an inventory location is
            created without one specified.
          </p>
        </div>
        <MobileButton variant="primary" onClick={() => setEditing('new')}>
          + New
        </MobileButton>
      </div>

      <div className="mt-6 space-y-2">
        {branches.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : rows.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No branches yet.</div>
          </Card>
        ) : (
          rows.map((b) => (
            <button key={b.id} type="button" onClick={() => setEditing(b)} className="block w-full text-left">
              <Card tight>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold truncate">{b.name}</div>
                    <div className="text-[11px] text-ink-3 mt-0.5">
                      <span className="font-mono">{b.code}</span>
                      {b.address ? <> · {b.address}</> : null}
                    </div>
                  </div>
                  {b.is_default ? <Pill tone="good">default</Pill> : null}
                </div>
              </Card>
            </button>
          ))
        )}
      </div>

      {editing !== null ? (
        <Sheet open onClose={() => setEditing(null)} title={editing === 'new' ? 'New branch' : `Edit ${editing.name}`}>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              onSubmit(new FormData(e.currentTarget))
            }}
            className="space-y-3"
          >
            <label className="block">
              <span className="text-[12px] text-ink-3">Code</span>
              <input
                name="code"
                defaultValue={editing === 'new' ? '' : editing.code}
                disabled={editing !== 'new'}
                className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[14px] font-mono"
                required
              />
            </label>
            <label className="block">
              <span className="text-[12px] text-ink-3">Name</span>
              <input
                name="name"
                defaultValue={editing === 'new' ? '' : editing.name}
                className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[14px]"
                required
              />
            </label>
            <label className="block">
              <span className="text-[12px] text-ink-3">Address</span>
              <input
                name="address"
                defaultValue={editing === 'new' ? '' : (editing.address ?? '')}
                className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[14px]"
              />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="is_default" defaultChecked={editing !== 'new' && editing.is_default} />
              <span className="text-[13px]">Make default branch</span>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <MobileButton type="button" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </MobileButton>
              <MobileButton type="submit" variant="primary" disabled={create.isPending || patch.isPending}>
                Save
              </MobileButton>
            </div>
          </form>
        </Sheet>
      ) : null}
    </div>
  )
}
