import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Sheet, useConfirmSheet } from '@/components/mobile'
import { MButton, MInput, MListInset, MListRow, MPill, MSectionH, MTextarea } from '@/components/m'
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
 *
 * Restyled onto the m-* design system (MListRow / MPill / MButton / MInput /
 * MTextarea + var(--m-*) tokens) — the visual language the rest of the v3.3.0
 * mobile shell uses. Data wiring (usePricingProfiles etc.) is unchanged.
 */
const LABEL_STYLE: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--m-ink-3)',
}

export function CatalogPricingProfilesScreen() {
  const profiles = usePricingProfiles()
  const create = useCreatePricingProfile()
  const [editing, setEditing] = useState<PricingProfile | 'new' | null>(null)

  const list = profiles.data?.pricingProfiles ?? []

  return (
    <div style={{ padding: '24px 20px 48px', maxWidth: 672, margin: '0 auto' }}>
      <Link to="/more/catalog" style={{ fontSize: 12, color: 'var(--m-ink-3)', textDecoration: 'none' }}>
        ← Catalog
      </Link>
      <div
        style={{
          marginTop: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: 'var(--m-font)',
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              lineHeight: 1.1,
              color: 'var(--m-ink)',
              margin: 0,
            }}
          >
            Pricing profiles
          </h1>
          <p style={{ fontSize: 12, color: 'var(--m-ink-3)', marginTop: 4 }}>{list.length} profiles</p>
        </div>
        <MButton size="sm" variant="primary" onClick={() => setEditing('new')}>
          + New
        </MButton>
      </div>

      <div style={{ marginTop: 24 }}>
        <MSectionH>Profiles</MSectionH>
        {profiles.isPending ? (
          <div style={{ padding: '14px 16px', fontSize: 12, color: 'var(--m-ink-3)' }}>Loading…</div>
        ) : list.length === 0 ? (
          <div style={{ padding: '14px 16px', fontSize: 12, color: 'var(--m-ink-3)' }}>No pricing profiles yet.</div>
        ) : (
          <MListInset>
            {list.map((p) => (
              <MListRow
                key={p.id}
                headline={p.name}
                supporting={`v${p.version}`}
                trailing={
                  p.is_default ? (
                    <MPill tone="green" dot>
                      default
                    </MPill>
                  ) : (
                    <MPill>profile</MPill>
                  )
                }
                chev
                onTap={() => setEditing(p)}
              />
            ))}
          </MListInset>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={LABEL_STYLE}>Name</span>
          <MInput type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          <span style={{ fontSize: 13, color: 'var(--m-ink)' }}>Default for new projects</span>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={LABEL_STYLE}>Config (JSON)</span>
          <MTextarea
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            rows={10}
            style={{ fontFamily: 'var(--m-num)', fontSize: 12, resize: 'vertical' }}
          />
        </label>
        {error ? <div style={{ fontSize: 12, color: 'var(--m-red)' }}>{error}</div> : null}
        <div
          style={{ display: profile ? 'grid' : 'block', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}
        >
          <MButton variant="primary" onClick={submit} disabled={!name.trim() || patch.isPending}>
            {profile ? 'Save' : 'Create'}
          </MButton>
          {profile ? (
            <MButton variant="ghost" onClick={remove} disabled={del.isPending}>
              Delete
            </MButton>
          ) : null}
        </div>
      </div>
      {confirmNode}
    </Sheet>
  )
}
