import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBody, MButton, MButtonRow, MI, MInput, MListPlain, MListRow, MPill, MTextarea, MTopBar } from '@/components/m'
import { useBonusRules, useCreateBonusRule, useDeleteBonusRule, usePatchBonusRule, type BonusRule } from '@/lib/api'

/**
 * Bonus rule config is shaped like:
 *   { tiers: [{ minMargin: number; payoutPercent: number }] }
 * Editor uses raw JSON; a typed tier table can land later.
 */
export function CatalogBonusRulesScreen() {
  const rules = useBonusRules()
  const create = useCreateBonusRule()
  const [editing, setEditing] = useState<BonusRule | 'new' | null>(null)
  const navigate = useNavigate()

  return (
    <>
      <MTopBar
        back
        eyebrow="Settings"
        title="Bonus rules"
        sub={`${rules.data?.bonusRules.length ?? 0} rules`}
        actionLabel="New bonus rule"
        actionIcon={<span style={{ fontSize: 22, fontWeight: 800 }}>+</span>}
        onBack={() => navigate('/more/catalog')}
        onAction={() => setEditing('new')}
      />
      <MBody>
        {rules.isPending ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            Loading…
          </div>
        ) : (rules.data?.bonusRules ?? []).length === 0 ? (
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            No bonus rules yet.
          </div>
        ) : (
          <MListPlain>
            {rules.data?.bonusRules.map((r) => (
              <MListRow
                key={r.id}
                headline={r.name}
                supporting={`v${r.version}`}
                trailing={<MPill tone={r.is_active ? 'green' : undefined}>{r.is_active ? 'active' : 'inactive'}</MPill>}
                onTap={() => setEditing(r)}
              />
            ))}
          </MListPlain>
        )}
      </MBody>

      {editing !== null ? (
        <BonusRuleForm
          key={editing === 'new' ? 'new' : editing.id}
          rule={editing === 'new' ? null : editing}
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

function BonusRuleForm({
  rule,
  onClose,
  onCreate,
}: {
  rule: BonusRule | null
  onClose: () => void
  onCreate: (input: { name: string; is_active?: boolean; config?: unknown }) => Promise<void>
}) {
  const patch = usePatchBonusRule(rule?.id ?? '')
  const del = useDeleteBonusRule()
  const [confirmNode, askConfirm] = useMConfirm()
  const [name, setName] = useState(rule?.name ?? '')
  const [isActive, setIsActive] = useState(rule?.is_active ?? true)
  const [configText, setConfigText] = useState(
    rule
      ? JSON.stringify(rule.config, null, 2)
      : '{\n  "tiers": [\n    { "minMargin": 0.20, "payoutPercent": 0.05 }\n  ]\n}',
  )
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    let config: unknown
    try {
      config = JSON.parse(configText)
    } catch {
      setError('Config is not valid JSON')
      return
    }
    try {
      if (!rule) {
        await onCreate({ name: name.trim(), is_active: isActive, config })
      } else {
        await patch.mutateAsync({
          name: name.trim(),
          is_active: isActive,
          config,
          expected_version: rule.version,
        })
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const remove = async () => {
    if (!rule) return
    const ok = await askConfirm({
      title: 'Delete bonus rule?',
      body: `Permanently remove "${rule.name}".`,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await del.mutateAsync({ id: rule.id, expected_version: rule.version })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <MSheet title={rule ? 'Edit bonus rule' : 'New bonus rule'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 16 }}>
        <Field label="Name">
          <MInput value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            style={{ width: 16, height: 16, accentColor: 'var(--m-accent)' }}
          />
          <span style={{ fontSize: 13 }}>Active (eligible for payouts)</span>
        </label>
        <Field label="Tiers (JSON)">
          <MTextarea
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            rows={10}
            style={{ fontFamily: 'var(--m-num)', fontSize: 12, minHeight: 200, resize: 'vertical' }}
          />
        </Field>
        {error ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
        {rule ? (
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
