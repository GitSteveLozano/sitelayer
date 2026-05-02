import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet, useConfirmSheet } from '@/components/mobile'
import {
  useCreatePricingProfile,
  useDeletePricingProfile,
  usePatchPricingProfile,
  usePricingProfiles,
  type PricingProfile,
} from '@/lib/api'

/**
 * Pricing profile config is shaped like:
 *   { divisions: { [code]: { rate_standard: number; rate_overtime: number } } }
 * but the editor uses a raw JSON textarea until a typed editor lands.
 * Validates on blur — invalid JSON blocks save.
 */
export function CatalogPricingProfilesScreen() {
  const profiles = usePricingProfiles()
  const create = useCreatePricingProfile()
  const [editing, setEditing] = useState<PricingProfile | 'new' | null>(null)

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more/catalog" className="text-[12px] text-ink-3">
        ← Catalog
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">Pricing profiles</h1>
          <p className="text-[12px] text-ink-3 mt-1">{profiles.data?.pricingProfiles.length ?? 0} profiles</p>
        </div>
        <MobileButton variant="primary" onClick={() => setEditing('new')}>
          + New
        </MobileButton>
      </div>

      <div className="mt-6 space-y-2">
        {profiles.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : (profiles.data?.pricingProfiles ?? []).length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No pricing profiles yet.</div>
          </Card>
        ) : (
          profiles.data?.pricingProfiles.map((p) => (
            <button key={p.id} type="button" onClick={() => setEditing(p)} className="block w-full text-left">
              <Card tight>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold truncate">{p.name}</div>
                    <div className="text-[11px] text-ink-3 mt-0.5">v{p.version}</div>
                  </div>
                  {p.is_default ? <Pill tone="good">default</Pill> : <Pill tone="default">profile</Pill>}
                </div>
              </Card>
            </button>
          ))
        )}
      </div>

      {editing !== null ? (
        <PricingProfileForm
          key={editing === 'new' ? 'new' : editing.id}
          profile={editing === 'new' ? null : editing}
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

function PricingProfileForm({
  profile,
  onClose,
  onCreate,
}: {
  profile: PricingProfile | null
  onClose: () => void
  onCreate: (input: { name: string; is_default?: boolean; config?: unknown }) => Promise<void>
}) {
  const patch = usePatchPricingProfile(profile?.id ?? '')
  const del = useDeletePricingProfile()
  const [confirmNode, askConfirm] = useConfirmSheet()
  const [name, setName] = useState(profile?.name ?? '')
  const [isDefault, setIsDefault] = useState(profile?.is_default ?? false)
  const [configText, setConfigText] = useState(
    profile ? JSON.stringify(profile.config, null, 2) : '{\n  "divisions": {}\n}',
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
      if (!profile) {
        await onCreate({ name: name.trim(), is_default: isDefault, config })
      } else {
        await patch.mutateAsync({
          name: name.trim(),
          is_default: isDefault,
          config,
          expected_version: profile.version,
        })
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const remove = async () => {
    if (!profile) return
    const ok = await askConfirm({
      title: 'Delete pricing profile?',
      body: `Permanently remove "${profile.name}".`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await del.mutateAsync({ id: profile.id, expected_version: profile.version })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <Sheet open onClose={onClose} title={profile ? 'Edit pricing profile' : 'New pricing profile'}>
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
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="rounded"
          />
          <span className="text-[13px]">Default for new projects</span>
        </label>
        <label className="block">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Config (JSON)</div>
          <textarea
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            rows={10}
            className="mt-1 w-full font-mono text-[12px] p-2 rounded border border-line bg-card focus:outline-none focus:border-accent resize-y"
          />
        </label>
        {error ? <div className="text-[12px] text-status-warn">{error}</div> : null}
        <div className={profile ? 'grid grid-cols-2 gap-2' : ''}>
          <MobileButton variant="primary" onClick={submit} disabled={!name.trim() || patch.isPending}>
            {profile ? 'Save' : 'Create'}
          </MobileButton>
          {profile ? (
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
