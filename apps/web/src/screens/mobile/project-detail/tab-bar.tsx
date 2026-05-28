import { TABS, type TabKey } from '../project-detail.js'

export function TabBar({ active, onChange }: { active: TabKey; onChange: (k: TabKey) => void }) {
  return (
    <div
      className="m-section-bar"
      style={{
        gap: 0,
        padding: 0,
        overflowX: 'auto',
        justifyContent: 'flex-start',
      }}
    >
      {TABS.map((t) => {
        const isActive = active === t.key
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            style={{
              flexShrink: 0,
              appearance: 'none',
              border: 'none',
              borderRight: '2px solid var(--m-line)',
              background: isActive ? 'var(--m-accent)' : 'transparent',
              color: isActive ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: isActive ? 700 : 500,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              padding: '14px 18px',
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
