// Loading placeholder for the desktop takeoff command-center body. Extracted
// verbatim from desktop-body.tsx (behavior preserved) — a self-contained
// presentational block rendered while drafts/blueprints are still fetching.
export function EstCanvasDesktopLoading() {
  return (
    <div className="d-content-full" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--m-ink-3)',
        }}
      >
        Loading takeoff…
      </span>
    </div>
  )
}
