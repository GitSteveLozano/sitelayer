/**
 * `mb-est-pdf-deliverable` — mobile PDF deliverable (design msg__32,
 * audit M05 #14).
 *
 * Reached from the quantities summary's GENERATE PDF (and Price&Send's
 * Preview PDF). Shows the REAL generated estimate PDF — fetched with auth
 * via `useAuthenticatedObjectUrl(estimateReportPath(...))`, the same
 * GET /api/projects/:id/estimate.pdf the desktop DOWNLOAD action opens —
 * never the design mock's dummy page (audit D10 flagged the desktop
 * PdfPreviewModal for shipping that mock; this screen deliberately doesn't
 * reuse it).
 *
 * Mode selection: the design's PLAN ONLY / WITH TAKEOFF / CURRENT VIEW rail
 * has no backend — plan-sheet overlay export doesn't exist. What the backend
 * DOES support is the Phase-3 report kinds (?report= on estimate.pdf), so the
 * rail selects among those four real modes instead of faking the design's.
 *
 * SEND TO CLIENT reuses estimate-review's SendToClientSheet → the real
 * createEstimateShare chain (private signable portal link), single-sourced.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet, type ProjectSummary } from '@/lib/api'
import { useCustomers } from '@/lib/api/customers'
import { useAuthenticatedObjectUrl } from '../../lib/api/blob-url.js'
import { estimateReportPath, useScopeVsBid, type EstimateReportKind } from '../../lib/api/estimate.js'
import { createEstimateShare } from '../../lib/api/estimate-shares.js'
import { MBody, MButton, MTopBar } from '../../components/m/index.js'
import { SendToClientSheet, slugifyFile } from './estimate-review.js'

const mono = (extra: CSSProperties = {}): CSSProperties => ({
  fontFamily: 'var(--m-num)',
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  ...extra,
})

/** The four REAL report modes estimate.pdf serves (?report=). Short tab
 * labels for the rail; kinds map 1:1 onto lib/api/estimate ESTIMATE_REPORTS. */
const PDF_MODES: ReadonlyArray<{ kind: EstimateReportKind; label: string }> = [
  { kind: 'customer', label: 'PROPOSAL' },
  { kind: 'summary', label: 'INTERNAL' },
  { kind: 'rfq', label: 'RFQ' },
  { kind: 'cost_vs_sell', label: 'COST VS SELL' },
]

