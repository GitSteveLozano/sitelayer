import { useState, useRef } from 'react'
import { lazy, Suspense } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Btn, Spinner } from './Atoms'
import { supabase } from '../lib/supabase'
import { projects, drafts } from '../lib/db'
import { generateEstimatePDF } from '../lib/generateEstimate'
import { SCOPE_ITEMS } from './BlueprintCanvas'
import { useDrafts } from '../hooks/useDrafts'

const BlueprintCanvas = lazy(() =>
  import('./BlueprintCanvas').then(m => ({ default: m.BlueprintCanvas }))
)

export function Documents({ project, company, onUpdated }) {
  const [uploading,    setUploading]    = useState(false)
  const [uploadError,  setUploadError]  = useState(null)
  const [pdfUrl,       setPdfUrl]       = useState(null)
  const [showCanvas,   setShowCanvas]   = useState(false)
  const [loadingUrl,   setLoadingUrl]   = useState(false)
  const [applied,      setApplied]      = useState(false)

  const { draftList, activeDraft, loading: draftsLoading, refresh: refreshDrafts } = useDrafts(project.id)

  const hasBlueprint = !!project.blueprint_url
  const companyRates = company?.metadata?.rates || {}
  const projectRates = project.metadata?.rates || {}
  const rates = { ...companyRates, ...projectRates }

  const storagePath = `${project.company_id}/${project.id}/blueprint.pdf`

  const estimateData = activeDraft?.estimate?.estimate ? activeDraft.estimate : null

  async function openCanvas() {
    // Auto-create a draft if none exist
    let draft = activeDraft
    if (!draft) {
      const { data } = await drafts.create({
        project_id: project.id,
        type: 'measurement',
        name: 'Draft 1',
        is_active: true,
      })
      draft = data
      await refreshDrafts()
    }

    setLoadingUrl(true)
    setUploadError(null)
    const { data, error } = await supabase.storage
      .from('blueprints')
      .createSignedUrl(storagePath, 60 * 60 * 24 * 7)
    setLoadingUrl(false)
    if (data?.signedUrl) {
      setPdfUrl(data.signedUrl)
      setShowCanvas(true)
    } else {
      setUploadError('Could not load blueprint — try re-uploading.')
      console.error('Signed URL error:', error)
    }
  }

  // ── Open canvas ─────────────────────────────────────────────────────────────
  if (showCanvas && pdfUrl && activeDraft) {
    return (
      <Suspense fallback={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400, gap: 12, color: TH.muted }}>
          <Spinner /> Loading canvas…
        </div>
      }>
        <BlueprintCanvas
          project={project}
          draft={activeDraft}
          blueprintUrl={pdfUrl}
          rates={rates}
          onBack={() => { setShowCanvas(false); refreshDrafts() }}
          onMeasurementsApplied={async ({ summary, totalSqft, estimate, subtotal, gst, total, divOverrides }) => {
            const measurements = {
              applied_at: new Date().toISOString(),
              summary, totalSqft, estimate, subtotal, gst, total,
            }
            await drafts.update(activeDraft.id, { estimate: measurements })
            if (activeDraft.is_active) {
              await projects.update(project.id, {
                sqft: Math.round(totalSqft),
                metadata: { ...(project.metadata || {}), div_overrides: divOverrides || {} },
              })
            }
            setShowCanvas(false)
            setApplied(true)
            refreshDrafts()
            onUpdated?.()
          }}
        />
      </Suspense>
    )
  }

  // ── PDF upload handler ───────────────────────────────────────────────────────
  async function handleFile(file) {
    if (!file) return
    if (file.type !== 'application/pdf') { setUploadError('Please upload a PDF file.'); return }
    if (file.size > 50 * 1024 * 1024) { setUploadError('File too large. Max 50MB.'); return }

    setUploading(true)
    setUploadError(null)
    const path = `${project.company_id}/${project.id}/blueprint.pdf`

    const { error: uploadErr } = await supabase.storage
      .from('blueprints').upload(path, file, { upsert: true })
    if (uploadErr) { setUploadError(uploadErr.message); setUploading(false); return }

    await projects.update(project.id, { blueprint_url: path })
    const { data: urlData } = await supabase.storage
      .from('blueprints').createSignedUrl(path, 60 * 60 * 24 * 7)
    setPdfUrl(urlData?.signedUrl || null)
    setUploading(false)
    setApplied(false)
    onUpdated?.()
  }

  function handleDrop(e) { e.preventDefault(); handleFile(e.dataTransfer.files?.[0]) }
  function handleDragOver(e) { e.preventDefault() }

  return (
    <div style={{ maxWidth: 640 }}>
      <Card>
        <Label>Blueprint</Label>

        {applied && (
          <div style={{
            background: TH.greenLo, border: `1px solid ${TH.green}44`,
            borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: TH.green,
          }}>
            Measurements applied to project
          </div>
        )}

        {hasBlueprint ? (
          <>
            <div style={{
              background: TH.surf, borderRadius: 8, padding: '16px 18px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 28 }}>📄</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>blueprint.pdf</div>
                  <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>
                    {estimateData ? `Last measured ${new Date(estimateData.applied_at).toLocaleDateString()}` : 'Ready to measure'}
                  </div>
                </div>
              </div>
              <button
                onClick={async () => {
                  const { data } = await supabase.storage.from('blueprints').createSignedUrl(storagePath, 60 * 60)
                  if (data?.signedUrl) window.open(data.signedUrl, '_blank')
                }}
                style={{ fontSize: 11, color: TH.muted, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
              >
                View PDF
              </button>
            </div>

            {/* Draft list */}
            <DraftList
              draftList={draftList}
              activeDraft={activeDraft}
              projectId={project.id}
              loading={draftsLoading}
              onRefresh={refreshDrafts}
            />

            <Btn
              onClick={openCanvas}
              disabled={loadingUrl}
              style={{ width: '100%', padding: '14px', fontSize: 14, marginBottom: 10 }}
            >
              {loadingUrl ? 'Loading…' : `Open Canvas${activeDraft ? ` — ${activeDraft.name}` : ''}`}
            </Btn>

            <div style={{ textAlign: 'center' }}>
              <label style={{ fontSize: 12, color: TH.faint, cursor: 'pointer', textDecoration: 'underline' }}>
                Replace blueprint
                <input type="file" accept=".pdf,application/pdf" style={{ display: 'none' }}
                  onChange={e => handleFile(e.target.files?.[0])} />
              </label>
            </div>

            {/* Estimate summary for active draft */}
            {estimateData?.estimate?.length > 0 && (
              <EstimateSummary estimateData={estimateData} project={project} company={company} draftName={activeDraft?.name} />
            )}
          </>
        ) : (
          <div onDrop={handleDrop} onDragOver={handleDragOver} style={{
            border: `2px dashed ${TH.border}`, borderRadius: 10, padding: '48px 24px', textAlign: 'center',
            transition: 'border-color 0.15s, background 0.15s',
          }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = TH.amber; e.currentTarget.style.background = TH.amberLo }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = TH.border; e.currentTarget.style.background = 'transparent' }}
          >
            {uploading ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                <Spinner />
                <div style={{ fontSize: 13, color: TH.muted }}>Uploading…</div>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 48, marginBottom: 12 }}>📐</div>
                <div style={{ fontSize: 16, fontWeight: 500, color: TH.text, marginBottom: 6 }}>Upload your blueprint</div>
                <div style={{ fontSize: 13, color: TH.muted, marginBottom: 24, lineHeight: 1.6 }}>
                  Drop a PDF here, or click to browse.<br />Then measure directly — no PlanSwift needed.
                </div>
                <label style={{
                  cursor: 'pointer', display: 'inline-block', padding: '10px 24px', borderRadius: 6,
                  fontSize: 13, fontWeight: 500, fontFamily: 'inherit', background: TH.amber, color: '#000',
                }}>
                  Choose PDF
                  <input type="file" accept=".pdf,application/pdf" style={{ display: 'none' }}
                    onChange={e => handleFile(e.target.files?.[0])} />
                </label>
                <div style={{ fontSize: 11, color: TH.faint, marginTop: 12 }}>PDF · Max 50MB</div>
              </>
            )}
          </div>
        )}

        {uploadError && <div style={{ fontSize: 12, color: TH.red, marginTop: 10 }}>{uploadError}</div>}
      </Card>

      <ProjectRates project={project} companyRates={companyRates} onUpdated={onUpdated} />
    </div>
  )
}

