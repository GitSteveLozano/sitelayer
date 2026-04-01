// Core metrics engine — pure functions, no side effects
// Input: project object from DB
// Output: computed metrics for display

export function calcProject(project, laborEntries = []) {
  const laborHrs  = laborEntries.reduce((s, e) => s + (e.hours || 0), 0)
  const laborCost = laborHrs * (project.labor_rate || 38)
  const matCost   = project.material_cost || 0
  const subCost   = project.sub_cost || 0
  const totalCost = laborCost + matCost + subCost
  const bidTotal  = (project.sqft || 0) * (project.bid_psf || 0)
  const actPsf    = project.sqft > 0 && totalCost > 0
    ? totalCost / project.sqft : 0
  const psfVar    = actPsf > 0 ? actPsf - (project.bid_psf || 0) : null
  const margin    = bidTotal > 0 ? (bidTotal - totalCost) / bidTotal : null

  // Sqft/hr by service item
  const byItem = {}
  laborEntries.forEach(e => {
    if (!byItem[e.service_item]) byItem[e.service_item] = { hours: 0, sqft_done: 0 }
    byItem[e.service_item].hours     += e.hours || 0
    byItem[e.service_item].sqft_done += e.sqft_done || 0
  })

  const rates = Object.entries(byItem).map(([item, d]) => ({
    item,
    hours:     d.hours,
    sqft_done: d.sqft_done,
    rate:      d.hours > 0 ? d.sqft_done / d.hours : 0,
  }))

  const avgSqftHr    = rates.length
    ? rates.reduce((s, r) => s + r.rate, 0) / rates.length : 0

  const targetSqftHr = project.target_sqft_per_hr || 0
  const speedDelta   = targetSqftHr > 0
    ? (avgSqftHr - targetSqftHr) / targetSqftHr : 0

  const bonusFactor = Math.max(0, Math.min(1, 1 + speedDelta / 0.20))
  const bonusAmt    = (project.bonus_pool || 0) * bonusFactor

  // Progress: use max sqft_done across all entries, capped at total sqft
  // This handles cases where sqft_done > project.sqft (data entry error)
  const totalSqftDone = laborEntries.reduce((s, e) => s + (e.sqft_done || 0), 0)
  const sqftDone      = Math.min(totalSqftDone, project.sqft || 0)
  const pctComplete   = (project.sqft || 0) > 0 ? sqftDone / project.sqft : 0

  // At-risk: actPsf exceeds bid by more than threshold
  const threshold = project.risk_threshold || 0.50
  const isAtRisk  = psfVar !== null && psfVar > threshold

  // Risk level for color coding
  const riskLevel = !isAtRisk ? 'ok'
    : psfVar > threshold * 2   ? 'critical'
    : 'warning'

  return {
    laborHrs, laborCost, matCost, subCost, totalCost,
    bidTotal, actPsf, psfVar, margin,
    avgSqftHr, speedDelta, bonusFactor, bonusAmt,
    pctComplete, sqftDone, totalSqftDone, byItem: rates,
    isAtRisk, riskLevel, threshold,
  }
}

export const fmt = {
  money: n => `$${Math.abs(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  psf:   n => `$${(n || 0).toFixed(2)}/sqft`,
  pct:   n => `${((n || 0) * 100).toFixed(1)}%`,
  hrs:   n => `${(n || 0).toFixed(1)}h`,
  sqft:  n => `${(n || 0).toLocaleString()} sqft`,
}
