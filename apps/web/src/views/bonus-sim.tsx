import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_BONUS_RULE,
  formatMoney,
  simulateBonusScenario,
  type BonusTier,
} from '@sitelayer/domain'
import type { BonusRuleRow, BootstrapResponse, ProjectRow } from '../api.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Select } from '../components/ui/select.js'
import './bonus-sim.css'

type BonusSimViewProps = {
  bootstrap: BootstrapResponse | null
}

type SimMode = 'simulator' | 'project-pivot'

// Coerce a bonus rule row's JSON config into a concrete tier schedule. Falls
// back to DEFAULT_BONUS_RULE tiers if the payload shape is unexpected — the
// simulator should always have *some* tiers to show.
function tiersFromRule(rule: BonusRuleRow | undefined | null): BonusTier[] {
  const raw = rule?.config?.tiers
  if (Array.isArray(raw)) {
    const parsed: BonusTier[] = []
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue
      const minMargin = Number((entry as { minMargin?: unknown }).minMargin)
      const payoutPercent = Number((entry as { payoutPercent?: unknown }).payoutPercent)
      if (Number.isFinite(minMargin) && Number.isFinite(payoutPercent)) {
        parsed.push({ minMargin, payoutPercent })
      }
    }
    if (parsed.length > 0) return parsed
  }
  return [...DEFAULT_BONUS_RULE.tiers]
}

function pickActiveRule(rules: BonusRuleRow[]): BonusRuleRow | null {
  return rules.find((rule) => rule.is_active) ?? rules[0] ?? null
}

