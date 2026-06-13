import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBody, MButton, MButtonRow, MI, MInput, MListPlain, MListRow, MPill, MSelect, MTopBar } from '@/components/m'
import { useCreateWorker, useDeleteWorker, usePatchWorker, useWorkers, type Worker } from '@/lib/api'

const ROLES = ['crew', 'foreman', 'lead', 'operator', 'subcontractor']

export function CatalogWorkersScreen() {
  const workers = useWorkers()
  const create = useCreateWorker()
  const [editing, setEditing] = useState<Worker | 'new' | null>(null)
  const navigate = useNavigate()

  return (
    <>
      <MTopBar
        back
        eyebrow="Settings"
        title="Workers"
        sub={`${workers.data?.workers.length ?? 0} on roster`}
        actionLabel="New worker"
        actionIcon={<span style={{ fontSize: 22, fontWeight: 800 }}>+</span>}
        onBack={() => navigate('/more/catalog')}
        onAction={() => setEditing('new')}
      />
      <MBody>
        {workers.isPending ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            Loading…
          </div>
        ) : (workers.data?.workers ?? []).length === 0 ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            No workers yet.
          </div>
        ) : (
          <MListPlain>
            {workers.data?.workers.map((w) => (
              <MListRow
                key={w.id}
                headline={w.name}
                supporting={`v${w.version}`}
                trailing={<MPill tone={w.role === 'foreman' ? 'green' : undefined}>{w.role}</MPill>}
                onTap={() => setEditing(w)}
              />
            ))}
          </MListPlain>
        )}
      </MBody>

      <WorkerSheet
        editing={editing}
        onClose={() => setEditing(null)}
        onCreate={async (input) => {
          await create.mutateAsync(input)
          setEditing(null)
        }}
      />
    </>
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
  const [confirmNode, askConfirm] = useMConfirm()
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
    <MSheet title={worker ? 'Edit worker' : 'New worker'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 16 }}>
        <Field label="Name">
          <MInput value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Role">
          <MSelect value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </MSelect>
        </Field>
        {error ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
        {worker ? (
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
        ) : (
          <MButton variant="primary" onClick={submit} disabled={!name.trim() || patch.isPending}>
            Create
          </MButton>
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
