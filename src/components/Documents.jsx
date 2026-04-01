import { useState } from 'react'
import { lazy, Suspense } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Btn, Spinner } from './Atoms'
import { supabase } from '../lib/supabase'
import { projects } from '../lib/db'

const BlueprintCanvas = lazy(() =>
  import('./BlueprintCanvas').then(m => ({ default: m.BlueprintCanvas }))
)

export function Documents({ project, onUpdated }) {
  const [uploading,   setUploading]   = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const [pdfUrl,      setPdfUrl]      = useState(project.blueprint_url || null)
  const [showCanvas,  setShowCanvas]  = useState(false)
  const [applied,     setApplied]     = useState(false)

  const inputRef = useState(null)

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
          onBack={() => setShowCanvas(false)}
          onMeasurementsApplied={async ({ summary, totalSqft }) => {
            await projects.update(project.id, {
              sqft:     Math.round(totalSqft),
              metadata: {
                ...(project.metadata || {}),
                blueprint_measurements: {
                  applied_at: new Date().toISOString(),
                  summary,
                  totalSqft,
                },
              },
            })
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

    const { data: urlData } = await supabase.storage
      .from('blueprints')
      .createSignedUrl(path, 60 * 60 * 24 * 7)

    const url = urlData?.signedUrl || null
    await projects.update(project.id, { blueprint_url: url })
    setPdfUrl(url)
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

        {pdfUrl ? (
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
                onClick={() => window.open(pdfUrl, '_blank')}
                style={{ fontSize: 11, color: TH.muted, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
              >
                View PDF
              </button>
            </div>

            {/* Primary CTA */}
            <Btn
              onClick={() => setShowCanvas(true)}
              style={{ width: '100%', padding: '14px', fontSize: 14, marginBottom: 10 }}
            >
              ✏️ Open Measurement Canvas
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

            {/* Measurement summary if applied */}
            {project.metadata?.blueprint_measurements?.summary && (
              <div style={{ marginTop: 20 }}>
                <Label>Last Measurement</Label>
                {Object.entries(project.metadata.blueprint_measurements.summary).map(([item, sqft]) => (
                  <div key={item} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: `1px solid ${TH.border}`, fontSize: 13 }}>
                    <span style={{ color: TH.muted }}>{item}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: TH.amber }}>
                      {Math.round(sqft).toLocaleString()} sqft
                    </span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', fontWeight: 600, fontSize: 14 }}>
                  <span>Total</span>
                  <span style={{ color: TH.amber }}>
                    {Math.round(project.metadata.blueprint_measurements.totalSqft).toLocaleString()} sqft
                  </span>
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
                <label style={{ cursor: 'pointer' }}>
                  <Btn style={{ pointerEvents: 'none' }}>Choose PDF</Btn>
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