function parseMoney(value: string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(digits)}%`
}

export function BonusSimView({ bootstrap }: BonusSimViewProps) {
  const activeRule = useMemo(() => pickActiveRule(bootstrap?.bonusRules ?? []), [bootstrap?.bonusRules])
  const tiers = useMemo(() => tiersFromRule(activeRule), [activeRule])
  const sortedTiers = useMemo(() => [...tiers].sort((a, b) => a.minMargin - b.minMargin), [tiers])

  const [mode, setMode] = useState<SimMode>('simulator')
  const [revenue, setRevenue] = useState<number>(150_000)
  const [cost, setCost] = useState<number>(115_000)
  const [bonusPool, setBonusPool] = useState<number>(5_000)
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const [baseline, setBaseline] = useState<{
    revenue: number
    cost: number
    bonusPool: number
    projectName: string
  } | null>(null)

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])

  // When the user selects a project, seed sliders from that project's numbers
  // and record a baseline so we can show "(baseline was $X)" labels.
  useEffect(() => {
    if (mode !== 'project-pivot') return
    if (!selectedProjectId) return
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    const r = parseMoney(project.bid_total)
    // Project rows don't carry a precomputed cost; use bonus_pool + a reasonable
    // proxy. We'd normally pull from /summary, but for pivot-mode a sensible
    // starting point is to assume "cost ~= revenue * (1 - DEFAULT first tier)".
    // Callers can adjust. We pull bonus_pool directly.
    const bp = parseMoney(project.bonus_pool)
    // Derive a plausible starting cost: if the project has no known cost, we
    // assume the crew currently sits at the first-tier margin. This gives the
    // pivot slider something non-degenerate to drag from.
    const firstTierMargin = sortedTiers[0]?.minMargin ?? 0.15
    const startingCost = Math.max(0, Math.round(r * (1 - firstTierMargin)))
    setRevenue(r)
    setCost(startingCost)
    setBonusPool(bp)
    setBaseline({ revenue: r, cost: startingCost, bonusPool: bp, projectName: project.name })
  }, [mode, selectedProjectId, projects, sortedTiers])

  const result = useMemo(
    () =>
      simulateBonusScenario({
        revenue,
        cost,
        bonus_pool: bonusPool,
        tiers: sortedTiers,
      }),
    [revenue, cost, bonusPool, sortedTiers],
  )

  // Slider bounds. For simulator mode, use generous fixed ranges; for pivot
  // mode, anchor around the project baseline so dragging feels meaningful.
  const bounds = useMemo(() => {
    if (mode === 'project-pivot' && baseline) {
      return {
        revenue: { min: 0, max: Math.max(baseline.revenue * 2, 50_000), step: 500 },
        cost: { min: 0, max: Math.max(baseline.cost * 2, baseline.revenue, 50_000), step: 500 },
        bonusPool: { min: 0, max: Math.max(baseline.bonusPool * 3, 10_000), step: 100 },
      }
    }
    return {
      revenue: { min: 0, max: 500_000, step: 1_000 },
      cost: { min: 0, max: 500_000, step: 1_000 },
      bonusPool: { min: 0, max: 50_000, step: 100 },
    }
  }, [mode, baseline])

  const costDelta = baseline ? cost - baseline.cost : 0
  const payoutDelta =
    baseline !== null
      ? result.payout -
        simulateBonusScenario({
          revenue: baseline.revenue,
          cost: baseline.cost,
          bonus_pool: baseline.bonusPool,
          tiers: sortedTiers,
        }).payout
      : 0

  return (
    <section className="panel">
      <h2>Bonus Simulator</h2>
      <p className="muted">
        What-if payout modelling for division margin bonuses. Drag the sliders to explore outcomes, or pivot from an
        existing project to see how shaving cost (or booking more revenue) moves the crew into the next tier.
      </p>

      <div className="bonusSimModes" role="tablist" aria-label="Simulator mode">
        <Button
          type="button"
          role="tab"
          variant={mode === 'simulator' ? 'default' : 'secondary'}
          size="sm"
          aria-pressed={mode === 'simulator'}
          onClick={() => setMode('simulator')}
          data-testid="bonus-sim-mode-simulator"
        >
          Simulator
        </Button>
        <Button
          type="button"
          role="tab"
          variant={mode === 'project-pivot' ? 'default' : 'secondary'}
          size="sm"
          aria-pressed={mode === 'project-pivot'}
          onClick={() => setMode('project-pivot')}
          data-testid="bonus-sim-mode-project-pivot"
        >
          Project pivot
        </Button>
      </div>

      {mode === 'project-pivot' ? (
        <div className="bonusSimProjectSelect">
          <label htmlFor="bonus-sim-project">Pivot from project</label>
          <Select
            id="bonus-sim-project"
            data-testid="bonus-sim-project-select"
            value={selectedProjectId}
            onChange={(event) => setSelectedProjectId(event.target.value)}
          >
            <option value="">— pick a project —</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {formatProjectLabel(project)}
              </option>
            ))}
          </Select>
          {baseline ? (
            <p className="bonusSimBaseline">
              Baseline: {baseline.projectName} · revenue {formatMoney(baseline.revenue)} · cost{' '}
              {formatMoney(baseline.cost)} · pool {formatMoney(baseline.bonusPool)}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="bonusSimGrid">
        <div className="bonusSimFields">
          <Slider
            id="bonus-sim-revenue"
            label="Revenue"
            value={revenue}
            min={bounds.revenue.min}
            max={bounds.revenue.max}
            step={bounds.revenue.step}
            onChange={setRevenue}
            format={formatMoney}
            testId="bonus-sim-revenue"
          />
          <Slider
            id="bonus-sim-cost"
            label="Cost"
            value={cost}
            min={bounds.cost.min}
            max={bounds.cost.max}
            step={bounds.cost.step}
            onChange={setCost}
            format={formatMoney}
            testId="bonus-sim-cost"
          />
          <Slider
            id="bonus-sim-pool"
            label="Bonus pool"
            value={bonusPool}
            min={bounds.bonusPool.min}
            max={bounds.bonusPool.max}
            step={bounds.bonusPool.step}
            onChange={setBonusPool}
            format={formatMoney}
            testId="bonus-sim-pool"
          />
          <div className="bonusSimTierList" aria-label="Tier schedule">
            {sortedTiers.map((tier) => {
              const active = result.eligible && result.payout_percent === tier.payoutPercent && result.margin >= tier.minMargin
              return (
                <div key={`${tier.minMargin}-${tier.payoutPercent}`} className={`tier${active ? ' active' : ''}`}>
                  <span>≥ {formatPercent(tier.minMargin, 0)} margin</span>
                  <span>{active ? '← current' : ''}</span>
                  <span>pays {formatPercent(tier.payoutPercent, 0)}</span>
                </div>
              )
            })}
          </div>
        </div>

        <div>
          <PayoutChart tiers={sortedTiers} bonusPool={bonusPool} margin={result.margin} payout={result.payout} />
          <div className="bonusSimResults" role="status" aria-live="polite">
            <dl>
              <dt>Margin</dt>
              <dd data-testid="bonus-sim-margin">{formatPercent(result.margin, 2)}</dd>
              <dt>Profit</dt>
              <dd data-testid="bonus-sim-profit">{formatMoney(result.profit)}</dd>
              <dt>Payout %</dt>
              <dd data-testid="bonus-sim-payout-percent">{formatPercent(result.payout_percent, 2)}</dd>
              <dt>Payout</dt>
              <dd className="highlight" data-testid="bonus-sim-payout">
                {result.eligible ? formatMoney(result.payout) : 'Not eligible'}
              </dd>
            </dl>
            {result.next_tier_threshold === null ? (
              <div className="bonusSimNextTier topped" data-testid="bonus-sim-next-tier">
                Top tier reached — no higher payout available at current pool.
              </div>
            ) : (
              <div className="bonusSimNextTier" data-testid="bonus-sim-next-tier">
                Next tier at {formatPercent(result.next_tier_threshold, 0)} margin
                {result.revenue_to_next_tier !== null
                  ? ` — need ${formatMoney(result.revenue_to_next_tier)} more revenue at this cost.`
                  : ' — set a non-zero cost to see the revenue gap.'}
              </div>
            )}
            {mode === 'project-pivot' && baseline ? (
              <p className="bonusSimBaseline" data-testid="bonus-sim-pivot-delta">
                Cost {costDelta >= 0 ? '+' : '-'}
                {formatMoney(Math.abs(costDelta))} vs baseline → payout {payoutDelta >= 0 ? '+' : '-'}
                {formatMoney(Math.abs(payoutDelta))}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}

function formatProjectLabel(project: ProjectRow): string {
  const bid = parseMoney(project.bid_total)
  return `${project.name} · ${project.division_code} · ${formatMoney(bid)}`
}

type SliderProps = {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (next: number) => void
  format: (value: number) => string
  testId: string
}

function Slider({ id, label, value, min, max, step, onChange, format, testId }: SliderProps) {
  return (
    <div className="bonusSimField">
      <label htmlFor={id}>
        <span>{label}</span>
        <span className="value">{format(value)}</span>
      </label>
      <Input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        data-testid={testId}
        className="bonusSimRangeInput"
        onChange={(event) => {
          const next = Number(event.target.value)
          onChange(Number.isFinite(next) ? next : 0)
        }}
      />
    </div>
  )
}

type PayoutChartProps = {
  tiers: readonly BonusTier[]
  bonusPool: number
  margin: number
  payout: number
}

// Hand-rolled SVG chart: payout ($) as a function of margin (%). Tier changes
// produce vertical jumps — a classic step function — so we draw the path as
// horizontal segments joined by vertical risers, similar to how commission
// curves are visualized. No deps; small enough to inline.
function PayoutChart({ tiers, bonusPool, margin, payout }: PayoutChartProps) {
  const width = 480
  const height = 220
  const padding = { top: 16, right: 16, bottom: 36, left: 56 }
  const plotW = width - padding.left - padding.right
  const plotH = height - padding.top - padding.bottom

  // x domain: 0 → max tier threshold + 10 percentage points (or 0.4 floor).
  const maxTierMargin = tiers.reduce((acc, tier) => Math.max(acc, tier.minMargin), 0)
  const xMax = Math.max(0.4, maxTierMargin + 0.1)
  // y domain: 0 → largest possible payout at this pool, with a 10% headroom.
  const maxTierPayoutPct = tiers.reduce((acc, tier) => Math.max(acc, tier.payoutPercent), 0)
  const yMax = Math.max(1, bonusPool * maxTierPayoutPct * 1.1)

  const xFromMargin = (m: number) => padding.left + (Math.min(Math.max(m, 0), xMax) / xMax) * plotW
  const yFromPayout = (p: number) => padding.top + plotH - (Math.min(Math.max(p, 0), yMax) / yMax) * plotH

  // Build the step-function path. Start at (0, 0); for each ascending tier,
  // draw a horizontal segment to the tier threshold at the previous payout,
  // then a vertical riser up to the new tier's payout.
  const sorted = [...tiers].sort((a, b) => a.minMargin - b.minMargin)
  const pathPoints: Array<{ x: number; y: number }> = []
  pathPoints.push({ x: xFromMargin(0), y: yFromPayout(0) })
  let currentPayout = 0
  for (const tier of sorted) {
    const tierPayout = bonusPool * tier.payoutPercent
    // Horizontal to this tier's threshold at the old payout.
    pathPoints.push({ x: xFromMargin(tier.minMargin), y: yFromPayout(currentPayout) })
    // Vertical riser to the new payout.
    pathPoints.push({ x: xFromMargin(tier.minMargin), y: yFromPayout(tierPayout) })
    currentPayout = tierPayout
  }
  // Extend horizontally to the right edge of the chart.
  pathPoints.push({ x: xFromMargin(xMax), y: yFromPayout(currentPayout) })

  const pathD = pathPoints.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ')

  // x-axis ticks at 0, 10%, 20%, 30%, 40% (and any extra tier thresholds).
  const xTicks = new Set<number>([0, 0.1, 0.2, 0.3, 0.4].filter((t) => t <= xMax))
  for (const tier of sorted) xTicks.add(tier.minMargin)
  const xTickList = [...xTicks].sort((a, b) => a - b)

  // y-axis ticks: 0, 25%, 50%, 75%, 100% of yMax.
  const yTickList = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ratio * yMax)

  const currentX = xFromMargin(margin)
  const currentY = yFromPayout(payout)

  return (
    <svg
      className="bonusSimChart"
      role="img"
      aria-label="Payout versus margin chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      data-testid="bonus-sim-chart"
    >
      {/* axes */}
      <line className="axis" x1={padding.left} x2={padding.left} y1={padding.top} y2={padding.top + plotH} />
      <line
        className="axis"
        x1={padding.left}
        x2={padding.left + plotW}
        y1={padding.top + plotH}
        y2={padding.top + plotH}
      />

      {/* tier tick lines */}
      {sorted.map((tier) => (
        <line
          key={`tier-${tier.minMargin}`}
          className="tierTick"
          x1={xFromMargin(tier.minMargin)}
          x2={xFromMargin(tier.minMargin)}
          y1={padding.top}
          y2={padding.top + plotH}
        />
      ))}

      {/* x labels */}
      {xTickList.map((tick) => (
        <text key={`xt-${tick}`} className="label" x={xFromMargin(tick)} y={padding.top + plotH + 18} textAnchor="middle">
          {formatPercent(tick, 0)}
        </text>
      ))}

      {/* y labels */}
      {yTickList.map((tick) => (
        <text key={`yt-${tick}`} className="label" x={padding.left - 8} y={yFromPayout(tick) + 4} textAnchor="end">
          {formatMoney(tick)}
        </text>
      ))}

      {/* payout curve */}
      <path className="payoutLine" d={pathD} />

      {/* current position marker */}
      <circle className="currentDot" cx={currentX} cy={currentY} r={6} data-testid="bonus-sim-chart-current" />
      <text
        className="currentLabel"
        x={Math.min(currentX + 8, padding.left + plotW - 4)}
        y={Math.max(currentY - 10, padding.top + 12)}
        textAnchor="start"
      >
        {formatMoney(payout)} @ {formatPercent(margin, 1)}
      </text>
    </svg>
  )
}
