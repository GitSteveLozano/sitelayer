/**
 * Desktop v2 ("command center") primitives. Styling lives in styles/d.css
 * (.d-* classes on the shared v2 tokens). Used only by the >=1024px owner/
 * estimator desktop surface (screens/desktop/*). Mobile is untouched.
 */
import type { ComponentType, ReactNode, SVGProps } from 'react'
import { NavLink } from 'react-router-dom'

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
export interface DKpiProps {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  meta?: ReactNode
  metaTone?: 'good' | 'bad' | undefined
  tone?: 'accent' | undefined
}
export function DKpiStrip({ children }: { children: ReactNode }) {
  return <div className="d-kpi-strip">{children}</div>
}
export function DKpi({ label, value, unit, meta, metaTone, tone }: DKpiProps) {
  return (
    <div className="d-kpi" data-tone={tone}>
      <div className="d-kpi-l">{label}</div>
      <div className="d-kpi-v num">
        {value}
        {unit ? <span className="d-kpi-unit">{unit}</span> : null}
      </div>
      {meta ? (
        <div className="d-kpi-meta" data-tone={metaTone}>
          {meta}
        </div>
      ) : null}
    </div>
  )
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
