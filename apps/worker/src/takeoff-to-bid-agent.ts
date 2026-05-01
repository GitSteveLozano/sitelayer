import type { PoolClient } from 'pg'

/**
 * Phase 5: takeoff → bid agent.
 *
 * The full agent uses the Anthropic SDK to read takeoff_measurements +
 * existing service_items + assemblies and propose bid line items with
 * a confidence rationale. This module is the *worker handler* that
 * drains rows from `mutation_outbox` with `mutation_type = 'takeoff_to_bid'`
 * and writes the agent's output back into `ai_insights`.
 *
 * Today's implementation stubs the LLM hop with a deterministic
 * mapping (one bid line per measurement at the catalog rate) so the
 * end-to-end pipeline — trigger endpoint → outbox → worker → insights
 * → UI render — is exercised without an API key. Swapping in the real
 * Anthropic call is a one-function change inside `proposeBidLines`;
 * the surrounding outbox plumbing stays put.
 *
 * The LLM rules from `AI Layer.html`:
 *   - confidence is ordinal (low | med | high), never a numeric pct
 *   - every line carries a sourced attribution
 *   - amber not red — so the proposal renders amber until the human
 *     applies it
 */

export interface TakeoffToBidPayload {
  project_id: string
  source_run_id?: string
}

export interface ProposedBidLine {
  service_item_code: string
  description: string
  quantity: number
  unit: string
  rate: number
  amount: number
  confidence: 'low' | 'med' | 'high'
  rationale: string
}

interface MeasurementRow {
  id: string
  service_item_code: string
  quantity: string
  unit: string
  rate: string
  notes: string | null
}

interface ServiceItemRow {
  code: string
  description: string
  default_unit: string
  default_rate: string
}

/**
 * Stub LLM proposal — replace with Anthropic SDK call when API key is
 * wired. The output shape is what the real agent would return, so the
 * downstream insight write + UI render are exercised today.
 */
async function proposeBidLines(
  measurements: MeasurementRow[],
  catalog: Map<string, ServiceItemRow>,
): Promise<ProposedBidLine[]> {
  return measurements.map((m) => {
    const catalogRow = catalog.get(m.service_item_code)
    const quantity = Number(m.quantity) || 0
    const rate = Number(m.rate) || Number(catalogRow?.default_rate ?? 0)
    const amount = quantity * rate
    // Confidence drops when the catalog has no matching code or the
    // rate fell back to zero — in either case the human has to look.
    let confidence: 'low' | 'med' | 'high' = 'high'
    if (!catalogRow) confidence = 'low'
    else if (rate === 0) confidence = 'low'
    else if (quantity < 1) confidence = 'med'
    return {
      service_item_code: m.service_item_code,
      description: catalogRow?.description ?? `Imported takeoff: ${m.service_item_code}`,
      quantity,
      unit: m.unit || catalogRow?.default_unit || 'sqft',
      rate,
      amount,
      confidence,
      rationale: catalogRow
        ? `Catalog match for ${m.service_item_code} at $${rate.toFixed(2)}/${m.unit}`
        : `No catalog match — using fallback rate (review before bidding)`,
    }
  })
}

export async function processTakeoffToBidRun(
  client: PoolClient,
  companyId: string,
  payload: TakeoffToBidPayload,
): Promise<{ insightsCreated: number; lines: ProposedBidLine[] }> {
  // 1. pull non-deleted measurements for the project. Today this reads
  // the legacy single-scope columns; multi-condition tags from Phase 3A
  // are summarized in a follow-on once the agent prompt is finalized.
  const measurements = await client.query<MeasurementRow>(
    `select id, service_item_code, quantity, unit, rate, notes
     from takeoff_measurements
     where company_id = $1 and project_id = $2 and deleted_at is null`,
    [companyId, payload.project_id],
  )
  if (measurements.rows.length === 0) {
    return { insightsCreated: 0, lines: [] }
  }

  // 2. pull catalog (service_items) so the agent knows the rate book
  const catalogRows = await client.query<ServiceItemRow>(
    `select code, description, default_unit, default_rate
     from service_items
     where company_id = $1`,
    [companyId],
  )
  const catalog = new Map(catalogRows.rows.map((r) => [r.code, r]))

  // 3. propose
  const lines = await proposeBidLines(measurements.rows, catalog)

  // 4. write a single insight row carrying all proposed lines —
  // the UI renders from one ai_insights row and the user applies or
  // dismisses each line individually inside the agent surface.
  const totalAmount = lines.reduce((acc, l) => acc + l.amount, 0)
  const minConfidence = lines.reduce<'low' | 'med' | 'high'>((acc, l) => {
    if (acc === 'low' || l.confidence === 'low') return 'low'
    if (acc === 'med' || l.confidence === 'med') return 'med'
    return 'high'
  }, 'high')

  await client.query(
    `insert into ai_insights
       (company_id, kind, entity_type, entity_id, payload, confidence,
        attribution, source_run_id, produced_by)
     values ($1, 'takeoff_to_bid', 'project', $2, $3::jsonb, $4, $5, $6, 'agent:takeoff_to_bid')`,
    [
      companyId,
      payload.project_id,
      JSON.stringify({
        lines,
        total_amount: totalAmount,
        measurement_count: measurements.rows.length,
      }),
      minConfidence,
      `Derived from ${measurements.rows.length} takeoff measurements + service_items catalog`,
      payload.source_run_id ?? null,
    ],
  )

  return { insightsCreated: 1, lines }
}
