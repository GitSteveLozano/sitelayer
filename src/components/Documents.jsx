import { useState, useRef } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Btn, Spinner } from './Atoms'
import { supabase } from '../lib/supabase'
import { projects } from '../lib/db'

// ─── PlanSwift CSV column mappings ────────────────────────────────────────────
// PlanSwift exports different column names depending on version.
// We check all known variations.
const ITEM_COLS  = ['Item', 'Name', 'Description', 'Task Name', 'Assembly']
const SQFT_COLS  = ['Sqft', 'SqFt', 'Sq Ft', 'Square Feet', 'Area', 'Quantity', 'Qty']

// Service items we recognize and normalize
const ITEM_MAP = {
  'air barrier':   'Air Barrier',
  'air/moisture':  'Air Barrier',
  'eps':           'EPS Foam',
  'foam':          'EPS Foam',
  'scratch':       'Scratch Coat',
  'finish':        'Finish Coat',
  'trim':          'Trim & Detail',
  'detail':        'Trim & Detail',
  'base coat':     'Scratch Coat',
  'top coat':      'Finish Coat',
}

function normalizeItem(raw = '') {
  const lower = raw.toLowerCase()
  for (const [key, val] of Object.entries(ITEM_MAP)) {
    if (lower.includes(key)) return val
  }
  return raw // Return as-is if no match
}

function parseCSV(text) {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return null

  // Parse header
  const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''))
  const itemIdx = header.findIndex(h => ITEM_COLS.includes(h))
  const sqftIdx = header.findIndex(h => SQFT_COLS.includes(h))

  if (itemIdx === -1 || sqftIdx === -1) {
    return {
      error: `Could not find required columns. Found: ${header.join(', ')}. Expected item column (${ITEM_COLS.join('/')}) and sqft column (${SQFT_COLS.join('/')}).`
    }
  }

  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''))
    const item = cols[itemIdx]
    const sqft = parseFloat(cols[sqftIdx])

    if (!item || isNaN(sqft) || sqft <= 0) continue
    rows.push({ item: normalizeItem(item), sqft, raw_item: item })
  }

  return { rows, header }
}

