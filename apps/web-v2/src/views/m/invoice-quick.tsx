/**
 * Quick invoice — `mb-invoice-quick`. Mobile companion for the desktop
 * invoice flow. Picks a project + amount + memo, hands off to the QBO
 * push pipeline. For Phase 9 we surface the form and bridge to the
 * desktop estimate-pushes route on submit since the full server invoice
 * surface still routes through QBO mappings.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '../../api-v1-compat.js'
import {
  MBody,
  MButton,
  MButtonStack,
  MInput,
  MSectionH,
  MSelect,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'
import { formatMoney } from './format.js'

export function MobileQuickInvoice({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const projects = bootstrap?.projects ?? []
  const [projectId, setProjectId] = useState<string>(() => projects[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')

  const project = projects.find((p) => p.id === projectId)

  return (
    <>
      <MTopBar back title="Quick invoice" onBack={() => navigate('/today')} />
      <MBody pad>
        <MSectionH>Project</MSectionH>
        <MSelect value={projectId} onChange={(e) => setProjectId(e.currentTarget.value)} style={{ width: '100%' }}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </MSelect>
        <MSectionH>Amount</MSectionH>
        <MInput
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.currentTarget.value)}
          style={{ width: '100%' }}
          placeholder="0.00"
        />
        <div className="m-quiet-sm" style={{ marginTop: 4 }}>
          {amount ? `${formatMoney(amount)} net 30` : 'Enter the milestone amount'}
        </div>
        <MSectionH>Memo</MSectionH>
        <MTextarea
          value={memo}
          onChange={(e) => setMemo(e.currentTarget.value)}
          style={{ width: '100%', minHeight: 90 }}
          placeholder="Milestone description (e.g., 50% complete — east elevation)"
        />
        <div style={{ marginTop: 16 }}>
          <MButtonStack>
            <MButton
              variant="primary"
              disabled={!project || !amount}
              onClick={() => navigate(`/projects/${project?.id}`)}
            >
              Send invoice
            </MButton>
            <MButton variant="ghost" onClick={() => navigate('/today')}>
              Cancel
            </MButton>
          </MButtonStack>
        </div>
      </MBody>
    </>
  )
}
