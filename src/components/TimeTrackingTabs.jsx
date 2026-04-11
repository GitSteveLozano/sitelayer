import { useState } from 'react'
import { TH } from '../lib/theme'
import { Schedule } from './Schedule'
import { DailyConfirm } from './DailyConfirm'
import { Workers } from './Workers'

export function TimeTrackingTabs({ companyId }) {
  const [tab, setTab] = useState('workers')

  const TABS = [
    { id: 'workers', label: 'Crew', icon: '👷' },
    { id: 'schedule', label: 'Schedule', icon: '📅' },
    { id: 'confirm', label: 'Confirm Day', icon: '✓' },
  ]

  return (
    <div>
      {/* Tab bar */}
      <div style={{
        display: 'flex',
        gap: 4,
        padding: '16px 20px 0',
        borderBottom: `1px solid ${TH.border}`,
      }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '10px 16px',
              borderRadius: '6px 6px 0 0',
              border: 'none',
              background: tab === t.id ? TH.card : 'transparent',
              borderBottom: tab === t.id ? `2px solid ${TH.amber}` : 'none',
              color: tab === t.id ? TH.text : TH.muted,
              fontSize: 13,
              fontWeight: tab === t.id ? 600 : 400,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {tab === 'workers' && <Workers companyId={companyId} />}
        {tab === 'schedule' && <Schedule companyId={companyId} />}
        {tab === 'confirm' && <DailyConfirm companyId={companyId} onNavigate={setTab} />}
      </div>
    </div>
  )
}
