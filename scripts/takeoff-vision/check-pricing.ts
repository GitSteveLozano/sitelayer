// Pricing-drift guard for the AI takeoff cost model (packages/pipe-blueprint/src/cost.ts).
//
// MODEL_PRICING is a DATED snapshot of vendor rates; the operator's plan crosses
// from a free CLI/local path to a metered API at scale, so a surprise price hike
// must be caught BEFORE it silently inflates the shadow cost. This script fetches
// the public Gemini pricing page, extracts the per-million input/output rates it
// can find for each Gemini model we price, and prints any model whose live rate
// differs from the committed snapshot. It exits non-zero on confirmed drift so it
// can run as a periodic check.
//
//   npx tsx scripts/takeoff-vision/check-pricing.ts
//
// Network-free / parse-failure is NOT drift: if the page can't be fetched or a
// model's rate can't be located, the script SAYS SO and (by default) exits 0 —
// only a confidently-parsed mismatch is treated as drift. Pass --strict to also
// fail when the page is unreachable (useful in a monitored cron where silence is
// itself a signal).
import { MODEL_PRICING, type ModelPricing } from '../../packages/pipe-blueprint/src/cost.js'

const PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing'
const FETCH_TIMEOUT_MS = 20_000
const STRICT = process.argv.includes('--strict')

// Only Gemini models are priced on this page; Anthropic rates live elsewhere and
// are verified separately (see the cost.ts NOTE on the Anthropic rows).
const GEMINI_PRICED = Object.entries(MODEL_PRICING).filter(([, p]) => p.imageModel === 'gemini') as Array<
  [string, ModelPricing]
>
const NON_GEMINI = Object.entries(MODEL_PRICING)
  .filter(([, p]) => p.imageModel !== 'gemini')
  .map(([id]) => id)

interface FoundRate {
  /** USD per 1M input tokens parsed near the model id, or null if not found. */
  input: number | null
  /** USD per 1M output tokens parsed near the model id, or null if not found. */
  output: number | null
}

/** Fetch the pricing page HTML. Returns null (not throw) on any network failure. */
async function fetchPricingHtml(): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(PRICING_URL, {
      // Force English — the page is geo/Accept-Language localized, and the
      // "Input price" / "Output price" labels this parser keys off only appear
      // in the English variant. Without this the prices are unparseable abroad.
      headers: {
        accept: 'text/html',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (sitelayer-pricing-drift-check)',
      },
      signal: controller.signal,
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Strip HTML tags + collapse whitespace so model ids and prices sit on one line. */
function flatten(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
}

/**
 * Heuristically locate the input/output per-million rates for a model id in the
 * flattened pricing text. The page lists prices as "$0.10" near "input" /
 * "output" labels within the model's section. We take a window of text starting
 * at the model id (up to the next priced model id or 1200 chars) and pull the
 * first dollar amount tagged input and the first tagged output. Best-effort:
 * returns nulls when the window or a label can't be found rather than guessing.
 */
function findRate(flat: string, modelId: string, allIds: string[]): FoundRate {
  const lower = flat.toLowerCase()
  const start = lower.indexOf(modelId.toLowerCase())
  if (start < 0) return { input: null, output: null }

  // Window ends at the next OTHER model id mention (so we don't read a neighbor's
  // price) or a fixed cap, whichever is closer.
  let end = start + 1200
  for (const other of allIds) {
    if (other === modelId) continue
    const idx = lower.indexOf(other.toLowerCase(), start + modelId.length)
    if (idx > start && idx < end) end = idx
  }
  const window = flat.slice(start, end)

  return { input: priceNear(window, 'input'), output: priceNear(window, 'output') }
}

/**
 * The first paid "$N.NN" that FOLLOWS the "<Input|Output> price" label in the
 * model's window. The page lays each rate out as
 *   "Input price  Free of charge  $0.25 (text / image / video) $0.50 (audio)"
 * so the first dollar amount after the label is the paid-tier text/image rate we
 * snapshot (the "Free of charge" free-tier column carries no `$`, and the audio
 * `$0.50` comes later). We deliberately match label-THEN-price (never a `$`
 * before the label) so a neighbouring block's trailing "$0.50 (audio) Output
 * price …" can't bleed the audio price into the output rate. Returns null when
 * the label or a following price is absent (page restructured / localized).
 */
function priceNear(window: string, label: 'input' | 'output'): number | null {
  const re = new RegExp(`\\b${label}\\s+price\\b[^$]{0,120}?\\$\\s*([0-9]+(?:\\.[0-9]+)?)`, 'i')
  const m = re.exec(window)
  if (!m) return null
  const raw = m[1]
  if (raw == null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Close enough — vendor pages round; treat sub-cent equality as no drift. */
function sameRate(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005
}

async function main(): Promise<void> {
  console.log(`▶ pricing-drift check vs ${PRICING_URL}`)
  console.log(`  snapshot: packages/pipe-blueprint/src/cost.ts MODEL_PRICING (${GEMINI_PRICED.length} Gemini models)`)
  if (NON_GEMINI.length > 0) {
    console.log(`  skipping non-Gemini (verify separately): ${NON_GEMINI.join(', ')}\n`)
  }

  const html = await fetchPricingHtml()
  if (html == null) {
    console.log('⚠ could not fetch the Gemini pricing page (offline or blocked) — cannot verify prices.')
    process.exit(STRICT ? 1 : 0)
  }
  const flat = flatten(html)
  const allIds = GEMINI_PRICED.map(([id]) => id)

  let drift = 0
  let unverified = 0
  for (const [model, snapshot] of GEMINI_PRICED) {
    const live = findRate(flat, model, allIds)
    const parts: string[] = []
    let modelDrift = false

    if (live.input == null) {
      parts.push('input=? (not found)')
      unverified += 1
    } else if (!sameRate(live.input, snapshot.inputPerMillion)) {
      parts.push(`input ${snapshot.inputPerMillion} → ${live.input}`)
      modelDrift = true
    }

    if (live.output == null) {
      parts.push('output=? (not found)')
      unverified += 1
    } else if (!sameRate(live.output, snapshot.outputPerMillion)) {
      parts.push(`output ${snapshot.outputPerMillion} → ${live.output}`)
      modelDrift = true
    }

    if (modelDrift) {
      drift += 1
      console.log(`✗ DRIFT  ${model.padEnd(26)} ${parts.join(', ')}`)
    } else if (parts.length > 0) {
      console.log(`? ${model.padEnd(28)} ${parts.join(', ')}`)
    } else {
      console.log(`✓ ${model.padEnd(28)} input=${snapshot.inputPerMillion} output=${snapshot.outputPerMillion} (match)`)
    }
  }

  console.log('')
  if (drift > 0) {
    console.log(`✗ ${drift} model(s) drifted from the snapshot — update MODEL_PRICING in cost.ts and re-date the NOTE.`)
    process.exit(1)
  }
  if (unverified > 0) {
    console.log(
      `⚠ no drift confirmed, but ${unverified} rate(s) could not be located on the page (layout changed?). ` +
        'Spot-check manually.',
    )
    process.exit(STRICT ? 1 : 0)
  }
  console.log('✓ all priced Gemini models match the live pricing page.')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