// ── Draft List ────────────────────────────────────────────────────────────────

function DraftList({ draftList, activeDraft, projectId, loading, onRefresh }) {
  const [renaming, setRenaming] = useState(null)
  const [renameVal, setRenameVal] = useState('')

  if (loading) return null

  async function handleCreate() {
    const name = `Draft ${draftList.length + 1}`
    await drafts.create({ project_id: projectId, type: 'measurement', name, is_active: false })
    onRefresh()
  }

  async function handleSetActive(id) {
    await drafts.setActive(projectId, id)
    onRefresh()
  }

  async function handleDelete(id) {
    await drafts.delete(id)
    onRefresh()
  }

  async function handleDuplicate(draft) {
    await drafts.create({
      project_id: projectId,
      type: 'measurement',
      name: `${draft.name} (copy)`,
      is_active: false,
      canvas_state: draft.canvas_state,
      estimate: draft.estimate,
    })
    onRefresh()
  }

  async function handleRename(id) {
    if (!renameVal.trim()) { setRenaming(null); return }
    await drafts.update(id, { name: renameVal.trim() })
    setRenaming(null)
    onRefresh()
  }

  if (draftList.length === 0) return null

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: TH.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Measurement Drafts
        </div>
        <button onClick={handleCreate} style={{
          fontSize: 11, color: TH.amber, background: 'none', border: 'none', cursor: 'pointer',
        }}>
          + New Draft
        </button>
      </div>
      {draftList.map(d => {
        const isActive = d.id === activeDraft?.id
        const sqft = d.estimate?.totalSqft ? `${Math.round(d.estimate.totalSqft).toLocaleString()} sqft` : 'No measurements'
        return (
          <div key={d.id} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '8px 10px', borderRadius: 5, marginBottom: 4, cursor: 'pointer',
            background: isActive ? TH.amber + '15' : TH.surf,
            border: `1px solid ${isActive ? TH.amber + '44' : TH.border}`,
          }}
            onClick={() => !isActive && handleSetActive(d.id)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: isActive ? TH.amber : TH.faint,
              }} />
              {renaming === d.id ? (
                <input
                  autoFocus
                  value={renameVal}
                  onChange={e => setRenameVal(e.target.value)}
                  onBlur={() => handleRename(d.id)}
                  onKeyDown={e => e.key === 'Enter' && handleRename(d.id)}
                  onClick={e => e.stopPropagation()}
                  style={{
                    fontSize: 12, background: TH.card, border: `1px solid ${TH.border}`,
                    borderRadius: 3, padding: '2px 6px', color: TH.text, fontFamily: 'inherit', width: 120,
                  }}
                />
              ) : (
                <span style={{ fontSize: 12, fontWeight: isActive ? 600 : 400, color: isActive ? TH.amber : TH.text }}>
                  {d.name}
                </span>
              )}
              <span style={{ fontSize: 10, color: TH.faint }}>{sqft}</span>
            </div>
            <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
              <DraftAction label="Rename" onClick={() => { setRenaming(d.id); setRenameVal(d.name) }} />
              <DraftAction label="Duplicate" onClick={() => handleDuplicate(d)} />
              {draftList.length > 1 && <DraftAction label="Delete" color={TH.red} onClick={() => handleDelete(d.id)} />}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DraftAction({ label, onClick, color }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 9, color: color || TH.faint, background: 'none', border: 'none',
      cursor: 'pointer', padding: '2px 4px',
    }}>
      {label}
    </button>
  )
}

