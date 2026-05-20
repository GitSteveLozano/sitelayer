import { useParams } from 'react-router-dom'
import { MBanner, MBody, MTopBar } from '@/components/m'
import { usePortalEstimateLoad } from '@/machines/portal-estimate-load'
import { type PortalEstimateView } from './api'

/**
 * Confirmation screen the customer sees after a successful accept.
 *
 * Mirrors the EstimateView shell visually but without the Accept /
 * Decline CTAs. Fetches the share view so we can show the signer name
 * and the line totals as a record. If the customer revisits this URL
 * after the link expires, we still render the read-only view since
 * accept is terminal — the API keeps the row available even past
 * `expires_at` for accepted shares.
 *
 * State (load / view / error) lives in the `portalEstimateLoad`
 * XState machine; this component is a thin renderer.
 */
export function EstimateAcceptedView() {
  const { shareToken } = useParams<{ shareToken: string }>()
  const { view, error, isLoading } = usePortalEstimateLoad(shareToken ?? '')

  return (
    <div data-theme="light" style={{ minHeight: '100vh', background: '#f1f5f9', color: '#0f172a' }}>
      <MTopBar title="Estimate accepted" sub={view ? view.company_name : undefined} />
      <MBody pad>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 12, paddingBottom: 32 }}>
          {error ? <MBanner tone="error" title={error} /> : null}

          {view ? (
            <>
              <Hero view={view} />
              <Receipt view={view} />
            </>
          ) : isLoading ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--m-ink-3, #64748b)', fontSize: 14 }}>
              Loading…
            </div>
          ) : null}
        </div>
      </MBody>
    </div>
  )
}

function Hero({ view }: { view: PortalEstimateView }) {
  return (
    <section
      style={{
        background: '#ecfdf5',
        border: '1px solid #6ee7b7',
        borderRadius: 14,
        padding: '20px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 14, color: '#065f46', fontWeight: 600 }}>You accepted this estimate.</div>
      <div style={{ fontSize: 12, color: '#065f46' }}>
        {view.signer_name ? `Signed by ${view.signer_name}` : 'Acceptance recorded'}
        {view.accepted_at ? ` · ${formatDate(view.accepted_at)}` : ''}
      </div>
      <div style={{ fontSize: 12, color: '#065f46' }}>{view.company_name} will be in touch about next steps.</div>
    </section>
  )
}

function Receipt({ view }: { view: PortalEstimateView }) {
  const lines = view.estimate.lines
  return (
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
        <span style={{ fontSize: 13, fontWeight: 600 }}>{view.project_name}</span>
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
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}
