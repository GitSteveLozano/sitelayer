import { TH } from '../lib/theme'
import { useIsMobile } from '../hooks/useIsMobile'

const NAV = [
  { id: 'dashboard', icon: '◉', label: 'Dashboard'     },
  { id: 'projects',  icon: '▤',  label: 'Projects'      },
  { id: 'time',      icon: '◷',  label: 'Time'          },
  { id: 'settings',  icon: '⚙', label: 'Settings'      },
]

export function Sidebar({ current, onChange, company, user, onSignOut }) {
  const isMobile = useIsMobile()

  if (isMobile) return <BottomNav current={current} onChange={onChange} />
  return <DesktopSidebar current={current} onChange={onChange} company={company} user={user} onSignOut={onSignOut} />
}

function DesktopSidebar({ current, onChange, company, user, onSignOut }) {
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
              {company?.name || '…'}
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
        <button onClick={onSignOut} style={{ fontSize: 12, color: TH.muted, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
          Sign out
        </button>
      </div>
    </div>
  )
}

function BottomNav({ current, onChange }) {
  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
      background: TH.card, borderTop: `1px solid ${TH.border}`,
      display: 'flex', height: 60,
      paddingBottom: 'env(safe-area-inset-bottom)',
    }}>
      {NAV.map(item => {
        const active = current === item.id
        return (
          <button
            key={item.id}
            onClick={() => onChange(item.id)}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 3,
              background: 'none', border: 'none', cursor: 'pointer',
              color: active ? TH.amber : TH.faint,
              fontFamily: 'inherit', padding: '6px 0',
              transition: 'color 0.15s',
            }}
          >
            <span style={{ fontSize: 18 }}>{item.icon}</span>
            <span style={{ fontSize: 9, fontWeight: active ? 700 : 400, letterSpacing: '0.04em' }}>
              {item.label}
            </span>
            {active && (
              <div style={{
                position: 'absolute', bottom: 0, width: 32, height: 2,
                background: TH.amber, borderRadius: 1,
              }} />
            )}
          </button>
        )
      })}
    </div>
  )
}
