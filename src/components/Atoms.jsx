import { TH } from '../lib/theme'

export function Card({ children, style, warn, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: TH.card,
        border: `1px solid ${warn ? TH.red + '55' : TH.border}`,
        borderRadius: 8,
        padding: '18px 20px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color 0.15s',
        ...style,
      }}
    >{children}</div>
  )
}

export function Badge({ label, color }) {
  const c = color || TH.amber
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
      textTransform: 'uppercase', background: c + '22', color: c,
    }}>{label}</span>
  )
}

export function StatusDot({ status }) {
  const map = {
    active:   { color: TH.green,  label: 'Active'    },
    complete: { color: TH.blue,   label: 'Complete'  },
    bid:      { color: TH.amber,  label: 'Bid'       },
    paused:   { color: TH.muted,  label: 'Paused'    },
  }
  const { color, label } = map[status] || map.active
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      {label}
    </span>
  )
}

export function Bar({ value = 0, color, h = 4 }) {
  return (
    <div style={{ height: h, borderRadius: 2, background: TH.border, overflow: 'hidden' }}>
      <div style={{
        height: '100%',
        width: `${Math.min(100, Math.max(0, value * 100))}%`,
        background: color || TH.amber,
        borderRadius: 2,
        transition: 'width 0.4s ease',
      }} />
    </div>
  )
}

export function Label({ children, style }) {
  return (
    <div style={{
      fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em',
      color: TH.muted, fontWeight: 600, marginBottom: 10,
      ...style,
    }}>{children}</div>
  )
}

export function Btn({ children, onClick, variant = 'primary', disabled, style, type = 'button' }) {
  const styles = {
    primary: { background: TH.amber,  color: '#000', border: 'none' },
    ghost:   { background: 'transparent', color: TH.muted, border: `1px solid ${TH.border}` },
    danger:  { background: TH.red,    color: '#fff', border: 'none' },
  }
  const s = disabled
    ? { background: TH.faint, color: TH.muted, border: 'none' }
    : styles[variant]

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '10px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'opacity 0.15s', fontFamily: 'inherit',
        ...s, ...style,
      }}
    >{children}</button>
  )
}

export function Input({ label, error, ...props }) {
  return (
    <div>
      {label && <Label>{label}</Label>}
      <input
        {...props}
        style={{
          width: '100%', background: TH.surf, border: `1px solid ${error ? TH.red : TH.border}`,
          borderRadius: 6, padding: '10px 12px', color: TH.text, fontSize: 13,
          fontFamily: 'inherit', boxSizing: 'border-box', outline: 'none',
          ...props.style,
        }}
      />
      {error && <div style={{ fontSize: 11, color: TH.red, marginTop: 4 }}>{error}</div>}
    </div>
  )
}

export function Select({ label, options = [], ...props }) {
  return (
    <div>
      {label && <Label>{label}</Label>}
      <select
        {...props}
        style={{
          width: '100%', background: TH.surf, border: `1px solid ${TH.border}`,
          borderRadius: 6, padding: '10px 12px', color: TH.text, fontSize: 13,
          fontFamily: 'inherit', boxSizing: 'border-box',
          ...props.style,
        }}
      >
        {options.map(o => (
          <option key={o.value ?? o} value={o.value ?? o}>
            {o.label ?? o}
          </option>
        ))}
      </select>
    </div>
  )
}

export function Spinner() {
  return (
    <div style={{
      width: 20, height: 20, border: `2px solid ${TH.border}`,
      borderTopColor: TH.amber, borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
      display: 'inline-block',
    }} />
  )
}
