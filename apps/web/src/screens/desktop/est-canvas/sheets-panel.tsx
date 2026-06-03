import { type BlueprintPage } from '@/lib/api'
import { type CanvasMode } from './types'
import { floatBox, floatHead } from './desktop-body-styles'

// Floating SHEETS panel (bottom-right) — extracted verbatim from desktop-body.tsx
// (behavior preserved). Quick sheet/page switcher mirroring the design's
// "SHEETS · 22" panel (dsg__06). In SCALE mode it becomes the "SHEETS · SCALE"
// status panel (dsg__46), surfacing each page's calibration state.
export function SheetsPanel({
  pages,
  activePage,
  mode,
  setPageId,
}: {
  pages: BlueprintPage[]
  activePage: BlueprintPage | null
  mode: CanvasMode
  setPageId: (id: string) => void
}) {
  // Per-page calibration status. A page is VERIFIED once it carries a saved
  // calibration; the page actively being calibrated reads SETTING; the rest UNCAL.
  const pageScaleStatus = (p: BlueprintPage): { label: string; tone: 'green' | 'amber' | 'ink' } => {
    if (mode === 'scale' && p.id === activePage?.id) return { label: 'SETTING…', tone: 'amber' }
    return p.calibration_set_at ? { label: '✓ VERIFIED', tone: 'green' } : { label: 'UNCAL', tone: 'ink' }
  }

  return (
    <div style={floatBox({ bottom: 110, right: 16, width: 200, maxHeight: 240, overflow: 'auto' })}>
      <div style={floatHead}>Sheets · {mode === 'scale' ? 'Scale' : pages.length}</div>
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {pages.map((p) => {
          const isActive = p.id === activePage?.id
          const st = pageScaleStatus(p)
          const statusColor =
            st.tone === 'green' ? 'var(--m-green)' : st.tone === 'amber' ? 'var(--m-amber)' : 'var(--m-ink-3)'
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setPageId(p.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '6px 10px',
                border: '2px solid var(--m-ink)',
                background: isActive ? 'var(--m-accent)' : 'var(--m-card)',
                color: isActive ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.04em',
                cursor: 'pointer',
              }}
            >
              <span>{`pg ${p.page_number}`}</span>
              {mode === 'scale' ? (
                <span style={{ fontSize: 9, color: isActive ? 'var(--m-accent-ink)' : statusColor }}>{st.label}</span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
