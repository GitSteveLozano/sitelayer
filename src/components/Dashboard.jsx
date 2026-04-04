import { TH } from '../lib/theme'
import { fmt } from '../lib/calc'
import { Card, Badge, StatusDot, Bar, Label, Btn, Spinner } from './Atoms'
import { useIsMobile } from '../hooks/useIsMobile'

export function Dashboard({ projects = [], loading, onSelectProject, onNewProject }) {
  const isMobile = useIsMobile()
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
    <div style={{ padding: isMobile ? '16px 14px' : '32px 36px', maxWidth: 1100 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 500, color: TH.text, margin: 0 }}>
            Operations Dashboard
          </h1>
          <div style={{ fontSize: 12, color: TH.muted, marginTop: 3 }}>
            {active.length} active {active.length === 1 ? 'job' : 'jobs'} · updated live
          </div>
        </div>
        <Btn onClick={onNewProject}>+ New Project</Btn>
      </div>

      {/* At-risk alert banner */}
      {atRisk.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          background: TH.redLo, border: `1px solid ${TH.red}55`,
          borderRadius: 8, padding: '12px 16px', marginBottom: 20,
        }}>
          <span style={{ fontSize: 18 }}>⚠️</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: TH.red }}>
              {atRisk.length} {atRisk.length === 1 ? 'job is' : 'jobs are'} over budget
            </div>
            <div style={{ fontSize: 12, color: TH.muted, marginTop: 2 }}>
              {atRisk.map(p => p.name).join(', ')} — actual cost/sqft exceeds bid by more than ${(p => p._metrics?.threshold || 0.50)(atRisk[0]).toFixed(2)}
            </div>
          </div>
          <button
            onClick={() => onSelectProject(atRisk[0])}
            style={{ fontSize: 12, color: TH.red, background: 'none', border: `1px solid ${TH.red}55`, borderRadius: 5, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Review →
          </button>
        </div>
      )}

      {/* KPI bar */}
      <div style={{
        display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
        gap: 10, marginBottom: 20,
      }}>
        {[
          {
            label: 'Active Jobs',
            value: active.length,
            sub:   active.length === 0 ? 'No active jobs' : `${projects.filter(p => p.status === 'bid').length} in bid`,
            color: TH.amber,
          },
          {
            label: 'Active Sqft',
            value: active.length > 0 ? fmt.sqft(totalSqft) : '—',
            sub:   active.length > 0 ? 'across all active jobs' : 'no active jobs',
            color: TH.blue,
          },
          {
            label: 'Avg Cost/Sqft',
            value: avgActPsf > 0 ? fmt.psf(avgActPsf) : '—',
            sub:   avgActPsf > 0 ? 'blended actual' : 'log time to see',
            color: TH.green,
          },
          {
            label: 'Jobs at Risk',
            value: atRisk.length,
            sub:   atRisk.length > 0 ? 'over budget threshold' : 'all jobs on track',
            color: atRisk.length > 0 ? TH.red : TH.green,
          },
        ].map(s => (
          <Card key={s.label} warn={s.label === 'Jobs at Risk' && atRisk.length > 0}>
            <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', color: TH.muted, marginBottom: 8 }}>
              {s.label}
            </div>
            <div style={{ fontSize: 28, fontWeight: 500, color: s.color, fontVariantNumeric: 'tabular-nums', lineHeight: 1, marginBottom: 4 }}>
              {s.value}
            </div>
            <div style={{ fontSize: 11, color: TH.faint }}>{s.sub}</div>
          </Card>
        ))}
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
        // ── Mobile: card list ──────────────────────────────────────────────
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {projects.map(p => {
            const m      = p._metrics || {}
            const hasData = p.status !== 'bid' && (m.actPsf || 0) > 0
            const isOver  = hasData && (m.psfVar || 0) > 0
            const isRisk  = m.isAtRisk
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
        // ── Desktop: table ────────────────────────────────────────────────
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: `1px solid ${TH.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Label style={{ margin: 0 }}>All Projects</Label>
            <span style={{ fontSize: 11, color: TH.muted }}>{projects.length} total</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 80px 90px 110px 130px 120px', padding: '8px 18px', borderBottom: `1px solid ${TH.border}` }}>
            {['Project', 'Division', 'Status', 'Sqft', 'Bid/sqft', 'Actual/sqft', 'Progress'].map(h => (
              <div key={h} style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: TH.faint, fontWeight: 600 }}>{h}</div>
            ))}
          </div>
          {projects.map(p => {
            const m       = p._metrics || {}
            const hasData = p.status !== 'bid' && (m.actPsf || 0) > 0
            const isOver  = hasData && (m.psfVar || 0) > 0
            const isRisk  = m.isAtRisk
            const isCrit  = m.riskLevel === 'critical'
            return (
              <div
                key={p.id}
                onClick={() => onSelectProject(p)}
                style={{
                  display: 'grid', gridTemplateColumns: '1fr 90px 80px 90px 110px 130px 120px',
                  padding: '12px 18px', borderBottom: `1px solid ${TH.border}`,
                  cursor: 'pointer', transition: 'background 0.15s',
                  background: isCrit ? '#ef444410' : isRisk ? TH.redLo : 'transparent',
                }}
                onMouseEnter={e => e.currentTarget.style.background = TH.surf}
                onMouseLeave={e => e.currentTarget.style.background = isCrit ? '#ef444410' : isRisk ? TH.redLo : 'transparent'}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {isRisk && <span style={{ fontSize: 10, color: TH.red }}>⚠</span>}
                    <div style={{ fontWeight: 500, fontSize: 13, color: TH.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8 }}>{p.name}</div>
                  </div>
                  <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>{p.client_name}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center' }}><Badge label={p.division} color={TH.divColors?.[p.division] || TH.amber} /></div>
                <div style={{ display: 'flex', alignItems: 'center' }}><StatusDot status={p.status} /></div>
                <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{(p.sqft || 0).toLocaleString()}</div>
                <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, color: TH.muted, fontVariantNumeric: 'tabular-nums' }}>{fmt.psf(p.bid_psf)}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: hasData ? 600 : 400, color: hasData ? (isOver ? TH.red : TH.green) : TH.muted, fontVariantNumeric: 'tabular-nums' }}>
                  {hasData ? <>{fmt.psf(m.actPsf)}{isOver && <span style={{ fontSize: 10, color: TH.red }}>+{fmt.psf(m.psfVar)}</span>}</> : '—'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', paddingRight: 8 }}>
                  {p.status !== 'bid' ? (
                    <div style={{ width: '100%' }}>
                      <Bar value={m.pctComplete || 0} color={isRisk ? TH.red : m.pctComplete > 0.8 ? TH.green : TH.amber} h={4} />
                      <div style={{ fontSize: 10, color: TH.faint, marginTop: 3 }}>{fmt.pct(m.pctComplete || 0)}</div>
                    </div>
                  ) : <span style={{ fontSize: 11, color: TH.faint }}>Awaiting award</span>}
                </div>
              </div>
            )
          })}
        </Card>
      )}
    </div>
  )
}