export function Documents({ project, onUpdated }) {
  const [uploading,   setUploading]   = useState(false)
  const [csvParsed,   setCsvParsed]   = useState(null)
  const [csvError,    setCsvError]    = useState(null)
  const [csvApplying, setCsvApplying] = useState(false)
  const [csvApplied,  setCsvApplied]  = useState(false)
  const [pdfUrl,      setPdfUrl]      = useState(project.blueprint_url || null)
  const [uploadError, setUploadError] = useState(null)

  const pdfRef = useRef()
  const csvRef = useRef()

  // ── PDF Upload ──────────────────────────────────────────────────────────────
  async function handlePdfUpload(e) {
    const file = e.target.files?.[0]
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

    // Get signed URL (valid 7 days)
    const { data: urlData } = await supabase.storage
      .from('blueprints')
      .createSignedUrl(path, 60 * 60 * 24 * 7)

    const url = urlData?.signedUrl || null

    // Save URL to project
    await projects.update(project.id, { blueprint_url: url })
    setPdfUrl(url)
    setUploading(false)
    onUpdated?.()
  }

  // ── CSV Parse ───────────────────────────────────────────────────────────────
  function handleCsvSelect(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvError(null)
    setCsvParsed(null)
    setCsvApplied(false)

    const reader = new FileReader()
    reader.onload = (ev) => {
      const result = parseCSV(ev.target.result)
      if (result?.error) {
        setCsvError(result.error)
      } else if (!result?.rows?.length) {
        setCsvError('No valid rows found in CSV. Make sure the file has item names and sqft values.')
      } else {
        setCsvParsed(result)
      }
    }
    reader.readAsText(file)
  }

  // ── Apply CSV to project ────────────────────────────────────────────────────
  async function handleApplyCsv() {
    if (!csvParsed?.rows) return
    setCsvApplying(true)

    // Sum sqft by normalized service item
    const totals = {}
    for (const row of csvParsed.rows) {
      totals[row.item] = (totals[row.item] || 0) + row.sqft
    }

    // Total sqft = sum of all items
    const totalSqft = Object.values(totals).reduce((s, v) => s + v, 0)

    await projects.update(project.id, {
      sqft:     totalSqft,
      metadata: {
        ...(project.metadata || {}),
        planswift_import: {
          imported_at: new Date().toISOString(),
          totals,
          rows: csvParsed.rows.length,
        }
      }
    })

    setCsvApplying(false)
    setCsvApplied(true)
    onUpdated?.()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Blueprint PDF */}
      <Card>
        <Label>Blueprint</Label>
        {pdfUrl ? (
          <div>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: TH.surf, borderRadius: 6, padding: '12px 14px', marginBottom: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>📄</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>blueprint.pdf</div>
                  <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>Uploaded successfully</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn
                  variant="ghost"
                  onClick={() => window.open(pdfUrl, '_blank')}
                  style={{ fontSize: 11, padding: '6px 12px' }}
                >
                  View
                </Btn>
                <Btn
                  variant="ghost"
                  onClick={() => pdfRef.current?.click()}
                  style={{ fontSize: 11, padding: '6px 12px' }}
                >
                  Replace
                </Btn>
              </div>
            </div>
          </div>
        ) : (
          <div
            onClick={() => pdfRef.current?.click()}
            style={{
              border: `2px dashed ${TH.border}`, borderRadius: 8,
              padding: '32px 24px', textAlign: 'center', cursor: 'pointer',
              transition: 'border-color 0.15s, background 0.15s',
              marginBottom: 4,
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = TH.amber; e.currentTarget.style.background = TH.amberLo }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = TH.border; e.currentTarget.style.background = 'transparent' }}
          >
            {uploading ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                <Spinner />
                <div style={{ fontSize: 13, color: TH.muted }}>Uploading…</div>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
                <div style={{ fontSize: 14, fontWeight: 500, color: TH.text, marginBottom: 4 }}>
                  Upload blueprint PDF
                </div>
                <div style={{ fontSize: 12, color: TH.muted }}>
                  Click to browse · PDF only · Max 50MB
                </div>
              </>
            )}
          </div>
        )}

        {uploadError && (
          <div style={{ fontSize: 12, color: TH.red, marginTop: 8 }}>{uploadError}</div>
        )}

        <input
          ref={pdfRef}
          type="file"
          accept=".pdf,application/pdf"
          style={{ display: 'none' }}
          onChange={handlePdfUpload}
        />
      </Card>

      {/* PlanSwift CSV Import */}
      <Card>
        <Label>Import Measurements from PlanSwift</Label>
        <div style={{ fontSize: 13, color: TH.muted, marginBottom: 16, lineHeight: 1.6 }}>
          Export your takeoff from PlanSwift as a CSV and upload it here. SiteLayer will automatically read the sqft values and update the project scope.
        </div>

        <div style={{ background: TH.surf, borderRadius: 6, padding: '10px 14px', marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: TH.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            How to export from PlanSwift
          </div>
          <ol style={{ fontSize: 12, color: TH.muted, paddingLeft: 16, margin: 0, lineHeight: 1.8 }}>
            <li>Open your takeoff in PlanSwift</li>
            <li>Go to File → Export → CSV</li>
            <li>Make sure "Item Name" and "Square Feet" columns are included</li>
            <li>Upload the exported CSV below</li>
          </ol>
        </div>

        {!csvParsed && (
          <div
            onClick={() => csvRef.current?.click()}
            style={{
              border: `2px dashed ${TH.border}`, borderRadius: 8,
              padding: '24px', textAlign: 'center', cursor: 'pointer',
              transition: 'border-color 0.15s, background 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = TH.blue; e.currentTarget.style.background = TH.blueLo }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = TH.border; e.currentTarget.style.background = 'transparent' }}
          >
            <div style={{ fontSize: 24, marginBottom: 6 }}>📊</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: TH.text, marginBottom: 4 }}>
              Upload PlanSwift CSV
            </div>
            <div style={{ fontSize: 12, color: TH.muted }}>Click to browse</div>
          </div>
        )}

        {csvError && (
          <div style={{ background: TH.redLo, border: `1px solid ${TH.red}44`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: TH.red }}>
            {csvError}
            <div style={{ marginTop: 6 }}>
              <button
                onClick={() => { setCsvError(null); csvRef.current?.click() }}
                style={{ fontSize: 11, color: TH.red, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
              >
                Try another file
              </button>
            </div>
          </div>
        )}

        {csvParsed && !csvApplied && (
          <div>
            <div style={{ background: TH.greenLo, border: `1px solid ${TH.green}44`, borderRadius: 6, padding: '10px 14px', marginBottom: 14, fontSize: 12, color: TH.green }}>
              ✓ Parsed {csvParsed.rows.length} measurement rows
            </div>

            {/* Preview table */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: TH.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                Preview
              </div>
              {Object.entries(
                csvParsed.rows.reduce((acc, r) => {
                  acc[r.item] = (acc[r.item] || 0) + r.sqft
                  return acc
                }, {})
              ).map(([item, sqft]) => (
                <div key={item} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: `1px solid ${TH.border}`, fontSize: 13 }}>
                  <span>{item}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: TH.amber }}>
                    {sqft.toLocaleString()} sqft
                  </span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', fontSize: 14, fontWeight: 600 }}>
                <span>Total</span>
                <span style={{ color: TH.amber, fontVariantNumeric: 'tabular-nums' }}>
                  {csvParsed.rows.reduce((s, r) => s + r.sqft, 0).toLocaleString()} sqft
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <Btn
                variant="ghost"
                onClick={() => { setCsvParsed(null); csvRef.current?.click() }}
                style={{ flex: 1 }}
              >
                Upload Different File
              </Btn>
              <Btn
                onClick={handleApplyCsv}
                disabled={csvApplying}
                style={{ flex: 2, background: TH.green, color: '#000' }}
              >
                {csvApplying ? 'Applying…' : 'Apply to Project →'}
              </Btn>
            </div>
          </div>
        )}

        {csvApplied && (
          <div style={{ background: TH.greenLo, border: `1px solid ${TH.green}44`, borderRadius: 6, padding: '12px 14px', fontSize: 13, color: TH.green }}>
            ✓ Measurements applied. Project sqft has been updated.
            <div style={{ marginTop: 6 }}>
              <button
                onClick={() => { setCsvParsed(null); setCsvApplied(false) }}
                style={{ fontSize: 11, color: TH.green, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
              >
                Import another file
              </button>
            </div>
          </div>
        )}

        <input
          ref={csvRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={handleCsvSelect}
        />
      </Card>
    </div>
  )
}
