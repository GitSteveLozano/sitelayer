import { useMemo, useState } from 'react'
import { Card, MobileButton, Pill, Sheet } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { estimatePdfUrl, useScopeVsBid, type BidVsScopeStatus, type EstimateLine } from '@/lib/api'

/**
 * `est-summary` — Estimate draft for a project. Renders the
 * scope-vs-bid line items plus the bid-vs-scope status pill, plus a
 * "Send" CTA that opens the est-share bottom sheet.
 *
 * Phase 2C scope:
 *   - Read-only display of the existing estimate_lines (the recompute
 *     path is wired via the takeoff overhaul in Phase 3 — for now the
 *     foreman/estimator edits via the v1 SPA when scope changes).
 *   - PDF download link via /api/projects/:id/estimate.pdf.
 *   - est-share bottom sheet with copy-link + email handoff (the
 *     actual estimate-push QBO workflow lands in Phase 5 alongside the
 *     bid-accuracy AI surface).
 */
export function EstimateSummaryScreen({ projectId }: { projectId: string }) {
  const scope = useScopeVsBid(projectId)
  const [shareOpen, setShareOpen] = useState(false)

  if (scope.isPending) {
    return <Card tight><div className="text-[12px] text-ink-3">Loading estimate…</div></Card>
  }
  if (!scope.data) {
    return (
      <Card tight>
        <div className="text-[13px] font-semibold">No estimate yet</div>
        <div className="text-[11px] text-ink-3 mt-1">
          Draw a takeoff or add scope items to this project; the estimate appears here automatically.
        </div>
      </Card>
    )
  }

  const data = scope.data
  return (
    <div className="space-y-3">
      {/* Bid vs scope pill row. */}
      <Card>
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Estimate vs bid</span>
          <Pill tone={statusTone(data.status)}>{statusLabel(data.status)}</Pill>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-2">
          <div>
            <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3">Scope total</div>
            <div className="num text-[20px] font-bold mt-0.5">${data.scope_total.toLocaleString()}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3">Bid total</div>
            <div className="num text-[20px] font-bold mt-0.5">${data.bid_total.toLocaleString()}</div>
          </div>
        </div>
        <div className="mt-2 text-[12px] text-ink-2 leading-relaxed">
          {Math.abs(data.delta) < 0.01
            ? 'Scope matches bid — sign-off ready.'
            : data.delta > 0
              ? `Bid is $${data.delta.toLocaleString()} (${(data.delta_pct * 100).toFixed(1)}%) higher than scope.`
              : `Scope is $${Math.abs(data.delta).toLocaleString()} (${(data.delta_pct * 100).toFixed(1)}%) over bid.`}
        </div>
      </Card>

      {/* Line items. */}
      <Card>
        <div className="text-[13px] font-semibold mb-2">Line items</div>
        {data.lines.length === 0 ? (
          <div className="text-[12px] text-ink-3">No scope items yet. Draw a takeoff to populate.</div>
        ) : (
          <ul className="divide-y divide-line">
            {data.lines.map((line) => (
              <LineRow key={`${line.service_item_code}-${line.created_at}`} line={line} />
            ))}
          </ul>
        )}
      </Card>

      <Attribution source={`Live from /api/projects/${projectId.slice(0, 8)}…/estimate/scope-vs-bid`} />

      <div className="flex gap-2 pt-2">
        <MobileButton variant="primary" onClick={() => setShareOpen(true)}>
          Send estimate
        </MobileButton>
      </div>

      <ShareSheet open={shareOpen} onClose={() => setShareOpen(false)} projectId={projectId} />
    </div>
  )
}

function LineRow({ line }: { line: EstimateLine }) {
  const qty = Number(line.quantity)
  const rate = Number(line.rate)
  const amount = Number(line.amount)
  return (
    <li className="py-2 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium truncate">{line.service_item_code}</div>
        <div className="text-[11px] text-ink-3 num">
          {qty.toLocaleString()} {line.unit} × ${rate.toFixed(2)}
        </div>
      </div>
      <div className="num text-[13px] font-semibold text-right shrink-0">${amount.toLocaleString()}</div>
    </li>
  )
}

function ShareSheet({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: string }) {
  const [copied, setCopied] = useState(false)
  const pdfUrl = estimatePdfUrl(projectId)

  const onCopy = async () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(pdfUrl)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      } catch {
        // ignore — fallback handled inline below
      }
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Send estimate">
      <div className="text-[12px] text-ink-3 mb-4">
        Pick how the customer gets it. The PDF link is auth-required and only resolves for users on this
        company; share it via your usual channel for now (Phase 5 sends via the QBO estimate-push workflow).
      </div>
      <div className="space-y-2.5">
        <a
          href={pdfUrl}
          target="_blank"
          rel="noopener"
          className="block"
          onClick={() => onClose()}
        >
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-semibold">Open / Download PDF</div>
                <div className="text-[11px] text-ink-3 mt-0.5">Streamed from /api/projects/:id/estimate.pdf</div>
              </div>
              <span className="text-ink-4" aria-hidden="true">↗</span>
            </div>
          </Card>
        </a>

        <button type="button" onClick={onCopy} className="block w-full text-left">
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-semibold">{copied ? 'Copied!' : 'Copy PDF link'}</div>
                <div className="text-[11px] text-ink-3 mt-0.5 truncate">{pdfUrl}</div>
              </div>
              <span className="text-ink-4" aria-hidden="true">⎘</span>
            </div>
          </Card>
        </button>

        <Card>
          <div className="text-[13px] font-semibold">Email + QBO push</div>
          <div className="text-[11px] text-ink-3 mt-0.5">
            Phase 5 wires the estimate-pushes workflow + an email send.
          </div>
        </Card>
      </div>

      <div className="mt-4">
        <MobileButton variant="ghost" onClick={onClose}>
          Done
        </MobileButton>
      </div>
    </Sheet>
  )
}

function statusTone(status: BidVsScopeStatus): 'good' | 'warn' | 'bad' {
  if (status === 'ok') return 'good'
  if (status === 'warn') return 'warn'
  return 'bad'
}

function statusLabel(status: BidVsScopeStatus): string {
  if (status === 'ok') return 'matches'
  if (status === 'warn') return 'small drift'
  return 'mismatch'
}
