import { TH } from '../lib/theme'

const NAV = [
  { id: 'dashboard', icon: '◉', label: 'Dashboard'     },
  { id: 'projects',  icon: '▤',  label: 'Projects'      },
  { id: 'time',      icon: '◷',  label: 'Time Tracking' },
  { id: 'takeoff',   icon: '📐', label: 'New Takeoff'   },
  { id: 'settings',  icon: '⚙', label: 'Settings'      },
]

export function Sidebar({ current, onChange, company, user, onSignOut }) {
  return (
    <div style={{
      width: 220, minHeight: '100vh', background: TH.card,
      borderRight: `1px solid ${TH.border}`, display: 'flex',
      flexDirection: 'column', flexShrink: 0,
    }}>
      {/* Logo */}
      <div style={{ padding: '20px 18px', borderBottom: `1px solid ${TH.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8, background: TH.amber,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, flexShrink: 0,
          }}>⬡</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: TH.text }}>SiteLayer</div>
            <div style={{ fontSize: 11, color: TH.muted, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>
              {company?.name || 'Loading...'}
            </div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '12px 10px' }}>
        {NAV.map(item => (
          <button
            key={item.id}
            onClick={() => onChange(item.id)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 10px', borderRadius: 6, marginBottom: 2,
              background: current === item.id ? TH.surf : 'transparent',
              border: 'none', cursor: 'pointer', textAlign: 'left',
              color: current === item.id ? TH.text : TH.muted,
              fontSize: 13, fontFamily: 'inherit',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            <span style={{ fontSize: 15, width: 20, textAlign: 'center' }}>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      {/* User footer */}
      <div style={{ padding: '14px 18px', borderTop: `1px solid ${TH.border}` }}>
        <div style={{ fontSize: 12, color: TH.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 8 }}>
          {user?.email}
        </div>
        <button
          onClick={onSignOut}
          style={{
            fontSize: 12, color: TH.muted, background: 'none',
            border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit',
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
