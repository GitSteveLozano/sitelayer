import { type ConditionMeasurementKind, type TakeoffCondition } from '@/lib/api/conditions'
import { MButton, MSelect } from '@/components/m'

// Condition picker + inline create form (Takeoff Deep Dive H1) — extracted
// verbatim from the ITEM / quantities panel in desktop-body.tsx (behavior
// preserved). Picks the reusable typed template the next draw is tagged against
// ("None" keeps the legacy shape-first flow), or creates one inline.
export function ConditionPicker({
  conditions,
  activeConditionId,
  setActiveConditionId,
  activeCondition,
  conditionFormOpen,
  setConditionFormOpen,
  newConditionName,
  setNewConditionName,
  newConditionColor,
  setNewConditionColor,
  newConditionKind,
  setNewConditionKind,
  onCreateCondition,
  createPending,
}: {
  conditions: TakeoffCondition[]
  activeConditionId: string | null
  setActiveConditionId: (id: string | null) => void
  activeCondition: TakeoffCondition | null
  conditionFormOpen: boolean
  setConditionFormOpen: (next: (prev: boolean) => boolean) => void
  newConditionName: string
  setNewConditionName: (next: string) => void
  newConditionColor: string
  setNewConditionColor: (next: string) => void
  newConditionKind: ConditionMeasurementKind
  setNewConditionKind: (next: ConditionMeasurementKind) => void
  onCreateCondition: () => void
  createPending: boolean
}) {
  return (
    <>
      {/* Condition picker (Takeoff Deep Dive H1) — pick a reusable typed
          template the next draw is tagged against, or create one inline.
          "None" keeps the legacy shape-first flow (condition_id null), so
          the existing tag/service-item path below is always the fallback. */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-3)',
          }}
        >
          Condition
        </span>
        <MSelect
          value={activeConditionId ?? ''}
          onChange={(e) => setActiveConditionId(e.target.value ? e.target.value : null)}
        >
          <option value="">None (legacy)</option>
          {conditions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.measurement_kind}
            </option>
          ))}
        </MSelect>
        <MButton variant="ghost" size="sm" onClick={() => setConditionFormOpen((v) => !v)}>
          {conditionFormOpen ? 'Close' : '+ New'}
        </MButton>
        {activeCondition ? (
          <span
            aria-hidden
            title={activeCondition.name}
            style={{
              width: 12,
              height: 12,
              background: activeCondition.color,
              border: '1px solid var(--m-line)',
              flex: '0 0 auto',
            }}
          />
        ) : null}
      </label>

      {/* Inline create-condition form (minimal: name + color + kind). The
          deeper condition-first draw flow — driver-derived multi-result
          emission, default-assembly auto-attach — is a flagged follow-up. */}
      {conditionFormOpen ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={newConditionName}
            onChange={(e) => setNewConditionName(e.target.value)}
            placeholder="Condition name"
            maxLength={120}
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 12,
              padding: '4px 8px',
              border: '2px solid var(--m-ink)',
              background: 'var(--m-card)',
              color: 'var(--m-ink)',
            }}
          />
          <input
            type="color"
            value={newConditionColor}
            onChange={(e) => setNewConditionColor(e.target.value)}
            title="Condition color"
            style={{ width: 32, height: 28, padding: 0, border: '2px solid var(--m-ink)' }}
          />
          <MSelect
            value={newConditionKind}
            onChange={(e) => setNewConditionKind(e.target.value as ConditionMeasurementKind)}
          >
            <option value="area">area</option>
            <option value="linear">linear</option>
            <option value="count">count</option>
            <option value="volume">volume</option>
          </MSelect>
          <MButton size="sm" onClick={onCreateCondition} disabled={createPending}>
            {createPending ? 'Saving…' : 'Create'}
          </MButton>
        </div>
      ) : null}
    </>
  )
}
