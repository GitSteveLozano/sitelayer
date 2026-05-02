import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet, useConfirmSheet } from '@/components/mobile'
import { useCreateWorker, useDeleteWorker, usePatchWorker, useWorkers, type Worker } from '@/lib/api'

const ROLES = ['crew', 'foreman', 'lead', 'operator', 'subcontractor']

export function CatalogWorkersScreen() {
  const workers = useWorkers()
  const create = useCreateWorker()
  const [editing, setEditing] = useState<Worker | 'new' | null>(null)

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more/catalog" className="text-[12px] text-ink-3">
        ← Catalog
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">Workers</h1>
          <p className="text-[12px] text-ink-3 mt-1">{workers.data?.workers.length ?? 0} on roster</p>
        </div>
        <MobileButton variant="primary" onClick={() => setEditing('new')}>
          + New
        </MobileButton>
      </div>

      <div className="mt-6 space-y-2">
        {workers.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : (workers.data?.workers ?? []).length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No workers yet.</div>
          </Card>
        ) : (
          workers.data?.workers.map((w) => (
            <button key={w.id} type="button" onClick={() => setEditing(w)} className="block w-full text-left">
              <Card tight>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold truncate">{w.name}</div>
                    <div className="text-[11px] text-ink-3 mt-0.5">v{w.version}</div>
                  </div>
                  <Pill tone={w.role === 'foreman' ? 'good' : 'default'}>{w.role}</Pill>
                </div>
              </Card>
            </button>
          ))
        )}
      </div>

      <WorkerSheet
        editing={editing}
        onClose={() => setEditing(null)}
        onCreate={async (input) => {
          await create.mutateAsync(input)
          setEditing(null)
        }}
      />
    </div>
  )
}

function WorkerSheet({
  editing,
  onClose,
  onCreate,
}: {
  editing: Worker | 'new' | null
  onClose: () => void
  onCreate: (input: { name: string; role?: string }) => Promise<void>
}) {
  if (editing === null) return null
  const isNew = editing === 'new'
  const worker = isNew ? null : editing

  return <WorkerForm key={worker?.id ?? 'new'} worker={worker} onClose={onClose} onCreate={onCreate} />
}

function WorkerForm({
  worker,
  onClose,
  onCreate,
}: {
  worker: Worker | null
  onClose: () => void
  onCreate: (input: { name: string; role?: string }) => Promise<void>
}) {
  const patch = usePatchWorker(worker?.id ?? '')
  const del = useDeleteWorker()
  const [confirmNode, askConfirm] = useConfirmSheet()
  const [name, setName] = useState(worker?.name ?? '')
  const [role, setRole] = useState(worker?.role ?? 'crew')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    try {
      if (!worker) {
        await onCreate({ name: name.trim(), role })
      } else {
        await patch.mutateAsync({ name: name.trim(), role, expected_version: worker.version })
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const remove = async () => {
    if (!worker) return
    const ok = await askConfirm({
      title: 'Delete worker?',
      body: `Permanently remove "${worker.name}".`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await del.mutateAsync({ id: worker.id, expected_version: worker.version })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <Sheet open onClose={onClose} title={worker ? 'Edit worker' : 'New worker'}>
      <div className="space-y-3">
        <label className="block">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Name</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full text-[15px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Role</div>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        {error ? <div className="text-[12px] text-status-warn">{error}</div> : null}
        <div className={worker ? 'grid grid-cols-2 gap-2' : ''}>
          <MobileButton variant="primary" onClick={submit} disabled={!name.trim() || patch.isPending}>
            {worker ? 'Save' : 'Create'}
          </MobileButton>
          {worker ? (
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
