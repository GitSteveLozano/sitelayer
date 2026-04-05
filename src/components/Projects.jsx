import { TH } from '../lib/theme'
import { fmt } from '../lib/calc'
import { Card, Badge, StatusDot, Bar, Label, Btn, Spinner } from './Atoms'
import { useIsMobile } from '../hooks/useIsMobile'

export function Projects({ projects = [], loading, onSelectProject, onNewProject }) {
  const isMobile = useIsMobile()

  if (loading) {
    return (
      <div style={{ padding: isMobile ? '40px 20px' : '60px', textAlign: 'center', color: TH.muted }}>
        <Spinner />
        <div style={{ marginTop: 12, fontSize: 13 }}>Loading projects…</div>
      </div>
    )
  }

  return (
    <div style={{ padding: isMobile ? '16px 14px' : '32px 36px', maxWidth: 1100 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 600, color: TH.text }}>Projects</h1>
          <div style={{ fontSize: 13, color: TH.muted }}>
            {projects.length} {projects.length === 1 ? 'project' : 'projects'}
          </div>
        </div>
        <Btn onClick={onNewProject}>+ New Project</Btn>
      </div>

      {/* Project list */}
      {projects.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: 48 }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📋</div>
          <div style={{ fontSize: 16, fontWeight: 500, color: TH.text, marginBottom: 8 }}>No projects yet</div>
          <div style={{ fontSize: 14, color: TH.muted, marginBottom: 24 }}>
            Create your first project to start tracking job performance.
          </div>
          <Btn onClick={onNewProject}>+ New Project</Btn>
        </Card>
      ) : isMobile ? (
        // Mobile card list
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {projects.map(p => {
            const m = p._metrics || {}
            const hasData = p.status !== 'bid' && (m.actPsf || 0) > 0
            const isOver = hasData && (m.psfVar || 0) > 0
            const isRisk = m.isAtRisk
            return (
              <Card
                key={p.id}
                onClick={() => onSelectProject(p)}
                warn={isRisk}
                style={{ padding: '14px 16px', cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                      {isRisk && <span style={{ fontSize: 11, color: TH.red }}>⚠</span>}
                      <div style={{ fontSize: 14, fontWeight: 600, color: TH.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.name}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: TH.muted }}>{p.client_name}</div>
                  </div>
                  <StatusDot status={p.status} />
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                  <Badge label={p.division} color={TH.divColors?.[p.division] || TH.amber} />
                  <span style={{ fontSize: 11, color: TH.muted, alignSelf: 'center' }}>
                    {(p.sqft || 0).toLocaleString()} sqft
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}>
                  <span style={{ color: TH.muted }}>Bid: <span style={{ color: TH.text }}>{fmt.psf(p.bid_psf)}</span></span>
                  {hasData && (
                    <span style={{ color: isOver ? TH.red : TH.green, fontWeight: 600 }}>
                      Actual: {fmt.psf(m.actPsf)}
                      {isOver && <span style={{ fontSize: 10 }}> +{fmt.psf(m.psfVar)}</span>}
                    </span>
                  )}
                </div>
                {p.status !== 'bid' && (
                  <>
                    <Bar value={m.pctComplete || 0} color={isRisk ? TH.red : TH.amber} h={4} />
                    <div style={{ fontSize: 10, color: TH.faint, marginTop: 4 }}>
                      {fmt.pct(m.pctComplete || 0)} complete
                    </div>
                  </>
                )}
              </Card>
            )
          })}
        </div>
      ) : (
        // Desktop table
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 80px 90px 110px 130px 120px', padding: '10px 18px', borderBottom: `1px solid ${TH.border}`, background: TH.surf }}>
            {['Project', 'Division', 'Status', 'Sqft', 'Bid/sqft', 'Actual/sqft', 'Progress'].map(h => (
              <div key={h} style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: TH.faint, fontWeight: 600 }}>
                {h}
              </div>
            ))}
          </div>
          {projects.map(p => {
            const m = p._metrics || {}
            const hasData = p.status !== 'bid' && (m.actPsf || 0) > 0
            const isOver = hasData && (m.psfVar || 0) > 0
            const isRisk = m.isAtRisk
            const isCrit = m.riskLevel === 'critical'
            return (
              <div
                key={p.id}
                onClick={() => onSelectProject(p)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 90px 80px 90px 110px 130px 120px',
                  padding: '12px 18px',
                  borderBottom: `1px solid ${TH.border}`,
                  cursor: 'pointer',
                  transition: 'background 0.15s',
                  background: isCrit ? '#ef444410' : isRisk ? TH.redLo : 'transparent',
                }}
                onMouseEnter={e => e.currentTarget.style.background = TH.surf}
                onMouseLeave={e => e.currentTarget.style.background = isCrit ? '#ef444410' : isRisk ? TH.redLo : 'transparent'}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {isRisk && <span style={{ fontSize: 10, color: TH.red }}>⚠</span>}
                    <div style={{ fontWeight: 500, fontSize: 13, color: TH.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8 }}>
                      {p.name}
                    </div>
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: hasData ? 600 : 400, color: hasData ? (isOver ? TH.red : TH.green) : TH.muted, fontVariantNumeric: 'tabular-nums' }}>
                  {hasData ? (
                    <>
                      {fmt.psf(m.actPsf)}
                      {isOver && (
                        <span style={{ fontSize: 10, color: TH.red }}>
                          +{fmt.psf(m.psfVar)}
                        </span>
                      )}
                    </>
                  ) : '—'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', paddingRight: 8 }}>
                  {p.status !== 'bid' ? (
                    <div style={{ width: '100%' }}>
                      <Bar
                        value={m.pctComplete || 0}
                        color={isRisk ? TH.red : m.pctComplete > 0.8 ? TH.green : TH.amber}
                        h={4}
                      />
                      <div style={{ fontSize: 10, color: TH.faint, marginTop: 3 }}>
                        {fmt.pct(m.pctComplete || 0)}
                      </div>
                    </div>
                  ) : (
                    <span style={{ fontSize: 11, color: TH.faint }}>Awaiting award</span>
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
