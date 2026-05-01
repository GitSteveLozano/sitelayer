import { Link } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { useQboConnection } from '@/lib/api'

/**
 * Integrations hub — currently only QBO. Other integrations (Stripe,
 * weather, etc.) will land here as separate cards as they ship.
 */
export function IntegrationsHubScreen() {
  const qbo = useQboConnection()
  const status = qbo.data?.connection?.status ?? 'disconnected'

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more" className="text-[12px] text-ink-3">
        ← More
      </Link>
      <h1 className="mt-2 font-display text-[26px] font-bold tracking-tight leading-tight">Integrations</h1>
      <p className="text-[12px] text-ink-3 mt-1">External systems that read or write Sitelayer data.</p>

      <div className="mt-6 space-y-3">
        <Link to="/more/integrations/qbo" className="block">
          <Card>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[14px] font-semibold">QuickBooks Online</div>
                <div className="text-[12px] text-ink-3 mt-0.5">
                  OAuth connection, sync status, customer / item / division mappings.
                </div>
              </div>
              <Pill tone={status === 'connected' ? 'good' : status === 'error' ? 'warn' : 'default'}>{status}</Pill>
            </div>
          </Card>
        </Link>
      </div>
    </div>
  )
}
