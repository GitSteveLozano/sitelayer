import type { BootstrapResponse } from '@/lib/api'
import { MI, MKpi, MKpiRow, MListInset, MListRow, MSectionH } from '../../../components/m/index.js'
import { formatMoney } from '../format.js'

export function MaterialsTab({ bills }: { bills: BootstrapResponse['materialBills'] }) {
  const total = bills.reduce((sum, b) => sum + Number(b.amount ?? 0), 0)
  if (bills.length === 0) {
    return (
      <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--m-ink-3)', fontSize: 13 }}>
        No material bills yet.
      </div>
    )
  }
  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ padding: '0 16px 12px' }}>
        <MKpiRow cols={2}>
          <MKpi label="Bills" value={String(bills.length)} />
          <MKpi label="Total" value={formatMoney(total)} />
        </MKpiRow>
      </div>
      <MSectionH>Recent bills</MSectionH>
      <MListInset>
        {bills.map((b) => (
          <MListRow
            key={b.id}
            leading={<MI.Truck size={18} />}
            headline={b.vendor ?? 'Unknown vendor'}
            supporting={b.occurred_on}
            trailing={<span className="num">{formatMoney(Number(b.amount ?? 0))}</span>}
          />
        ))}
      </MListInset>
    </div>
  )
}
