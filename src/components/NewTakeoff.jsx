import { useState } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Input, Select, Btn } from './Atoms'
import { projects } from '../lib/db'
import { fmt } from '../lib/calc'
import { Documents } from './Documents'
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

export function NewTakeoff({ companyId, company, onBack, onCreated }) {
  const isMobile = useIsMobile()
  const [step,     setStep]     = useState(1)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState(null)

  // Created project record (set after Step 1)
  const [createdProject, setCreatedProject] = useState(null)

  // Step 1 fields
  const [name,       setName]       = useState('')
  const [client,     setClient]     = useState('')
  const [division,   setDivision]   = useState('D4-EIFS')
  const [bidPsf,     setBidPsf]     = useState('')
  const [laborRate,  setLaborRate]  = useState('38')
  const [targetSqHr, setTargetSqHr] = useState('')
  const [bonusPool,  setBonusPool]  = useState('')

  const canStep1 = name.trim() && bidPsf && parseFloat(bidPsf) > 0

  async function handleCreateOrUpdate() {
    setSaving(true)
    setError(null)

    const fields = {
      company_id:          companyId,
      name:                name.trim(),
      client_name:         client.trim(),
      division,
      status:              'bid',
      sqft:                0,
      bid_psf:             parseFloat(bidPsf),
      labor_rate:          parseFloat(laborRate) || 38,
      target_sqft_per_hr:  parseFloat(targetSqHr) || null,
      bonus_pool:          parseFloat(bonusPool) || 0,
      risk_threshold:      0.50,
      material_cost:       0,
      sub_cost:            0,
    }

    let result
    if (createdProject) {
      // Update existing project
      const { company_id, status, risk_threshold, material_cost, sub_cost, ...updates } = fields
      result = await projects.update(createdProject.id, updates)
    } else {
      result = await projects.create(fields)
    }

    setSaving(false)
    if (result.error) { setError(result.error.message); return }
    setCreatedProject(result.data)
    setStep(2)
  }

  async function handleDocumentsUpdated() {
    if (!createdProject) return
    const { data } = await projects.get(createdProject.id)
    if (data) setCreatedProject(data)
  }

  function handleFinish() {
    onCreated?.(createdProject)
  }

  const measurements = createdProject?.metadata?.blueprint_measurements

  return (
    <div style={{ padding: step === 2 ? '16px' : (isMobile ? '16px 14px' : '32px 36px'), maxWidth: step === 2 ? 'none' : 640 }}>
      {step !== 2 && (
        <>
          <button onClick={onBack} style={{ fontSize: 13, color: TH.muted, cursor: 'pointer', marginBottom: 20, background: 'none', border: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>
            ← Dashboard
          </button>
          <h1 style={{ fontSize: 22, fontWeight: 500, color: TH.text, margin: 0, marginBottom: 4 }}>New Project</h1>
          <div style={{ fontSize: 13, color: TH.muted, marginBottom: 28 }}>Enter project details and upload blueprints</div>
        </>
      )}

      {/* Step bar */}
      <StepBar current={step} />

      {/* ── Step 1: Project Details ── */}
      {step === 1 && (
        <Card>
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

          {error && (
            <div style={{ background: TH.redLo, border: `1px solid ${TH.red}44`, borderRadius: 5, padding: '10px 12px', marginBottom: 14, fontSize: 12, color: TH.red }}>
              {error}
            </div>
          )}

          <Btn disabled={!canStep1 || saving} onClick={handleCreateOrUpdate} style={{ width: '100%' }}>
            {saving ? 'Saving…' : createdProject ? 'Save & Continue →' : 'Create Project & Continue →'}
          </Btn>
        </Card>
      )}

      {/* ── Step 2: Blueprint Upload + Measurement ── */}
      {step === 2 && createdProject && (
        <div>
          <div style={{ fontSize: 13, color: TH.muted, marginBottom: 16, lineHeight: 1.6 }}>
            Upload a blueprint PDF and measure scope items on the canvas.
            You can skip this and do it later from the project page.
          </div>

          <Documents
            project={createdProject}
            company={company}
            onUpdated={handleDocumentsUpdated}
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            <Btn variant="ghost" onClick={() => setStep(1)} style={{ flex: 1 }}>← Back</Btn>
            <Btn onClick={() => { handleDocumentsUpdated(); setStep(3) }} style={{ flex: 2 }}>
              {createdProject.blueprint_url ? 'Continue →' : 'Skip for Now →'}
            </Btn>
          </div>
        </div>
      )}

      {/* ── Step 3: Summary ── */}
      {step === 3 && createdProject && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Project Created</div>
          <div style={{ fontSize: 13, color: TH.muted, marginBottom: 18 }}>
            Your project is ready. Here's a summary.
          </div>

          {[
            ['Project Name',  createdProject.name],
            ['Client',        createdProject.client_name || '—'],
            ['Division',      createdProject.division],
            ['Bid $/sqft',    fmt.psf(createdProject.bid_psf || 0)],
            ['Labor Rate',    `$${createdProject.labor_rate}/hr`],
            ['Blueprint',     createdProject.blueprint_url ? 'Uploaded' : 'Not uploaded'],
            ['Measurements',  measurements ? `${Math.round(measurements.totalSqft).toLocaleString()} sqft` : 'Not yet measured'],
          ].map(([label, val]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${TH.border}` }}>
              <span style={{ fontSize: 13, color: TH.muted }}>{label}</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{val}</span>
            </div>
          ))}

          {measurements && (
            <div style={{ marginTop: 14, padding: '10px 14px', background: TH.greenLo, border: `1px solid ${TH.green}44`, borderRadius: 6, fontSize: 12, color: TH.green }}>
              Bid Total: {fmt.money((measurements.totalSqft || 0) * (createdProject.bid_psf || 0))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            <Btn variant="ghost" onClick={() => setStep(2)} style={{ flex: 1 }}>← Back</Btn>
            <Btn onClick={handleFinish} style={{ flex: 2, background: TH.green, color: '#000' }}>
              Open Project →
            </Btn>
          </div>
        </Card>
      )}
    </div>
  )
}

function StepBar({ current }) {
  const steps = [
    { n: 1, l: 'Details'   },
    { n: 2, l: 'Blueprint' },
    { n: 3, l: 'Summary'   },
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
