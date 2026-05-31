import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import {
  estimatePushLineRate,
  estimatePushLineUnit,
  createSupportPacket,
  getActiveCompanySlug,
  type EstimatePushHumanEvent,
} from '@/lib/api'
import { useEstimatePush } from '@/machines/estimate-push'
import {
  isEstimatePushProbeDiagnosticsEnabled,
  registerEstimatePushProbeDiagnostics,
  useEstimatePushProbe,
} from '@/lib/probe/estimate-push'

const TONE_BY_STATE: Record<string, 'good' | 'warn' | 'default'> = {
  drafted: 'default',
  reviewed: 'default',
  approved: 'default',
  posting: 'warn',
  posted: 'good',
  failed: 'warn',
  voided: 'default',
}

export function EstimatePushDetailScreen() {
  const { id } = useParams<{ id: string }>()
  // Re-pointed onto the canonical headless XState machine (the same hook
  // mobile/estimate-push.tsx uses). The machine owns loading/submitting +
  // the outOfSync 409-reload orchestration this screen previously lacked.
  const { snapshot, error, outOfSync, isLoading, isSubmitting, dispatch, dismissError } = useEstimatePush(
    id ?? '',
    getActiveCompanySlug(),
  )
  const [supportPacketStatus, setSupportPacketStatus] = useState<string | null>(null)
  const [supportPacketBusy, setSupportPacketBusy] = useState(false)
  // ADR-0019 page-context Probe. Mounted unconditionally so hook order
  // stays stable across the early-return branches below. The hook is
  // a no-op when `id` is empty and tolerates a null snapshot.
  const capture = useEstimatePushProbe(id ?? '', snapshot ?? null)

  useEffect(() => {
    if (!id || !isEstimatePushProbeDiagnosticsEnabled()) return
    return registerEstimatePushProbeDiagnostics(capture)
  }, [id, capture])

  if (!id) {
    return (
      <div className="px-5 pt-8">
        <Link to="/financial/estimate-pushes" className="text-accent text-[13px] font-medium">
          ← back
        </Link>
      </div>
    )
  }

  if (isLoading && !snapshot) {
    return <div className="px-5 pt-8 text-[13px] text-ink-3">Loading push…</div>
  }
  if (!snapshot) {
    return (
      <div className="px-5 pt-8">
        <h1 className="font-display text-[22px] font-bold tracking-tight">Push not found</h1>
        {error ? <div className="text-[12px] text-warn mt-2">{error}</div> : null}
        <Link to="/financial/estimate-pushes" className="text-accent text-[13px] font-medium">
          ← back
        </Link>
      </div>
    )
  }

  const ctx = snapshot.context
  const lines = ctx.lines ?? []

  const onEvent = (event: EstimatePushHumanEvent) => {
    // The machine reads state_version off the stored snapshot itself and
    // flips outOfSync on a 409 (reloading the fresh snapshot), so the
    // screen no longer threads the version or try/catches.
    dispatch(event)
  }

  const onCreateSupportPacket = async () => {
    const problem = window.prompt('Problem to attach to this support packet?', 'Estimate push issue')
    if (problem === null) return
    setSupportPacketBusy(true)
    setSupportPacketStatus(null)
    try {
      const packet = await createSupportPacket({
        problem,
        client: capture(),
      })
      setSupportPacketStatus(`Support packet ${packet.support_id}`)
    } catch (e) {
      setSupportPacketStatus(e instanceof Error ? e.message : 'Support packet failed')
    } finally {
      setSupportPacketBusy(false)
    }
  }

  const showProbeControls = import.meta.env.DEV || isEstimatePushProbeDiagnosticsEnabled()

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/financial/estimate-pushes" className="text-[12px] text-ink-3">
        ← Estimate pushes
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] font-bold tracking-tight leading-tight">
            ${Number(ctx.subtotal).toLocaleString()}
          </h1>
          <div className="text-[11px] text-ink-3 mt-1">
            v{snapshot.state_version} · {lines.length} line{lines.length === 1 ? '' : 's'}
            {ctx.qbo_estimate_id ? ` · QBO #${ctx.qbo_estimate_id}` : ''}
          </div>
        </div>
        <Pill tone={TONE_BY_STATE[snapshot.state] ?? 'default'}>{snapshot.state}</Pill>
      </div>

      {outOfSync ? (
        <Card tight className="mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Out of sync</div>
          <div className="text-[12px] text-ink-2 mt-1">
            Your action was against a stale state — this is the current state. Review and retry.
          </div>
          <MobileButton variant="ghost" className="mt-2" onClick={dismissError}>
            Dismiss
          </MobileButton>
        </Card>
      ) : null}

      {ctx.error ? (
        <Card tight className="mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Error</div>
          <div className="text-[12px] text-ink-2 mt-1">{ctx.error}</div>
        </Card>
      ) : null}

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Line items</div>
        {lines.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No lines.</div>
          </Card>
        ) : (
          lines.map((line) => {
            const unit = estimatePushLineUnit(line)
            const rate = estimatePushLineRate(line)
            return (
              <Card key={line.id} tight>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold truncate">{line.description}</div>
                    <div className="text-[11px] text-ink-3 mt-0.5">
                      {Number(line.quantity).toFixed(2)}
                      {unit ? ` ${unit}` : ''} × ${Number(rate).toFixed(2)}
                      {line.service_item_code ? ` · ${line.service_item_code}` : ''}
                    </div>
                  </div>
                  <div className="text-[13px] font-semibold num">${Number(line.amount).toFixed(2)}</div>
                </div>
              </Card>
            )
          })
        )}
      </div>

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Trail</div>
        <Card tight>
          <Trail label="Reviewed" at={ctx.reviewed_at} by={ctx.reviewed_by} />
          <Trail label="Approved" at={ctx.approved_at} by={ctx.approved_by} />
          <Trail label="Posted" at={ctx.posted_at} by={null} />
          <Trail label="Failed" at={ctx.failed_at} by={null} />
        </Card>
      </div>

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Actions</div>
        {snapshot.next_events.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Terminal state — no further actions.</div>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {snapshot.next_events.map((ev) => (
              <MobileButton
                key={ev.type}
                variant={ev.type === 'VOID' ? 'ghost' : 'primary'}
                disabled={isSubmitting}
                onClick={() => onEvent(ev.type)}
              >
                {ev.label}
              </MobileButton>
            ))}
          </div>
        )}
        {error && !outOfSync ? <div className="text-[12px] text-warn">{error}</div> : null}
      </div>

      <div className="mt-4">
        <Attribution source="GET /api/estimate-pushes/:id · POST /:id/events" />
      </div>

      {showProbeControls ? (
        <div className="mt-4 space-y-2">
          <MobileButton
            variant="ghost"
            onClick={() => {
              const c = capture()
              console.log('[ADR-0019 Capture]', c)
              console.log('[ADR-0019 Capture JSON]', JSON.stringify(c, null, 2))
            }}
          >
            Inspect Capture (dev)
          </MobileButton>
          <MobileButton variant="ghost" disabled={supportPacketBusy} onClick={onCreateSupportPacket}>
            Create Support Packet
          </MobileButton>
          {supportPacketStatus ? <div className="text-[12px] text-ink-3">{supportPacketStatus}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

function Trail({ label, at, by }: { label: string; at: string | null; by: string | null }) {
  return (
    <div className="flex items-center justify-between text-[12px] py-1">
      <div className="text-ink-3">{label}</div>
      <div className="text-ink-2">
        {at
          ? new Date(at).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })
          : '—'}
        {by ? ` · ${by}` : ''}
      </div>
    </div>
  )
}
