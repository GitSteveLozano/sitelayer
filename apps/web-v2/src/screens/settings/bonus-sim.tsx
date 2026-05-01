import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { Attribution, Spark, StripeCard } from '@/components/ai'
import { simulateBonusScenario, type BonusTier } from '@sitelayer/domain'
import { useBonusRules } from '@/lib/api'

/**
 * Bonus simulator (Phase 6 Batch 5). Pure-client what-if compute on
 * top of the active bonus-rule tiers + a hypothetical revenue/cost/
 * pool combination. The math lives in @sitelayer/domain.
 */
export function BonusSimulatorScreen() {
  const rules = useBonusRules()
  const activeRules = (rules.data?.bonusRules ?? []).filter((r) => r.is_active)
  const [ruleId, setRuleId] = useState<string>(activeRules[0]?.id ?? '')
  const [revenue, setRevenue] = useState<string>('100000')
  const [cost, setCost] = useState<string>('70000')
  const [pool, setPool] = useState<string>('5000')

  // Default-pick the first active rule when the list resolves.
  const selectedRule = activeRules.find((r) => r.id === ruleId) ?? activeRules[0] ?? null
  const tiers = useMemo<readonly BonusTier[]>(() => {
    if (!selectedRule) return []
    const config = selectedRule.config as { tiers?: unknown } | null
    if (!config || !Array.isArray(config.tiers)) return []
    return (config.tiers as Array<{ minMargin?: unknown; payoutPercent?: unknown }>)
      .map((t) => ({
        minMargin: Number(t.minMargin),
        payoutPercent: Number(t.payoutPercent),
      }))
      .filter((t) => Number.isFinite(t.minMargin) && Number.isFinite(t.payoutPercent))
  }, [selectedRule])

  const result = useMemo(
    () =>
      simulateBonusScenario({
        revenue: Number(revenue) || 0,
        cost: Number(cost) || 0,
        bonus_pool: Number(pool) || 0,
        tiers,
      }),
    [revenue, cost, pool, tiers],
  )

  const marginPct = result.margin * 100
  const tone: 'good' | 'warn' | 'default' = result.eligible ? 'good' : marginPct < 0 ? 'warn' : 'default'

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more" className="text-[12px] text-ink-3">
        ← More
      </Link>
      <h1 className="mt-2 font-display text-[26px] font-bold tracking-tight leading-tight">Bonus simulator</h1>
      <p className="text-[12px] text-ink-3 mt-1">What-if modeling against an active bonus rule's tier schedule.</p>

      {activeRules.length === 0 ? (
        <Card tight className="mt-6">
          <div className="text-[12px] text-ink-3">
            No active bonus rules. Add one in{' '}
            <Link to="/more/catalog/bonus-rules" className="text-accent">
              Catalog → Bonus rules
            </Link>
            .
          </div>
        </Card>
      ) : (
        <div className="mt-6 space-y-3">
          <Card>
            <label className="block">
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Bonus rule</div>
              <select
                value={ruleId || activeRules[0]?.id || ''}
                onChange={(e) => setRuleId(e.target.value)}
                className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
              >
                {activeRules.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          </Card>

          <Card>
            <Field label="Revenue ($)" value={revenue} onChange={setRevenue} />
            <Field label="Cost ($)" value={cost} onChange={setCost} />
            <Field label="Bonus pool ($)" value={pool} onChange={setPool} />
          </Card>

          <StripeCard tone={result.eligible ? 'good' : 'accent'}>
            <div className="flex items-center gap-2 mb-1">
              <Spark state={result.eligible ? 'accent' : 'muted'} size={12} aria-label="" />
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Payout</div>
            </div>
            <div className="num text-[28px] font-bold tracking-tight">${result.payout.toLocaleString()}</div>
            <div className="text-[12px] text-ink-3 mt-1">
              margin {marginPct.toFixed(1)}% · profit ${result.profit.toLocaleString()} ·{' '}
              {(result.payout_percent * 100).toFixed(1)}% of pool
            </div>
            <div className="mt-2">
              <Pill tone={tone}>{result.eligible ? 'eligible' : marginPct < 0 ? 'loss' : 'below threshold'}</Pill>
            </div>
            {result.next_tier_threshold !== null ? (
              <div className="text-[11px] text-ink-3 mt-3 pt-2 border-t border-dashed border-line-2">
                Next tier at margin {(result.next_tier_threshold * 100).toFixed(0)}%
                {result.revenue_to_next_tier !== null
                  ? ` · need $${result.revenue_to_next_tier.toLocaleString()} more revenue at this cost`
                  : ''}
              </div>
            ) : null}
          </StripeCard>

          <Attribution source="Computed locally via @sitelayer/domain · simulateBonusScenario" />
        </div>
      )}
    </div>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block py-1">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <input
        type="number"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full text-[16px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
      />
    </label>
  )
}
