// Floating-palette shared chrome + field styling for the desktop takeoff
// command-center body. Extracted verbatim from desktop-body.tsx (behavior
// preserved) — these are pure presentational helpers with no component state.

// Floating-palette shared chrome (translated from template .dt-float / .dt-float-head).
export const floatBox = (extra: React.CSSProperties): React.CSSProperties => ({
  position: 'absolute',
  background: 'var(--m-sand)',
  border: '2px solid var(--m-ink)',
  boxShadow: '6px 6px 0 var(--m-ink)',
  ...extra,
})

export const floatHead: React.CSSProperties = {
  padding: '10px 14px',
  borderBottom: '2px solid var(--m-ink)',
  background: 'var(--m-ink)',
  color: 'var(--m-accent)',
  fontFamily: 'var(--m-num)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
}

// Shared field + action styling for the copy/array/mirror panel (H6).
export const copyInputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 4,
  padding: '6px 8px',
  border: '2px solid var(--m-ink)',
  background: 'var(--m-card)',
  fontFamily: 'var(--m-num)',
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--m-ink)',
}

// `copyBusy` was a closure over the parent's copy-in-flight state in the
// original inline helper; threaded as an explicit arg so the style stays pure.
export const copyActionStyle = (danger: boolean, copyBusy: boolean): React.CSSProperties => ({
  flex: 1,
  padding: '10px 8px',
  border: '2px solid var(--m-ink)',
  background: 'var(--m-accent)',
  color: danger ? 'var(--m-red)' : 'var(--m-accent-ink)',
  fontFamily: 'var(--m-num)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  cursor: copyBusy ? 'not-allowed' : 'pointer',
  opacity: copyBusy ? 0.6 : 1,
})
