import { useState, useRef, useEffect } from 'react'
import { lazy, Suspense } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Btn, Spinner } from './Atoms'
import { supabase } from '../lib/supabase'
import { projects } from '../lib/db'
import { generateEstimatePDF } from '../lib/generateEstimate'

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
  const [estimateData, setEstimateData] = useState(
    project.metadata?.blueprint_measurements || null
  )
  const hasBlueprint = !!project.blueprint_url

  // Get saved rates from company settings
  const rates = company?.metadata?.rates || {}

  const inputRef = useRef(null)
  const storagePath = `${project.company_id}/${project.id}/blueprint.pdf`

  // Generate a fresh signed URL on demand
  async function openCanvas() {
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
  if (showCanvas && pdfUrl) {
    return (
      <Suspense fallback={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400, gap: 12, color: TH.muted }}>
          <Spinner /> Loading canvas…
        </div>
      }>
        <BlueprintCanvas
          project={project}
          blueprintUrl={pdfUrl}
          rates={rates}
          onBack={() => setShowCanvas(false)}
          onMeasurementsApplied={async ({ summary, totalSqft, estimate, subtotal, gst, total, divOverrides }) => {
            const measurements = {
              applied_at: new Date().toISOString(),
              summary,
              totalSqft,
              estimate,
              subtotal,
              gst,
              total,
            }
            await projects.update(project.id, {
              sqft:     Math.round(totalSqft),
              metadata: { ...(project.metadata || {}), blueprint_measurements: measurements, div_overrides: divOverrides || {} },
            })
            setEstimateData(measurements)
            setShowCanvas(false)
            setApplied(true)
            onUpdated?.()
          }}
        />
      </Suspense>
    )
  }

  // ── PDF upload handler ───────────────────────────────────────────────────────
  async function handleFile(file) {
    if (!file) return
    if (file.type !== 'application/pdf') {
      setUploadError('Please upload a PDF file.')
      return
    }
    if (file.size > 50 * 1024 * 1024) {
      setUploadError('File too large. Max 50MB.')
      return
    }

    setUploading(true)
    setUploadError(null)

    const path = `${project.company_id}/${project.id}/blueprint.pdf`

    const { error: uploadErr } = await supabase.storage
      .from('blueprints')
      .upload(path, file, { upsert: true })

    if (uploadErr) {
      setUploadError(uploadErr.message)
      setUploading(false)
      return
    }

    // Store the storage path as a flag — signed URLs are generated on demand
    await projects.update(project.id, { blueprint_url: path })

    const { data: urlData } = await supabase.storage
      .from('blueprints')
      .createSignedUrl(path, 60 * 60 * 24 * 7)

    setPdfUrl(urlData?.signedUrl || null)
    setUploading(false)
    setApplied(false)
    onUpdated?.()
  }

  function handleDrop(e) {
    e.preventDefault()
    handleFile(e.dataTransfer.files?.[0])
  }

  function handleDragOver(e) { e.preventDefault() }

  return (
    <div style={{ maxWidth: 640 }}>
      <Card>
        <Label>Blueprint</Label>

        {/* Applied confirmation */}
        {applied && (
          <div style={{
            background: TH.greenLo, border: `1px solid ${TH.green}44`,
            borderRadius: 6, padding: '10px 14px', marginBottom: 16,
            fontSize: 13, color: TH.green,
          }}>
            ✓ Measurements applied to project
          </div>
        )}

        {hasBlueprint ? (
          // ── Blueprint uploaded ────────────────────────────────────────────────
          <>
            <div style={{
              background: TH.surf, borderRadius: 8, padding: '16px 18px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 16,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 28 }}>📄</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>blueprint.pdf</div>
                  <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>
                    {project.metadata?.blueprint_measurements
                      ? `Last measured ${new Date(project.metadata.blueprint_measurements.applied_at).toLocaleDateString()}`
                      : 'Ready to measure'}
                  </div>
                </div>
              </div>
              <button
                onClick={async () => {
                  const { data } = await supabase.storage.from('blueprints')
                    .createSignedUrl(storagePath, 60 * 60)
                  if (data?.signedUrl) window.open(data.signedUrl, '_blank')
                }}
                style={{ fontSize: 11, color: TH.muted, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
              >
                View PDF
              </button>
            </div>

            {/* Primary CTA */}
            <Btn
              onClick={openCanvas}
              disabled={loadingUrl}
              style={{ width: '100%', padding: '14px', fontSize: 14, marginBottom: 10 }}
            >
              {loadingUrl ? 'Loading…' : '✏️ Open Measurement Canvas'}
            </Btn>

            <div style={{ textAlign: 'center' }}>
              <label style={{ fontSize: 12, color: TH.faint, cursor: 'pointer', textDecoration: 'underline' }}>
                Replace blueprint
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  style={{ display: 'none' }}
                  onChange={e => handleFile(e.target.files?.[0])}
                />
              </label>
            </div>

            {/* Estimate summary + download */}
            {estimateData?.estimate?.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <Label style={{ margin: 0 }}>Generated Estimate</Label>
                  <Btn
                    onClick={() => {
                      const doc = generateEstimatePDF({
                        company,
                        project,
                        estimate:  estimateData.estimate,
                        subtotal:  estimateData.subtotal,
                        gst:       estimateData.gst,
                        total:     estimateData.total,
                      })
                      doc.save(`${project.name || 'estimate'}-quote.pdf`)
                    }}
                    style={{ fontSize: 11, padding: '6px 14px', background: TH.amber, color: '#000' }}
                  >
                    ⬇ Download PDF
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
                        <td style={{ textAlign: 'right', color: TH.muted, fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>
                          {line.qty.toLocaleString()} {line.unit}
                        </td>
                        <td style={{ textAlign: 'right', color: TH.muted, fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>
                          ${line.rate.toFixed(2)}
                        </td>
                        <td style={{ textAlign: 'right', color: TH.amber, fontVariantNumeric: 'tabular-nums' }}>
                          ${line.amount.toLocaleString('en', { minimumFractionDigits: 2 })}
                        </td>
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
                    <span>Total</span>
                    <span style={{ color: TH.amber }}>${estimateData.total?.toLocaleString('en', { minimumFractionDigits: 2 })}</span>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          // ── No blueprint yet ─────────────────────────────────────────────────
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            style={{
              border: `2px dashed ${TH.border}`, borderRadius: 10,
              padding: '48px 24px', textAlign: 'center',
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
                <div style={{ fontSize: 16, fontWeight: 500, color: TH.text, marginBottom: 6 }}>
                  Upload your blueprint
                </div>
                <div style={{ fontSize: 13, color: TH.muted, marginBottom: 24, lineHeight: 1.6 }}>
                  Drop a PDF here, or click to browse.<br />
                  Then measure directly — no PlanSwift needed.
                </div>
                <label style={{
                  cursor: 'pointer', display: 'inline-block',
                  padding: '10px 24px', borderRadius: 6, fontSize: 13,
                  fontWeight: 500, fontFamily: 'inherit',
                  background: TH.amber, color: '#000',
                }}>
                  Choose PDF
                  <input
                    type="file"
                    accept=".pdf,application/pdf"
                    style={{ display: 'none' }}
                    onChange={e => handleFile(e.target.files?.[0])}
                  />
                </label>
                <div style={{ fontSize: 11, color: TH.faint, marginTop: 12 }}>PDF · Max 50MB</div>
              </>
            )}
          </div>
        )}

        {uploadError && (
          <div style={{ fontSize: 12, color: TH.red, marginTop: 10 }}>{uploadError}</div>
        )}
      </Card>
    </div>
  )
}
