/**
 * Desktop v2 ("command center") primitives. Styling lives in styles/d.css
 * (.d-* classes on the shared v2 tokens). Used only by the >=1024px owner/
 * estimator desktop surface (screens/desktop/*). Mobile is untouched.
 */
import { useEffect, useState } from 'react'
import type { ComponentType, CSSProperties, ReactNode, SVGProps } from 'react'
import { NavLink } from 'react-router-dom'
import { Kpi, KpiRow } from '../m/kpi-unified.js'

type Icon = ComponentType<SVGProps<SVGSVGElement>>

// ---- Sidebar -------------------------------------------------------------
export interface DNavItem {
  to: string
  label: string
  icon: Icon
  badge?: number | undefined
  end?: boolean
}
export interface DNavSection {
  title: string
  items: DNavItem[]
}

export function DSidebar({
  sections,
  wearing,
  onWearingClick,
}: {
  sections: DNavSection[]
  wearing: string
  onWearingClick?: () => void
}) {
  return (
    <nav className="d-sidebar" aria-label="Primary">
      <div className="d-sidebar-brand">
        <span className="d-mark" aria-hidden>
          SL
        </span>
        <span className="d-wordmark">Sitelayer</span>
      </div>
      {sections.map((section) => (
        <div key={section.title}>
          <div className="d-sidebar-section">{section.title}</div>
          {section.items.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end ?? false} className="d-nav-item">
              <item.icon aria-hidden />
              {item.label}
              {item.badge ? <span className="d-nav-badge">{item.badge}</span> : null}
            </NavLink>
          ))}
        </div>
      ))}
      <button type="button" className="d-wearing" onClick={onWearingClick}>
        <div className="d-wearing-l">Wearing</div>
        <div className="d-wearing-v">
          {wearing} <span aria-hidden>▾</span>
        </div>
      </button>
    </nav>
  )
}

// ---- Topbar --------------------------------------------------------------
export function DTopbar({ crumb, actions }: { crumb: ReactNode; actions?: ReactNode }) {
  return (
    <header className="d-topbar">
      <span className="d-crumb">{crumb}</span>
      <input className="d-search" placeholder="Search projects, clients, items…" aria-label="Search" />
      <span className="d-topbar-spacer" />
      <div className="d-topbar-actions">{actions}</div>
    </header>
  )
}

// ---- Shell ---------------------------------------------------------------
export function DShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="d-shell">
      {sidebar}
      <div className="d-main">{children}</div>
    </div>
  )
}

// ---- Page head -----------------------------------------------------------
export function DEyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="d-eyebrow">
      <span className="d-eyebrow-sq" aria-hidden />
      {children}
    </span>
  )
}
export function DH1({ children }: { children: ReactNode }) {
  return <h1 className="d-h1">{children}</h1>
}

// ---- KPI strip -----------------------------------------------------------
// BACK-COMPAT ALIASES: DKpi/DKpiStrip are thin wrappers over the unified <Kpi>
// (components/m/kpi-unified.tsx) in `dense` mode. The `d-kpi-*` rendered output
// is preserved exactly; the desktop metaTone vocabulary ('good' | 'bad') is the
// type accepted here and passed straight through the unified `data-tone`.
export interface DKpiProps {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  meta?: ReactNode
  metaTone?: 'good' | 'bad' | undefined
  tone?: 'accent' | undefined
}
export function DKpiStrip({ children }: { children: ReactNode }) {
  return <KpiRow dense>{children}</KpiRow>
}
export function DKpi({ label, value, unit, meta, metaTone, tone }: DKpiProps) {
  return <Kpi dense label={label} value={value} unit={unit} meta={meta} metaTone={metaTone} tone={tone} />
}

