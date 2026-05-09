import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { MBanner, MBody, MButton, MButtonStack, MTextarea, MTopBar } from '@/components/m'
import {
  fetchPortalEstimate,
  PortalApiError,
  postPortalAccept,
  postPortalDecline,
  type PortalEstimateView,
} from './api'
import { SignatureCapture } from './SignatureCapture'

/**
 * Public-facing estimate review screen for clients. Mounted at
 * `/portal/estimates/:shareToken` (no Clerk auth, no company picker).
 *
 * The page is a single-screen review of a frozen estimate snapshot
 * with two terminal CTAs (Accept + Decline). Mobile-first layout —
 * pure light theme so the customer never sees the operator's dark
 * mode chrome.
 */
export function EstimateView() {
  const { shareToken } = useParams<{ shareToken: string }>()
  const navigate = useNavigate()
  const [view, setView] = useState<PortalEstimateView | null>(null)
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null)
  const [mode, setMode] = useState<'idle' | 'accepting' | 'declining'>('idle')
  const [signerName, setSignerName] = useState('')
  const [signature, setSignature] = useState<string | null>(null)
  const [declineReason, setDeclineReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (!shareToken) return
    let cancelled = false
    fetchPortalEstimate(shareToken)
      .then((data) => {
        if (cancelled) return
        setView(data)
        if (data.status === 'accepted') {
          navigate(`/portal/estimates/${shareToken}/accepted`, { replace: true })
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const status = err instanceof PortalApiError ? err.status : 500
        const message =
          err instanceof PortalApiError
            ? err.message_for_user()
            : err instanceof Error
              ? err.message
              : 'Something went wrong.'
        setLoadError({ status, message })
      })
    return () => {
      cancelled = true
    }
  }, [shareToken, navigate])

  if (loadError) {
    return (
      <Shell title="Estimate">
        <MBanner tone="error" title={loadError.message} />
      </Shell>
    )
  }

  if (!view) {
    return (
      <Shell title="Estimate">
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--m-ink-3, #64748b)', fontSize: 14 }}>
          Loading…
        </div>
      </Shell>
    )
  }

  if (view.status === 'declined') {
    return (
      <Shell title={view.project_name} sub={`From ${view.company_name}`}>
        <MBanner
          tone="warn"
          title="You declined this estimate."
          body={view.decline_reason ? `Reason: ${view.decline_reason}` : undefined}
        />
        <ReadOnlySnapshot view={view} />
      </Shell>
    )
  }

  if (view.status === 'expired') {
    return (
      <Shell title={view.project_name} sub={`From ${view.company_name}`}>
        <MBanner tone="warn" title="This link has expired." body="Contact the sender for a fresh link." />
      </Shell>
    )
  }

  const handleAccept = async () => {
    if (!shareToken) return
    if (!signerName.trim()) {
      setSubmitError('Please type your full name.')
      return
    }
    if (!signature) {
      setSubmitError('Please sign in the box above.')
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      await postPortalAccept(shareToken, {
        signer_name: signerName.trim(),
        signature_data_url: signature,
      })
      navigate(`/portal/estimates/${shareToken}/accepted`, { replace: true })
    } catch (err) {
      const message = err instanceof PortalApiError ? err.message_for_user() : 'Could not accept right now.'
      setSubmitError(message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDecline = async () => {
    if (!shareToken) return
    if (!declineReason.trim()) {
      setSubmitError('Please share a quick reason.')
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      await postPortalDecline(shareToken, { decline_reason: declineReason.trim() })
      // Re-fetch to refresh the screen into the declined state.
      const refreshed = await fetchPortalEstimate(shareToken)
      setView(refreshed)
      setMode('idle')
    } catch (err) {
      const message = err instanceof PortalApiError ? err.message_for_user() : 'Could not decline right now.'
      setSubmitError(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Shell title={view.project_name} sub={`From ${view.company_name}`}>
      <ReadOnlySnapshot view={view} />

      {mode === 'idle' ? (
        <>
          {submitError ? <MBanner tone="error" title={submitError} /> : null}
          <MButtonStack>
            <MButton variant="primary" onClick={() => setMode('accepting')}>
              Accept estimate
            </MButton>
            <MButton variant="quiet" onClick={() => setMode('declining')}>
              Decline
            </MButton>
          </MButtonStack>
        </>
      ) : null}

      {mode === 'accepting' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Sign to accept</h3>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--m-ink-3, #64748b)' }}>
            Type your full name and sign below. By accepting you agree to the line items and totals shown above.
          </p>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--m-ink-3, #64748b)' }}>Your full name</span>
            <input
              className="m-input"
              value={signerName}
              onChange={(e) => setSignerName(e.target.value)}
              autoComplete="name"
              placeholder="Jane Doe"
            />
          </label>

          <SignatureCapture onChange={setSignature} />

          {submitError ? <MBanner tone="error" title={submitError} /> : null}

          <MButtonStack>
            <MButton variant="primary" onClick={handleAccept} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit acceptance'}
            </MButton>
            <MButton variant="quiet" onClick={() => setMode('idle')} disabled={submitting}>
              Cancel
            </MButton>
          </MButtonStack>
        </div>
      ) : null}

      {mode === 'declining' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Decline this estimate</h3>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--m-ink-3, #64748b)' }}>
            Optionally tell us why so we can follow up with adjustments.
          </p>
          <MTextarea
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            rows={4}
            placeholder="Reason"
            maxLength={2000}
          />

          {submitError ? <MBanner tone="error" title={submitError} /> : null}

          <MButtonStack>
            <MButton variant="primary" onClick={handleDecline} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit decline'}
            </MButton>
            <MButton variant="quiet" onClick={() => setMode('idle')} disabled={submitting}>
              Cancel
            </MButton>
          </MButtonStack>
        </div>
      ) : null}
    </Shell>
  )
}

function ReadOnlySnapshot({ view }: { view: PortalEstimateView }) {
  const lines = view.estimate.lines
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '12px 16px',
          background: '#f8fafc',
          border: '1px solid var(--m-line, #e2e8f0)',
          borderRadius: 12,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--m-ink-3, #64748b)' }}>
          Sent {formatDate(view.sent_at)} · expires {formatDate(view.expires_at)}
        </span>
        {view.recipient_name || view.recipient_email ? (
          <span style={{ fontSize: 13 }}>
            For: {view.recipient_name ? `${view.recipient_name} · ` : ''}
            <span style={{ color: 'var(--m-ink-3, #64748b)' }}>{view.recipient_email}</span>
          </span>
        ) : null}
      </header>

      <section
        style={{
          background: '#fff',
          border: '1px solid var(--m-line, #e2e8f0)',
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--m-line, #e2e8f0)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>Line items</span>
          <span style={{ fontSize: 12, color: 'var(--m-ink-3, #64748b)' }}>{lines.length} items</span>
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {lines.map((line) => (
            <li
              key={`${line.service_item_code}-${line.quantity}-${line.rate}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
                padding: '12px 16px',
                borderBottom: '1px solid var(--m-line, #e2e8f0)',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{line.service_item_code}</div>
                <div style={{ fontSize: 12, color: 'var(--m-ink-3, #64748b)' }}>
                  {line.quantity.toLocaleString()} {line.unit} × ${line.rate.toFixed(2)}
                </div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, textAlign: 'right' }}>
                ${line.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </li>
          ))}
        </ul>
        <div
          style={{
            padding: '14px 16px',
            display: 'flex',
            justifyContent: 'space-between',
            background: '#f8fafc',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>Total</span>
          <span style={{ fontSize: 18, fontWeight: 700 }}>
            $
            {view.estimate.bid_total.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
        </div>
      </section>
    </div>
  )
}

function Shell({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  // Force the light theme regardless of OS preference; the operator's
  // mobile shell switches to dark on some screens, but customer-facing
  // surfaces stay strictly light per the spec.
  return (
    <div data-theme="light" style={{ minHeight: '100vh', background: '#f1f5f9', color: '#0f172a' }}>
      <MTopBar title={title} sub={sub} />
      <MBody pad>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 12, paddingBottom: 32 }}>
          {children}
        </div>
      </MBody>
    </div>
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}