export function MobileEstPdfDeliverable({ companySlug }: { companySlug: string }) {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  // Project name (filename + send sheet) — same summary the review uses.
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    apiGet<ProjectSummary>(`/api/projects/${projectId}/summary`, companySlug)
      .then((s) => {
        if (!cancelled) setSummary(s)
      })
      .catch((err) => {
        if (!cancelled) setSummaryError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, companySlug])

  // Priced lines — gate the preview/download/send on a real estimate existing.
  const scopeQuery = useScopeVsBid(projectId)
  const lines = scopeQuery.data?.lines ?? []
  const hasLines = lines.length > 0

  // Which real report mode the preview/download targets.
  const [mode, setMode] = useState<EstimateReportKind>('customer')
  // Bumping the nonce re-fetches the same PDF after a failure (the estimate.pdf
  // handler ignores unknown query params).
  const [retryNonce, setRetryNonce] = useState(0)
  const pdfPath = useMemo(() => {
    if (!projectId || !hasLines) return null
    const base = estimateReportPath(projectId, mode)
    return retryNonce > 0 ? `${base}${base.includes('?') ? '&' : '?'}retry=${retryNonce}` : base
  }, [projectId, hasLines, mode, retryNonce])

  // The REAL generated PDF, fetched with auth headers into an object URL.
  const preview = useAuthenticatedObjectUrl(pdfPath)

  const projectName = summary?.project.name ?? ''
  const fileName = `${slugifyFile(projectName || 'estimate')}.pdf`

  // Client identity for the send sheet — same derivation as estimate-review.
  const customersQuery = useCustomers()
  const client = useMemo(() => {
    const all = customersQuery.data?.customers ?? []
    return all.find((c) => c.id === summary?.project.customer_id) ?? null
  }, [customersQuery.data?.customers, summary?.project.customer_id])
  const clientLabel = client?.name ?? summary?.project.customer_name ?? ''
  const clientFirstName = clientLabel.trim().split(/\s+/)[0] ?? ''

  // SEND TO CLIENT — the real share chain (createEstimateShare), via the
  // exact sheet Price&Send uses.
  const [showSendSheet, setShowSendSheet] = useState(false)
  const [sendNote, setSendNote] = useState('')
  const [sendEmail, setSendEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const confirmSend = async (recipientEmail: string) => {
    if (!projectId) return
    setSending(true)
    setSendError(null)
    try {
      const trimmedNote = sendNote.trim()
      const result = await createEstimateShare(projectId, {
        recipient_email: recipientEmail,
        ...(trimmedNote ? { message: trimmedNote } : {}),
      })
      setShareUrl(result.share_url)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  // DOWNLOAD — hand the already-fetched blob to the browser under the
  // deliverable filename (no second authenticated round-trip).
  const download = () => {
    if (!preview.url) return
    const a = document.createElement('a')
    a.href = preview.url
    a.download = fileName
    a.rel = 'noopener'
    a.click()
  }

  const back = () => navigate(`/projects/${projectId}/quantities`)

  return (
    <>
      <MTopBar back eyebrow="DELIVERABLE · PDF" title={fileName.toUpperCase()} onBack={back} />
      <MBody>
        {summaryError ? (
          <div style={{ padding: '12px 16px', color: 'var(--m-red)', fontSize: 13 }}>{summaryError}</div>
        ) : null}

        {/* Mode rail — the four REAL report kinds estimate.pdf serves. */}
        <div style={{ display: 'flex', borderBottom: '2px solid var(--m-ink)', overflowX: 'auto' }}>
          {PDF_MODES.map((t) => {
            const active = t.kind === mode
            return (
              <button
                key={t.kind}
                type="button"
                onClick={() => setMode(t.kind)}
                aria-pressed={active}
                style={{
                  ...mono({ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em' }),
                  flex: '1 0 auto',
                  padding: '12px 14px',
                  border: 'none',
                  borderRight: '1px solid var(--m-line-2)',
                  background: active ? 'var(--m-accent)' : 'transparent',
                  color: active ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {t.label}
              </button>
            )
          })}
        </div>
        {/* Honest gap note: the design's plan-sheet overlay modes (PLAN ONLY /
            WITH TAKEOFF / CURRENT VIEW) have no export endpoint yet. */}
        <div style={mono({ fontSize: 10, color: 'var(--m-ink-3)', padding: '8px 16px 0', lineHeight: 1.5 })}>
          Report modes from the estimate API · plan-sheet overlay export not available yet
        </div>

        {/* Preview — the real generated PDF on the dark stage. */}
        <div
          style={{
            margin: '12px 16px 0',
            background: 'var(--m-ink)',
            minHeight: 380,
            display: 'flex',
            alignItems: 'stretch',
            justifyContent: 'center',
            padding: 12,
          }}
        >
          {!hasLines ? (
            <div style={{ alignSelf: 'center', textAlign: 'center', padding: '0 16px' }}>
              <div style={mono({ fontSize: 11, color: 'var(--m-sand)', lineHeight: 1.6 })}>
                {scopeQuery.isLoading
                  ? 'Loading estimate…'
                  : 'No priced line items yet — nothing to put in a PDF. Run takeoff, then recompute the estimate.'}
              </div>
            </div>
          ) : preview.loading ? (
            <div style={{ alignSelf: 'center', textAlign: 'center' }}>
              <div style={mono({ fontSize: 11, color: 'var(--m-sand)' })}>Generating preview…</div>
            </div>
          ) : preview.error ? (
            <div style={{ alignSelf: 'center', textAlign: 'center', padding: '0 16px' }}>
              <div style={mono({ fontSize: 11, color: 'var(--m-red)', lineHeight: 1.6 })}>
                Could not generate the PDF
              </div>
              <div style={{ fontSize: 12, color: 'var(--m-sand)', marginTop: 8, lineHeight: 1.5 }}>
                {preview.error.message}
              </div>
              <div style={{ marginTop: 12 }}>
                <MButton variant="ghost" size="sm" onClick={() => setRetryNonce((n) => n + 1)}>
                  Try again
                </MButton>
              </div>
            </div>
          ) : preview.url ? (
            <iframe
              title={`PDF preview · ${fileName}`}
              src={preview.url}
              style={{ width: '100%', minHeight: 420, border: '2px solid var(--m-sand)', background: '#fff' }}
            />
          ) : null}
        </div>

        {/* DOWNLOAD / SEND TO CLIENT (msg__32 foot). */}
        <div style={{ padding: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
            <MButton variant="ghost" onClick={download} disabled={!preview.url} style={{ minWidth: 0 }}>
              Download
            </MButton>
            <MButton
              variant="primary"
              onClick={() => {
                setSendError(null)
                setShareUrl(null)
                setShowSendSheet(true)
              }}
              disabled={!hasLines}
              style={{ minWidth: 0 }}
            >
              Send to client
            </MButton>
          </div>
        </div>
      </MBody>

      {showSendSheet ? (
        <SendToClientSheet
          clientName={clientLabel || 'Client'}
          clientFirstName={clientFirstName || clientLabel || 'client'}
          clientCompany={client?.source ?? null}
          fileName={fileName}
          lineCount={lines.length}
          note={sendNote}
          onNoteChange={setSendNote}
          email={sendEmail}
          onEmailChange={setSendEmail}
          sending={sending}
          error={sendError}
          shareUrl={shareUrl}
          onSend={() => void confirmSend(sendEmail.trim())}
          onClose={() => {
            if (!sending) setShowSendSheet(false)
          }}
        />
      ) : null}
    </>
  )
}