// ---- Data table ----------------------------------------------------------
export interface DColumn<T> {
  key: string
  header: ReactNode
  numeric?: boolean
  render: (row: T) => ReactNode
}
export function DataTable<T>({
  title,
  action,
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
}: {
  title?: ReactNode
  action?: ReactNode
  columns: Array<DColumn<T>>
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  empty?: ReactNode
}) {
  return (
    <div className="d-table-wrap">
      {title ? (
        <div className="d-table-head">
          <span className="d-table-head-title">{title}</span>
          {action}
        </div>
      ) : null}
      <table className="d-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} data-num={c.numeric || undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ color: 'var(--m-ink-3)' }}>
                {empty ?? 'Nothing here yet.'}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                data-tap={onRowClick ? 'true' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} data-num={c.numeric || undefined}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

// ---- Tabs ----------------------------------------------------------------
export function DTabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: Array<{ key: string; label: string }>
  active: string
  onSelect: (key: string) => void
}) {
  return (
    <div className="d-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={t.key === active}
          className="d-tab"
          data-active={t.key === active}
          onClick={() => onSelect(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ---- Overlay surfaces: drawer · modal · command palette · menu -----------
// Steve's Desktop v2 lifecycle drawers, invoice/send modals, ⌘K palette,
// notifications panel, and anchored menus. Ported from the steve-desktop-3
// mockup (dt/--d-* → repo .d-*/--m-* tokens). All close on Escape + scrim.

function useEscapeClose(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
}

/** Right-side drawer over a dimmed backdrop (recovery / change-order / post-mortem). */
export function DDrawer({
  open,
  onClose,
  title,
  tone,
  width = 440,
  children,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  tone?: 'accent' | 'bad' | undefined
  width?: number
  children: ReactNode
}) {
  useEscapeClose(open, onClose)
  if (!open) return null
  return (
    <div className="d-scrim" onMouseDown={onClose}>
      <aside
        className="d-drawer"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Drawer'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="d-drawer-head" data-tone={tone}>
          <span className="d-drawer-title">{title}</span>
          <button type="button" className="d-drawer-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="d-drawer-body">{children}</div>
      </aside>
    </div>
  )
}

/** Centered modal over a scrim (invoice · send · new project / assignment · PDF preview). */
export function DModal({
  open,
  onClose,
  title,
  width = 560,
  footer,
  children,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  width?: number
  footer?: ReactNode
  children: ReactNode
}) {
  useEscapeClose(open, onClose)
  if (!open) return null
  return (
    <div className="d-scrim d-scrim-center" onMouseDown={onClose}>
      <div
        className="d-modal"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Dialog'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title ? <div className="d-modal-head">{title}</div> : null}
        <div className="d-modal-body">{children}</div>
        {footer ? <div className="d-modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

// ---- Command palette (⌘K) ------------------------------------------------
export interface DCommandItem {
  id: string
  label: ReactNode
  hint?: ReactNode
  onSelect: () => void
}
export interface DCommandGroup {
  label: string
  items: DCommandItem[]
}
/** Wire ⌘K / Ctrl-K to toggle the palette. Mount once in the shell. */
export function useCommandPaletteHotkey(setOpen: (fn: (v: boolean) => boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])
}
export function DCommandPalette({
  open,
  onClose,
  query,
  onQueryChange,
  groups,
  placeholder = 'Search projects, clients, items…',
}: {
  open: boolean
  onClose: () => void
  query: string
  onQueryChange: (q: string) => void
  groups: DCommandGroup[]
  placeholder?: string
}) {
  const [active, setActive] = useState(0)
  useEscapeClose(open, onClose)
  useEffect(() => {
    setActive(0)
  }, [query, open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const flat = groups.flatMap((g) => g.items)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => Math.min(i + 1, flat.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        flat[active]?.onSelect()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, groups, active])
  if (!open) return null
  let cursor = -1
  const hasResults = groups.some((g) => g.items.length > 0)
  return (
    <div className="d-scrim d-scrim-top" onMouseDown={onClose}>
      <div
        className="d-cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="d-cmdk-head">
          <span className="d-cmdk-key" aria-hidden>
            ⌘K
          </span>
          <input
            className="d-cmdk-input"
            autoFocus
            value={query}
            placeholder={placeholder}
            onChange={(e) => onQueryChange(e.target.value)}
            aria-label="Search"
          />
          <span className="d-cmdk-hint" aria-hidden>
            ↑↓ · ⏎
          </span>
        </div>
        <div className="d-cmdk-results">
          {!hasResults ? (
            <div className="d-cmdk-empty">No matches.</div>
          ) : (
            groups.map((g) =>
              g.items.length === 0 ? null : (
                <div key={g.label}>
                  <div className="d-cmdk-group">{g.label}</div>
                  {g.items.map((it) => {
                    cursor += 1
                    const i = cursor
                    return (
                      <button
                        key={it.id}
                        type="button"
                        className="d-cmdk-item"
                        data-active={i === active}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => it.onSelect()}
                      >
                        <span>{it.label}</span>
                        {it.hint ? <span className="d-cmdk-itemhint">{it.hint}</span> : null}
                      </button>
                    )
                  })}
                </div>
              ),
            )
          )}
        </div>
      </div>
    </div>
  )
}

// ---- Notifications panel -------------------------------------------------
export interface DNotifItem {
  id: string
  title: ReactNode
  meta?: ReactNode
  tone?: 'good' | 'bad' | null
  onClick?: () => void
}
export interface DNotifGroup {
  label: string
  items: DNotifItem[]
}
export function DNotifPanel({
  open,
  onClose,
  groups,
  onMarkAll,
}: {
  open: boolean
  onClose: () => void
  groups: DNotifGroup[]
  onMarkAll?: () => void
}) {
  useEscapeClose(open, onClose)
  if (!open) return null
  return (
    <div className="d-scrim" onMouseDown={onClose}>
      <aside
        className="d-drawer d-notif"
        style={{ width: 380 }}
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="d-notif-head">
          <span className="d-notif-title">Notifications</span>
          {onMarkAll ? (
            <button type="button" className="d-notif-markall" onClick={onMarkAll}>
              MARK ALL
            </button>
          ) : null}
        </div>
        {groups.map((g) => (
          <div key={g.label}>
            <div className="d-notif-group">{g.label}</div>
            {g.items.map((n) => (
              <button key={n.id} type="button" className="d-notif-item" onClick={n.onClick}>
                <span className="d-notif-bar" data-tone={n.tone ?? undefined} />
                <span className="d-notif-text">
                  <span className="d-notif-itemtitle">{n.title}</span>
                  {n.meta ? <span className="d-notif-meta">{n.meta}</span> : null}
                </span>
              </button>
            ))}
          </div>
        ))}
      </aside>
    </div>
  )
}

// ---- Anchored menu (avatar · role switcher) ------------------------------
export function DMenu({
  open,
  onClose,
  style,
  label,
  children,
}: {
  open: boolean
  onClose: () => void
  style?: CSSProperties
  label?: string
  children: ReactNode
}) {
  useEscapeClose(open, onClose)
  if (!open) return null
  return (
    <>
      <div className="d-menu-scrim" onMouseDown={onClose} />
      <div className="d-menu" style={style} role="menu" aria-label={label} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </>
  )
}

// ---- Content states: empty · error · loading -----------------------------
// BACK-COMPAT ALIASES: promoted into the shared kit (components/m/states.tsx)
// so they are no longer desktop-only. The implementations (and their
// `d-state-*` output) are unchanged; these names re-export the shared ones so
// existing `import { DEmptyState, ... } from '@/components/d'` keeps working.
export { EmptyState as DEmptyState, ErrorState as DErrorState, LoadingState as DLoadingState } from '../m/states.js'
