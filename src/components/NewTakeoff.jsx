import { useState } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Input, Select, Btn } from './Atoms'
import { projects } from '../lib/db'
import { fmt } from '../lib/calc'
import { SCOPE_ITEMS } from './BlueprintCanvas'
import { useIsMobile } from '../hooks/useIsMobile'

// L&A's 9 divisions — matches QBO class structure
export const DIVISIONS = [
  'D1-Stucco',
  'D2-Masonry',
  'D3-Siding',
  'D4-EIFS',
  'D5-Paper & Wire',
  'D6-Snow Removal',
  'D7-Warranty',
  'D8-Overhead',
  'D9-Scaffolding',
]

const BLUEPRINT_CHECKS = [
  {
    key:   'scale',
    title: 'Scale verified against floor plan dimensions',
    desc:  'Cross-reference the blueprint scale bar against explicit dimensions. Do not rely on the scale bar alone.',
  },
  {
    key:   'elevation',
    title: 'Building height confirmed from elevation drawings',
    desc:  'Confirm building height using the elevation view. Mismatched scale = wrong sqft.',
  },
  {
    key:   'wallType',
    title: 'Wall types confirmed for all scopes',
    desc:  'Different wall assemblies change material quantities significantly.',
  },
]

export function NewTakeoff({ companyId, onBack, onCreated }) {
  const isMobile = useIsMobile()
  const [step,     setStep]     = useState(1)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState(null)

  // Step 1 fields
  const [name,       setName]       = useState('')
  const [client,     setClient]     = useState('')
  const [division,   setDivision]   = useState('D4-EIFS')
  const [bidPsf,     setBidPsf]     = useState('')
  const [laborRate,  setLaborRate]  = useState('38')
  const [targetSqHr, setTargetSqHr] = useState('')
  const [bonusPool,  setBonusPool]  = useState('')

  // Step 2
  const [checks, setChecks] = useState({ scale: false, elevation: false, wallType: false })

  // Step 3
  const [sqfts, setSqfts] = useState(
    Object.fromEntries(SCOPE_ITEMS.map(s => [s.id, '']))
  )

  const totalSqft   = Object.values(sqfts).reduce((s, v) => s + (parseFloat(v) || 0), 0)
  const allChecked  = Object.values(checks).every(Boolean)
  const canStep1    = name.trim() && bidPsf && parseFloat(bidPsf) > 0

  async function handleCreate() {
    setSaving(true)
    setError(null)
    const { data, error: err } = await projects.create({
      company_id:          companyId,
      name:                name.trim(),
      client_name:         client.trim(),
      division,
      status:              'bid',
      sqft:                totalSqft,
      bid_psf:             parseFloat(bidPsf),
      labor_rate:          parseFloat(laborRate) || 38,
      target_sqft_per_hr:  parseFloat(targetSqHr) || null,
      bonus_pool:          parseFloat(bonusPool) || 0,
      risk_threshold:      0.50,
      material_cost:       0,
      sub_cost:            0,
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    onCreated?.(data)
    onBack()
  }

  return (
    <div style={{ padding: isMobile ? '16px 14px' : '32px 36px', maxWidth: 640 }}>
      <button onClick={onBack} style={{ fontSize: 13, color: TH.muted, cursor: 'pointer', marginBottom: 20, background: 'none', border: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>
        ← Dashboard
      </button>
      <h1 style={{ fontSize: 22, fontWeight: 500, color: TH.text, margin: 0, marginBottom: 4 }}>New Project</h1>
      <div style={{ fontSize: 13, color: TH.muted, marginBottom: 28 }}>Enter project details and scope measurements</div>

      {/* Step bar */}
      <StepBar current={step} />

      <Card>
        {/* ── Step 1: Project Details ── */}
        {step === 1 && (
          <div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
              <Input label="Project Name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Riverdale Condos — Phase 1" />
              <Input label="Client Name" value={client} onChange={e => setClient(e.target.value)} placeholder="e.g. Riverdale Properties" />
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
                <Select label="Division" value={division} onChange={e => setDivision(e.target.value)} options={DIVISIONS} />
                <Input label="Bid $/sqft" value={bidPsf} onChange={e => setBidPsf(e.target.value)} type="number" placeholder="13.50" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : '1fr 1fr 1fr', gap: 12 }}>
                <Input label="Labor Rate ($/hr)" value={laborRate} onChange={e => setLaborRate(e.target.value)} type="number" placeholder="38" />
                <Input label="Target sqft/hr" value={targetSqHr} onChange={e => setTargetSqHr(e.target.value)} type="number" placeholder="4.73" />
                <Input label="Bonus Pool ($)" value={bonusPool} onChange={e => setBonusPool(e.target.value)} type="number" placeholder="5000" />
              </div>
            </div>
            <Btn disabled={!canStep1} onClick={() => setStep(2)} style={{ width: '100%' }}>
              Continue →
            </Btn>
          </div>
        )}

        {/* ── Step 2: Blueprint verification ── */}
        {step === 2 && (
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 16, color: TH.amber }}>⚠</span>
              <div style={{ fontSize: 15, fontWeight: 500, color: TH.amber }}>Blueprint check — required</div>
            </div>
            <div style={{ fontSize: 13, color: TH.muted, marginBottom: 20, lineHeight: 1.7 }}>
              Confirm all three before entering measurements. A wrong scale means every number below is wrong.
            </div>
            {BLUEPRINT_CHECKS.map(c => (
              <div
                key={c.key}
                onClick={() => setChecks(prev => ({ ...prev, [c.key]: !prev[c.key] }))}
                style={{
                  display: 'flex', gap: 12, padding: '13px 14px', marginBottom: 8, borderRadius: 6,
                  border: `1px solid ${checks[c.key] ? TH.green : TH.border}`,
                  background: checks[c.key] ? TH.greenLo : TH.surf,
                  cursor: 'pointer', transition: 'all 0.15s',
                }}
              >
                <div style={{
                  width: 18, height: 18, borderRadius: 3, flexShrink: 0, marginTop: 1,
                  border: `2px solid ${checks[c.key] ? TH.green : TH.faint}`,
                  background: checks[c.key] ? TH.green : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, color: '#000',
                }}>
                  {checks[c.key] ? '✓' : ''}
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: checks[c.key] ? TH.text : TH.muted, marginBottom: 3 }}>{c.title}</div>
                  <div style={{ fontSize: 12, color: TH.muted, lineHeight: 1.6 }}>{c.desc}</div>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <Btn variant="ghost" onClick={() => setStep(1)} style={{ flex: 1 }}>← Back</Btn>
              <Btn disabled={!allChecked} onClick={() => setStep(3)} style={{ flex: 2 }}>
                {allChecked ? 'Confirmed — Continue →' : `${Object.values(checks).filter(Boolean).length}/3 confirmed`}
              </Btn>
            </div>
          </div>
        )}

        {/* ── Step 3: Scope measurements ── */}
        {step === 3 && (
          <div>
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Scope measurements</div>
            <div style={{ fontSize: 13, color: TH.muted, marginBottom: 18 }}>
              Enter measured sqft for each scope item from your blueprints.
            </div>
            {SCOPE_ITEMS.map(scope => (
              <div key={scope.id} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 1 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: scope.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{scope.id}</span>
                  <span style={{ fontSize: 10, color: TH.faint }}>{scope.div}</span>
                </div>
                <input
                  type="number"
                  value={sqfts[scope.id]}
                  onChange={e => setSqfts(s => ({ ...s, [scope.id]: e.target.value }))}
                  placeholder="0"
                  style={{
                    width: 90, background: TH.surf, border: `1px solid ${sqfts[scope.id] ? TH.amber + '66' : TH.border}`,
                    borderRadius: 5, padding: '8px 10px', color: TH.text, fontSize: 13,
                    fontFamily: 'inherit', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                  }}
                />
                <span style={{ fontSize: 12, color: TH.muted, width: 32 }}>{scope.unit}</span>
              </div>
            ))}
            {totalSqft > 0 && (
              <div style={{ borderTop: `1px solid ${TH.border}`, marginTop: 10, paddingTop: 10, display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: TH.muted }}>Total</span>
                <span style={{ fontSize: 16, fontWeight: 600, color: TH.amber, fontVariantNumeric: 'tabular-nums' }}>
                  {totalSqft.toLocaleString()} sqft
                </span>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <Btn variant="ghost" onClick={() => setStep(2)} style={{ flex: 1 }}>← Back</Btn>
              <Btn disabled={totalSqft === 0} onClick={() => setStep(4)} style={{ flex: 2 }}>
                Review & Create →
              </Btn>
            </div>
          </div>
        )}

        {/* ── Step 4: Review ── */}
        {step === 4 && (
          <div>
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Review & Create</div>
            <div style={{ fontSize: 13, color: TH.muted, marginBottom: 18 }}>
              Confirm details before creating the project.
            </div>
            {[
              ['Project Name',  name],
              ['Client',        client || '—'],
              ['Division',      division],
              ['Total Sqft',    `${totalSqft.toLocaleString()} sqft`],
              ['Bid $/sqft',    fmt.psf(parseFloat(bidPsf) || 0)],
              ['Bid Total',     fmt.money(totalSqft * (parseFloat(bidPsf) || 0))],
              ['Labor Rate',    `$${laborRate}/hr`],
              ['Target sqft/hr', targetSqHr || '—'],
              ['Bonus Pool',    bonusPool ? fmt.money(parseFloat(bonusPool)) : '—'],
            ].map(([label, val]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${TH.border}` }}>
                <span style={{ fontSize: 13, color: TH.muted }}>{label}</span>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{val}</span>
              </div>
            ))}

            {error && (
              <div style={{ background: TH.redLo, border: `1px solid ${TH.red}44`, borderRadius: 5, padding: '10px 12px', marginTop: 14, fontSize: 12, color: TH.red }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <Btn variant="ghost" onClick={() => setStep(3)} style={{ flex: 1 }}>← Back</Btn>
              <Btn onClick={handleCreate} disabled={saving} style={{ flex: 2, background: TH.green, color: '#000' }}>
                {saving ? 'Creating…' : 'Create Project →'}
              </Btn>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

function StepBar({ current }) {
  const steps = [
    { n: 1, l: 'Details'      },
    { n: 2, l: 'Blueprints'   },
    { n: 3, l: 'Measurements' },
    { n: 4, l: 'Review'       },
  ]
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 28 }}>
      {steps.map((s, i) => (
        <div key={s.n} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
            <div style={{
              width: 26, height: 26, borderRadius: '50%', display: 'flex',
              alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600,
              background: current === s.n ? TH.amber : current > s.n ? TH.green : TH.card,
              color: current >= s.n ? '#000' : TH.muted,
              border: `1px solid ${current >= s.n ? 'transparent' : TH.border}`,
            }}>
              {current > s.n ? '✓' : s.n}
            </div>
            <div style={{ fontSize: 10, color: current === s.n ? TH.amber : TH.muted, marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'center' }}>
              {s.l}
            </div>
          </div>
          {i < steps.length - 1 && (
            <div style={{ height: 1, flex: 1, background: current > s.n ? TH.green : TH.border, margin: '0 4px 16px' }} />
          )}
        </div>
      ))}
    </div>
  )
}
