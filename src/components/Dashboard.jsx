import { TH } from '../lib/theme'
import { fmt } from '../lib/calc'
import { Card, Badge, StatusDot, Bar, Label, Btn, Spinner } from './Atoms'

export function Dashboard({ projects = [], loading, onSelectProject, onNewTakeoff }) {
  const active    = projects.filter(p => p.status === 'active')
  const atRisk    = active.filter(p => p._metrics?.isAtRisk)
  const totalSqft = active.reduce((s, p) => s + (p.sqft || 0), 0)

  const avgActPsf = (() => {
    const withData = active.filter(p => (p._metrics?.actPsf || 0) > 0)
    if (!withData.length) return 0
    return withData.reduce((s, p) => s + p._metrics.actPsf, 0) / withData.length
  })()

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400 }}>
        <Spinner />
      </div>
    )
  }

  return (
    <div style={{ padding: '32px 36px', maxWidth: 1100 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 500, color: TH.text, margin: 0 }}>
            Operations Dashboard
          </h1>
          <div style={{ fontSize: 12, color: TH.muted, marginTop: 3 }}>
            {active.length} active jobs · updated live
          </div>
        </div>
        <Btn onClick={onNewTakeoff}>+ New Takeoff</Btn>
      </div>

      {/* KPI bar */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 10, marginBottom: 24,
      }}>
        {[
          { label: 'Active Jobs',     value: active.length,                    color: TH.amber },
          { label: 'Active Sqft',     value: fmt.sqft(totalSqft),              color: TH.blue  },
          { label: 'Avg Cost/Sqft',   value: fmt.psf(avgActPsf),              color: TH.green },
          { label: 'Jobs at Risk',    value: atRisk.length,                    color: atRisk.length > 0 ? TH.red : TH.green },
        ].map(s => (
          <Card key={s.label} warn={s.label === 'Jobs at Risk' && atRisk.length > 0}>
            <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', color: TH.muted, marginBottom: 8 }}>
              {s.label}
            </div>
            <div style={{ fontSize: 28, fontWeight: 500, color: s.color, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
              {s.value}
            </div>
          </Card>
        ))}
      </div>

      {/* Project table */}
      {projects.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: 48 }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📋</div>
          <div style={{ fontSize: 16, fontWeight: 500, color: TH.text, marginBottom: 8 }}>No projects yet</div>
          <div style={{ fontSize: 14, color: TH.muted, marginBottom: 24 }}>
            Create your first project to start tracking job performance.
          </div>
          <Btn onClick={onNewTakeoff}>+ New Takeoff</Btn>
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: `1px solid ${TH.border}`, display: 'flex', justifyContent: 'space-between' }}>
            <Label style={{ margin: 0 }}>All Projects</Label>
            <span style={{ fontSize: 11, color: TH.muted }}>{projects.length} jobs</span>
          </div>

          {/* Col headers */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 90px 80px 90px 110px 120px 100px',
            padding: '8px 18px', borderBottom: `1px solid ${TH.border}`,
          }}>
            {['Job', 'Division', 'Status', 'Sqft', 'Bid/sqft', 'Actual/sqft', 'Progress'].map(h => (
              <div key={h} style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: TH.faint, fontWeight: 600 }}>
                {h}
              </div>
            ))}
          </div>

          {/* Rows */}
          {projects.map(p => {
            const m       = p._metrics || {}
            const hasData = p.status !== 'bid' && (m.actPsf || 0) > 0
            const isOver  = hasData && (m.psfVar || 0) > 0
            const isRisk  = m.isAtRisk

            return (
              <div
                key={p.id}
                onClick={() => onSelectProject(p)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 90px 80px 90px 110px 120px 100px',
                  padding: '12px 18px', borderBottom: `1px solid ${TH.border}`,
                  cursor: 'pointer', transition: 'background 0.15s',
                  background: isRisk ? TH.redLo : 'transparent',
                }}
                onMouseEnter={e => e.currentTarget.style.background = TH.surf}
                onMouseLeave={e => e.currentTarget.style.background = isRisk ? TH.redLo : 'transparent'}
              >
                <div>
                  <div style={{ fontWeight: 500, fontSize: 13, color: TH.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8 }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>{p.client_name}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <Badge label={p.division} color={TH.divColors?.[p.division] || TH.amber} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <StatusDot status={p.status} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                  {(p.sqft || 0).toLocaleString()}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, color: TH.muted, fontVariantNumeric: 'tabular-nums' }}>
                  {fmt.psf(p.bid_psf)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: hasData ? 600 : 400, color: hasData ? (isOver ? TH.red : TH.green) : TH.muted, fontVariantNumeric: 'tabular-nums' }}>
                  {hasData ? fmt.psf(m.actPsf) : '—'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', paddingRight: 8 }}>
                  {p.status !== 'bid' && (
                    <Bar value={m.pctComplete || 0} color={isRisk ? TH.red : TH.amber} h={4} />
                  )}
                </div>
              </div>
            )
          })}
        </Card>
      )}
    </div>
  )
}
