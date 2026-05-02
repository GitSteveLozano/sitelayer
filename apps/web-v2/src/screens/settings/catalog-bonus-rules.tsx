import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet, useConfirmSheet } from '@/components/mobile'
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

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more/catalog" className="text-[12px] text-ink-3">
        ← Catalog
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">Bonus rules</h1>
          <p className="text-[12px] text-ink-3 mt-1">{rules.data?.bonusRules.length ?? 0} rules</p>
        </div>
        <MobileButton variant="primary" onClick={() => setEditing('new')}>
          + New
        </MobileButton>
      </div>

      <div className="mt-6 space-y-2">
        {rules.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : (rules.data?.bonusRules ?? []).length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No bonus rules yet.</div>
          </Card>
        ) : (
          rules.data?.bonusRules.map((r) => (
            <button key={r.id} type="button" onClick={() => setEditing(r)} className="block w-full text-left">
              <Card tight>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold truncate">{r.name}</div>
                    <div className="text-[11px] text-ink-3 mt-0.5">v{r.version}</div>
                  </div>
                  <Pill tone={r.is_active ? 'good' : 'default'}>{r.is_active ? 'active' : 'inactive'}</Pill>
                </div>
              </Card>
            </button>
          ))
        )}
      </div>

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
    </div>
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
  const [confirmNode, askConfirm] = useConfirmSheet()
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
      destructive: true,
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
    <Sheet open onClose={onClose} title={rule ? 'Edit bonus rule' : 'New bonus rule'}>
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
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="rounded"
          />
          <span className="text-[13px]">Active (eligible for payouts)</span>
        </label>
        <label className="block">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Tiers (JSON)</div>
          <textarea
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            rows={10}
            className="mt-1 w-full font-mono text-[12px] p-2 rounded border border-line bg-card focus:outline-none focus:border-accent resize-y"
          />
        </label>
        {error ? <div className="text-[12px] text-warn">{error}</div> : null}
        <div className={rule ? 'grid grid-cols-2 gap-2' : ''}>
          <MobileButton variant="primary" onClick={submit} disabled={!name.trim() || patch.isPending}>
            {rule ? 'Save' : 'Create'}
          </MobileButton>
          {rule ? (
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