// ── Estimate Summary ──────────────────────────────────────────────────────────

function EstimateSummary({ estimateData, project, company, draftName }) {
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <Label style={{ margin: 0 }}>Estimate{draftName ? ` — ${draftName}` : ''}</Label>
        <Btn
          onClick={() => {
            const doc = generateEstimatePDF({
              company, project,
              estimate: estimateData.estimate,
              subtotal: estimateData.subtotal,
              gst: estimateData.gst,
              total: estimateData.total,
            })
            doc.save(`${project.name || 'estimate'}-quote.pdf`)
          }}
          style={{ fontSize: 11, padding: '6px 14px', background: TH.amber, color: '#000' }}
        >
          Download PDF
        </Btn>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${TH.border}` }}>
            <th style={{ textAlign: 'left', color: TH.muted, fontWeight: 600, padding: '5px 0', fontSize: 10, textTransform: 'uppercase' }}>Item</th>
            <th style={{ textAlign: 'right', color: TH.muted, fontWeight: 600, padding: '5px 0', fontSize: 10 }}>Qty</th>
            <th style={{ textAlign: 'right', color: TH.muted, fontWeight: 600, padding: '5px 0', fontSize: 10 }}>Rate</th>
            <th style={{ textAlign: 'right', color: TH.muted, fontWeight: 600, padding: '5px 0', fontSize: 10 }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {estimateData.estimate.map(line => (
            <tr key={line.item} style={{ borderBottom: `1px solid ${TH.border}22` }}>
              <td style={{ padding: '6px 0', color: TH.text }}>{line.item}</td>
              <td style={{ textAlign: 'right', color: TH.muted, fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>{line.qty.toLocaleString()} {line.unit}</td>
              <td style={{ textAlign: 'right', color: TH.muted, fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>${line.rate.toFixed(2)}</td>
              <td style={{ textAlign: 'right', color: TH.amber, fontVariantNumeric: 'tabular-nums' }}>${line.amount.toLocaleString('en', { minimumFractionDigits: 2 })}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 10, borderTop: `1px solid ${TH.border}`, paddingTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
          <span style={{ color: TH.muted }}>Subtotal</span>
          <span style={{ color: TH.muted }}>${estimateData.subtotal?.toLocaleString('en', { minimumFractionDigits: 2 })}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}>
          <span style={{ color: TH.muted }}>GST (5%)</span>
          <span style={{ color: TH.muted }}>${estimateData.gst?.toLocaleString('en', { minimumFractionDigits: 2 })}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 700 }}>
          <span>Scope Total</span>
          <span style={{ color: TH.amber }}>${estimateData.total?.toLocaleString('en', { minimumFractionDigits: 2 })}</span>
        </div>
      </div>

      {project.bid_psf > 0 && estimateData.totalSqft > 0 && (() => {
        const bidTotal = Math.round(estimateData.totalSqft * project.bid_psf * 100) / 100
        const diff = bidTotal - (estimateData.subtotal || 0)
        const isOver = diff < 0
        return (
          <div style={{
            marginTop: 12, padding: '10px 14px', borderRadius: 6,
            background: isOver ? (TH.redLo || '#fee2e222') : (TH.greenLo || '#dcfce722'),
            border: `1px solid ${isOver ? TH.red + '44' : TH.green + '44'}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: TH.muted }}>Bid ({`$${project.bid_psf}/sqft`})</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: TH.muted }}>${bidTotal.toLocaleString('en', { minimumFractionDigits: 2 })}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span style={{ color: isOver ? TH.red : TH.green, fontWeight: 600 }}>{isOver ? 'Scope exceeds bid by' : 'Under bid by'}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: isOver ? TH.red : TH.green, fontWeight: 600 }}>${Math.abs(diff).toLocaleString('en', { minimumFractionDigits: 2 })}</span>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ── Project Rates ─────────────────────────────────────────────────────────────

