import { useState } from 'react'
import { TH } from '../lib/theme'
import { fmt } from '../lib/calc'
import { Card, Badge, StatusDot, Bar, Label, Btn, Spinner } from './Atoms'
import { Documents } from './Documents'
import { useProject } from '../hooks/useProjects'
import { projects } from '../lib/db'

const TABS = [
  { id: 'overview',   label: 'Overview'    },
  { id: 'documents',  label: 'Documents'   },
]

export function ProjectDetail({ projectId, onBack }) {
  const { project: p, entries, loading, refresh } = useProject(projectId)
  const [tab, setTab] = useState('overview')

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400 }}>
        <Spinner />
      </div>
    )
  }

  if (!p) return (
    <div style={{ padding: 32, color: TH.muted }}>Project not found.</div>
  )

  const m     = p._metrics || {}
  const hasD  = entries.length > 0 && m.actPsf > 0
  const isOvr = hasD && (m.psfVar || 0) > 0

  async function updateStatus(status) {
    await projects.update(p.id, { status })
    refresh()
  }

  return (
    <div style={{ padding: '32px 36px', maxWidth: 980 }}>
      <button onClick={onBack} style={{ fontSize: 13, color: TH.muted, cursor: 'pointer', marginBottom: 20, background: 'none', border: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>
        ← All Projects
      </button>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <Badge label={p.division} color={TH.divColors?.[p.division] || TH.amber} />
            <StatusDot status={p.status} />
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 500, color: TH.text, margin: 0 }}>{p.name}</h1>
          <div style={{ fontSize: 12, color: TH.muted, marginTop: 3 }}>{p.client_name}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: TH.muted, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Bid Total</div>
          <div style={{ fontSize: 26, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{fmt.money(m.bidTotal || 0)}</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 20, borderBottom: `1px solid ${TH.border}` }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '8px 16px', fontSize: 13, fontFamily: 'inherit',
              background: 'none', border: 'none', cursor: 'pointer',
              color: tab === t.id ? TH.amber : TH.muted,
              borderBottom: `2px solid ${tab === t.id ? TH.amber : 'transparent'}`,
              marginBottom: -1, transition: 'color 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Overview Tab ── */}
      {tab === 'overview' && (
        <>
          {/* PSF Hero */}
          {hasD ? (
            <Card warn={m.isAtRisk} style={{ marginBottom: 14 }}>
              <Label>Cost per square foot — bid vs actual</Label>
              <div style={{ display: 'flex', gap: 40, marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 11, color: TH.muted, marginBottom: 4 }}>Bid</div>
                  <div style={{ fontSize: 36, fontWeight: 500, color: TH.muted, fontVariantNumeric: 'tabular-nums' }}>
                    {fmt.psf(p.bid_psf)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: TH.muted, marginBottom: 4 }}>Actual</div>
                  <div style={{ fontSize: 36, fontWeight: 500, color: isOvr ? TH.red : TH.green, fontVariantNumeric: 'tabular-nums' }}>
                    {fmt.psf(m.actPsf)}
                  </div>
                </div>
                {m.psfVar !== null && (
                  <div>
                    <div style={{ fontSize: 11, color: TH.muted, marginBottom: 4 }}>Variance</div>
                    <div style={{ fontSize: 36, fontWeight: 500, color: isOvr ? TH.red : TH.green, fontVariantNumeric: 'tabular-nums' }}>
                      {isOvr ? '+' : ''}{fmt.psf(m.psfVar)}
                    </div>
                  </div>
                )}
              </div>
              <Bar value={m.pctComplete || 0} color={m.isAtRisk ? TH.red : TH.amber} h={5} />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, fontSize: 11, color: TH.muted }}>
                <span>{fmt.pct(m.pctComplete || 0)} complete</span>
                <span>{fmt.sqft(p.sqft)}</span>
              </div>
            </Card>
          ) : (
            <Card style={{ marginBottom: 14, padding: '20px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 20 }}>⏳</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: TH.text, marginBottom: 2 }}>No time entries yet</div>
                  <div style={{ fontSize: 12, color: TH.muted }}>
                    Log crew hours in Time Tracking to see live cost performance.
                    {!p.sqft && ' Also upload a PlanSwift CSV to set the project sqft.'}
                  </div>
                </div>
              </div>
            </Card>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {/* Labor by item */}
            <Card>
              <Label>Labor by Scope Item</Label>
              {!m.byItem?.length ? (
                <div style={{ fontSize: 13, color: TH.muted }}>No time entries yet</div>
              ) : (
                m.byItem.map(row => (
                  <div key={row.item} style={{ paddingBottom: 10, marginBottom: 10, borderBottom: `1px solid ${TH.border}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{row.item}</span>
                      <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{fmt.money(row.hours * (p.labor_rate || 38))}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: TH.muted }}>
                      <span>{fmt.hrs(row.hours)} · {fmt.sqft(row.sqft_done)}</span>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.rate.toFixed(2)} sqft/hr</span>
                    </div>
                  </div>
                ))
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 4 }}>
                <span style={{ fontSize: 12, color: TH.muted, fontWeight: 500 }}>Total Labor</span>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{fmt.money(m.laborCost || 0)}</span>
              </div>
            </Card>

            {/* Right col */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Margin */}
              <Card>
                <Label>Job Margin</Label>
                {[
                  { label: 'Bid Revenue',  value: m.bidTotal || 0,                             color: TH.text  },
                  { label: 'Total Cost',   value: m.totalCost || 0,                            color: TH.text  },
                  { label: 'Gross Profit', value: (m.bidTotal || 0) - (m.totalCost || 0),      color: ((m.bidTotal || 0) > (m.totalCost || 0)) ? TH.green : TH.red },
                ].map(row => (
                  <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, color: TH.muted }}>{row.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 500, color: row.color, fontVariantNumeric: 'tabular-nums' }}>{fmt.money(row.value)}</span>
                  </div>
                ))}
                {m.margin !== null && (
                  <div style={{ borderTop: `1px solid ${TH.border}`, paddingTop: 10, marginTop: 4, display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, color: TH.muted }}>Margin</span>
                    <span style={{ fontSize: 22, fontWeight: 600, color: (m.margin || 0) > 0 ? TH.green : TH.red }}>
                      {fmt.pct(m.margin)}
                    </span>
                  </div>
                )}
              </Card>

              {/* Bonus tracker */}
              {(p.target_sqft_per_hr || 0) > 0 && (
                <Card>
                  <Label>Crew Performance</Label>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
                    {[
                      { label: 'Target',      value: `${(p.target_sqft_per_hr || 0).toFixed(2)}`, sub: 'sqft/hr', color: TH.muted  },
                      { label: 'Actual',      value: `${(m.avgSqftHr || 0).toFixed(2)}`,          sub: 'sqft/hr', color: (m.avgSqftHr || 0) >= (p.target_sqft_per_hr || 0) ? TH.green : TH.amber },
                      { label: 'Eligibility', value: fmt.pct(m.bonusFactor || 0),                 sub: '',        color: (m.bonusFactor || 0) >= 0.8 ? TH.green : (m.bonusFactor || 0) >= 0.5 ? TH.amber : TH.red },
                    ].map(s => (
                      <div key={s.label} style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 10, textTransform: 'uppercase', color: TH.muted, marginBottom: 3 }}>{s.label}</div>
                        <div style={{ fontSize: 22, fontWeight: 500, color: s.color }}>{s.value}</div>
                        {s.sub && <div style={{ fontSize: 10, color: TH.muted }}>{s.sub}</div>}
                      </div>
                    ))}
                  </div>
                  <Bar value={m.bonusFactor || 0} color={(m.bonusFactor || 0) >= 0.8 ? TH.green : (m.bonusFactor || 0) >= 0.5 ? TH.amber : TH.red} h={5} />
                  <div style={{ fontSize: 11, color: TH.muted, marginTop: 7 }}>
                    Bonus pool: {fmt.money(m.bonusAmt || 0)} / {fmt.money(p.bonus_pool || 0)}
                  </div>
                </Card>
              )}

              {/* Job info */}
              <Card>
                <Label>Job Info</Label>
                {[
                  ['Total Sqft',   fmt.sqft(p.sqft)],
                  ['Division',     p.division],
                  ['Status',       p.status],
                  ['Labor Rate',   `$${p.labor_rate || 38}/hr`],
                  ['Created',      new Date(p.created_at).toLocaleDateString()],
                ].map(([label, val]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
                    <span style={{ fontSize: 12, color: TH.muted }}>{label}</span>
                    <span style={{ fontSize: 12 }}>{val}</span>
                  </div>
                ))}
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  {p.status === 'bid' && (
                    <Btn onClick={() => updateStatus('active')} style={{ flex: 1, background: TH.green, color: '#000', fontSize: 12 }}>
                      Mark Active
                    </Btn>
                  )}
                  {p.status === 'active' && (
                    <Btn onClick={() => updateStatus('complete')} style={{ flex: 1, background: TH.blue, color: '#fff', fontSize: 12 }}>
                      Mark Complete
                    </Btn>
                  )}
                </div>
              </Card>
            </div>
          </div>
        </>
      )}

      {/* ── Documents Tab ── */}
      {tab === 'documents' && (
        <Documents project={p} onUpdated={refresh} />
      )}
    </div>
  )
}
