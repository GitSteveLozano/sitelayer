/**
 * Quick invoice — `mb-invoice-quick`. Mobile companion for the desktop
 * invoice flow. Picks a project + amount + memo, hands off to the QBO
 * push pipeline. For Phase 9 we surface the form and bridge to the
 * desktop estimate-pushes route on submit since the full server invoice
 * surface still routes through QBO mappings.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { MBody, MButton, MButtonStack, MInput, MTextarea, MTopBar } from '../../components/m/index.js'
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
      <MBody>
        {/* MILESTONE / PROJECT SELECTOR — square option rows, accent fill on the
            selected one (drives the same setProjectId state the <select> did). */}
        <div className="m-section-h" style={{ borderBottom: '2px solid var(--m-ink)' }}>
          Project · pick one
        </div>
        <div style={{ padding: '14px 16px' }}>
          {projects.map((p) => {
            const active = p.id === projectId
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setProjectId(p.id)}
                aria-pressed={active}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 14px',
                  marginBottom: 8,
                  border: '2px solid var(--m-ink)',
                  cursor: 'pointer',
                  background: active ? 'var(--m-accent)' : 'transparent',
                  color: active ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                }}
              >
                <span style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 14 }}>{p.name}</span>
                <span className="num" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', opacity: 0.75 }}>
                  {active ? '● BILLING THIS' : '○ TAP TO BILL'}
                </span>
              </button>
            )
          })}
        </div>

        {/* AMOUNT entry feeds the THIS INVOICE big-number below. */}
        <div className="m-section-h" style={{ borderBottom: '2px solid var(--m-ink)' }}>
          Amount
        </div>
        <div style={{ padding: '14px 16px' }}>
          <MInput
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
            style={{ width: '100%' }}
            placeholder="0.00"
          />
        </div>

        {/* THIS INVOICE — the big-number hero. */}
        <div className="m-section-h" style={{ borderBottom: '2px solid var(--m-ink)' }}>
          This invoice
        </div>
        <div
          style={{
            padding: '18px 16px',
            background: 'var(--m-card-soft)',
            borderBottom: '2px solid var(--m-ink)',
          }}
        >
          <div
            className="num"
            style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--m-ink-3)' }}
          >
            {project ? `BILLING NOW · ${project.name.toUpperCase()}` : 'PICK A PROJECT TO BILL'}
          </div>
          <div
            className="num"
            style={{
              fontFamily: 'var(--m-font-display)',
              fontSize: 52,
              fontWeight: 800,
              letterSpacing: '-0.035em',
              marginTop: 8,
              lineHeight: 0.9,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {amount ? formatMoney(amount) : '$0'}
          </div>
          <div
            className="num"
            style={{ marginTop: 8, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--m-ink-2)' }}
          >
            {amount ? 'NET 30 · STRIPE LINK INCLUDED' : 'ENTER THE MILESTONE AMOUNT'}
          </div>
        </div>

        {/* MEMO. */}
        <div className="m-section-h" style={{ borderBottom: '2px solid var(--m-ink)' }}>
          Memo
        </div>
        <div style={{ padding: '14px 16px' }}>
          <MTextarea
            value={memo}
            onChange={(e) => setMemo(e.currentTarget.value)}
            style={{ width: '100%', minHeight: 90 }}
            placeholder="Milestone description (e.g., 50% complete — east elevation)"
          />
        </div>

        <div style={{ padding: 16 }}>
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
