/**
 * Mobile estimate review. Shows the project's estimate lines + totals
 * with a send CTA. Sourced from /api/projects/:id/summary which is
 * already populated server-side.
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet, type ProjectSummary } from '@/lib/api'
import { createEstimatePush } from '../../lib/api/estimate-pushes.js'
import {
  MBody,
  MButton,
  MButtonStack,
  MI,
  MKpi,
  MKpiRow,
  MPill,
  MListInset,
  MListRow,
  MSectionH,
  MTopBar,
} from '../../components/m/index.js'
import { MAiStripe } from '../../components/m/ai.js'
import { MSkeletonList } from '../../components/m-states/index.js'
import { formatMoney } from './format.js'

export function MobileEstimateReview({ companySlug }: { companySlug: string }) {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creatingPush, setCreatingPush] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const handleSendToClient = async () => {
    if (!projectId) return
    setCreatingPush(true)
    setCreateError(null)
    try {
      const result = await createEstimatePush(projectId)
      const pushId = result.kind === 'created' ? result.pushId : result.openId
      navigate(`/projects/${projectId}/estimate-push/${pushId}`)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreatingPush(false)
    }
  }

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    apiGet<ProjectSummary>(`/api/projects/${projectId}/summary`, companySlug)
      .then((s) => {
        if (cancelled) return
        setSummary(s)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, companySlug])

  if (error) {
    return (
      <>
        <MTopBar back title="Estimate" onBack={() => navigate(`/projects/${projectId}`)} />
        <MBody>
          <div style={{ padding: 24, color: 'var(--m-red)', fontSize: 13 }}>{error}</div>
        </MBody>
      </>
    )
  }
  if (!summary) {
    return (
      <>
        <MTopBar back title="Estimate" onBack={() => navigate(`/projects/${projectId}`)} />
        <MBody>
          <MSkeletonList count={5} />
        </MBody>
      </>
    )
  }

  const m = summary.metrics
  const lines = summary.estimateLines

  return (
    <>
      <MTopBar back title="Estimate" sub={summary.project.name} onBack={() => navigate(`/projects/${projectId}`)} />
      <MBody>
        <MKpiRow cols={2}>
          <MKpi label="Total" value={formatMoney(m.estimateTotal)} />
          <MKpi
            label="Margin"
            value={`${(m.margin.margin * 100).toFixed(0)}%`}
            meta={formatMoney(m.margin.profit)}
            metaTone={m.margin.margin > 0.18 ? 'green' : m.margin.margin > 0.1 ? 'amber' : 'red'}
          />
        </MKpiRow>
        <div style={{ padding: '0 16px', marginTop: 12 }}>
          <MAiStripe
            eyebrow="Bid accuracy"
            title="This estimate is in line with comparable jobs"
            attribution={
              <>
                Based on <strong>historical close rate</strong>.
              </>
            }
          >
            Labor cost {formatMoney(m.laborCost)} · materials {formatMoney(m.materialCost)} · subs{' '}
            {formatMoney(m.subCost)}.
          </MAiStripe>
        </div>
        <MSectionH>Line items</MSectionH>
        {lines.length === 0 ? (
          <div style={{ padding: '0 16px', color: 'var(--m-ink-3)', fontSize: 13 }}>
            No line items yet. Run takeoff first, then recompute the estimate.
          </div>
        ) : (
          <>
            <EstimateScopeTree lines={lines} />
            <MSectionH>Builder</MSectionH>
            <MListInset>
              {lines.map((line, i) => (
                <MListRow
                  key={`${line.service_item_code}-${i}`}
                  leading={<MI.FileText size={18} />}
                  headline={line.service_item_code}
                  supporting={`${line.quantity} ${line.unit} @ ${formatMoney(Number(line.rate))}`}
                  trailing={<span className="num">{formatMoney(Number(line.amount))}</span>}
                />
              ))}
            </MListInset>
          </>
        )}
        {createError ? (
          <div style={{ padding: '0 16px', color: 'var(--m-red)', fontSize: 13 }}>{createError}</div>
        ) : null}
        <div style={{ padding: 16 }}>
          <MButtonStack>
            <MButton variant="primary" onClick={handleSendToClient} disabled={creatingPush || lines.length === 0}>
              {creatingPush ? 'Drafting…' : 'Send to client'}
            </MButton>
            <MButton variant="ghost" onClick={() => navigate(`/projects/${projectId}`)}>
              Back to project
            </MButton>
          </MButtonStack>
        </div>
      </MBody>
    </>
  )
}

function EstimateScopeTree({ lines }: { lines: ProjectSummary['estimateLines'] }) {
  const groups = new Map<string, { count: number; amount: number }>()
  for (const line of lines) {
    const group = line.service_item_code.split(/[-_.]/)[0] || line.service_item_code
    const cur = groups.get(group) ?? { count: 0, amount: 0 }
    cur.count += 1
    cur.amount += Number(line.amount ?? 0)
    groups.set(group, cur)
  }

  return (
    <>
      <MSectionH>Scope tree</MSectionH>
      <div style={{ padding: '0 16px 12px', display: 'grid', gap: 8 }}>
        {Array.from(groups.entries()).map(([group, value]) => (
          <div
            key={group}
            className="m-card m-card-tight"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
          >
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{group}</div>
              <div className="m-quiet-sm">{value.count} line items</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="num" style={{ fontSize: 13, color: 'var(--m-ink-2)' }}>
                {formatMoney(value.amount)}
              </span>
              <MPill tone="accent">priced</MPill>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
