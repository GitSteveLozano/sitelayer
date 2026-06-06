import { MListInset, MListRow, MSectionH } from '../m/index.js'
import type { ContextWorkItem, WorkRequestSupportPacketSummary } from '@/lib/api'

export function WorkRequestContextPreview({
  workItem,
  supportPacket,
}: {
  workItem: ContextWorkItem
  supportPacket?: WorkRequestSupportPacketSummary | null
}) {
  return (
    <>
      <MSectionH>Context</MSectionH>
      <MListInset>
        <MListRow headline="Route" supporting={workItem.route || supportPacket?.route || 'unknown'} />
        {workItem.entity_type || workItem.entity_id ? (
          <MListRow headline={workItem.entity_type || 'Entity'} supporting={workItem.entity_id || 'unknown'} />
        ) : null}
        <MListRow
          headline="Support packet"
          supporting={supportPacket?.id ?? workItem.support_packet_id}
          trailing={supportPacket?.expires_at ? <span>expires {formatDateTime(supportPacket.expires_at)}</span> : null}
        />
        {supportPacket?.request_id ? <MListRow headline="Request" supporting={supportPacket.request_id} /> : null}
      </MListInset>
    </>
  )
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
