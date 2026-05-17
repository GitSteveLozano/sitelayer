import { MTapCard } from '../../../components/m/index.js'
import { TABS, type TabKey } from '../project-detail.js'

export function TabBar({ active, onChange }: { active: TabKey; onChange: (k: TabKey) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        padding: '12px 16px 4px',
        overflowX: 'auto',
      }}
    >
      {TABS.map((t) => (
        <MTapCard
          key={t.key}
          onClick={() => onChange(t.key)}
          style={{
            background: active === t.key ? 'var(--m-accent)' : 'transparent',
            color: active === t.key ? 'white' : 'var(--m-ink-2)',
            border: 'none',
            borderRadius: 999,
            padding: '6px 14px',
            width: 'auto',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 500 }}>{t.label}</span>
        </MTapCard>
      ))}
    </div>
  )
}