function ProjectRates({ project, companyRates, onUpdated }) {
  const existing = project.metadata?.rates || {}
  const [editing, setEditing] = useState(false)
  const [rates, setRates] = useState(
    Object.fromEntries(SCOPE_ITEMS.map(s => [s.id, existing[s.id] ?? '']))
  )
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const hasOverrides = Object.values(rates).some(v => v !== '')

  async function handleSave() {
    setSaving(true)
    const overrides = {}
    for (const [key, val] of Object.entries(rates)) {
      if (val !== '' && val !== null) overrides[key] = parseFloat(val)
    }
    await projects.update(project.id, {
      metadata: { ...(project.metadata || {}), rates: overrides }
    })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
    onUpdated?.()
  }

  function handleReset() {
    setRates(Object.fromEntries(SCOPE_ITEMS.map(s => [s.id, ''])))
  }

  return (
    <Card style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: editing ? 14 : 0 }}>
        <div>
          <Label style={{ margin: 0 }}>Project Rates</Label>
          <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>
            {hasOverrides ? 'Custom rates for this project' : 'Using company default rates'}
          </div>
        </div>
        <Btn variant="ghost" onClick={() => setEditing(!editing)} style={{ fontSize: 11, padding: '5px 12px' }}>
          {editing ? 'Close' : hasOverrides ? 'Edit' : 'Customize'}
        </Btn>
      </div>

      {editing && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${TH.border}` }}>
                <th style={{ textAlign: 'left', color: TH.muted, fontWeight: 600, padding: '6px 0', fontSize: 11 }}>Scope Item</th>
                <th style={{ textAlign: 'right', color: TH.muted, fontWeight: 600, padding: '6px 0', fontSize: 11 }}>Default</th>
                <th style={{ textAlign: 'right', color: TH.muted, fontWeight: 600, padding: '6px 8px', fontSize: 11 }}>Project Rate</th>
              </tr>
            </thead>
            <tbody>
              {SCOPE_ITEMS.map(s => {
                const defaultRate = companyRates[s.id] ?? s.defaultRate
                const hasOverride = rates[s.id] !== '' && rates[s.id] !== null
                return (
                  <tr key={s.id} style={{ borderBottom: `1px solid ${TH.border}22` }}>
                    <td style={{ padding: '8px 0', color: TH.text, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                      {s.id}
                      <span style={{ fontSize: 10, color: TH.faint }}>/{s.unit}</span>
                    </td>
                    <td style={{ textAlign: 'right', padding: '8px 0', color: TH.faint, fontSize: 12 }}>${defaultRate.toFixed(2)}</td>
                    <td style={{ textAlign: 'right', padding: '8px 0 8px 8px' }}>
                      <input
                        type="number" min="0" step="0.25"
                        value={rates[s.id]}
                        onChange={e => setRates(r => ({ ...r, [s.id]: e.target.value }))}
                        placeholder={defaultRate.toFixed(2)}
                        style={{
                          width: 80, textAlign: 'right',
                          background: TH.surf, border: `1px solid ${hasOverride ? TH.amber + '66' : TH.border}`,
                          borderRadius: 5, padding: '5px 8px',
                          color: hasOverride ? TH.amber : TH.text, fontSize: 13, fontFamily: 'inherit',
                        }}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Btn onClick={handleSave} disabled={saving} style={{ fontSize: 12 }}>
              {saving ? 'Saving…' : 'Save Rates'}
            </Btn>
            {hasOverrides && (
              <Btn variant="ghost" onClick={handleReset} style={{ fontSize: 11, padding: '5px 12px' }}>Reset to Defaults</Btn>
            )}
            {saved && <span style={{ fontSize: 12, color: TH.green }}>Saved</span>}
          </div>
        </>
      )}
    </Card>
  )
}
