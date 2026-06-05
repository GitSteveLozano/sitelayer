/**
 * AI takeoff cost model (gap G1/G3).
 *
 * The operator's plan: prove the vision-takeoff works on a FREE path
 * (gemini-cli / agy subscription, or a local GPU), route to that for a while,
 * but at scale move to a metered API (Gemini / Anthropic). The risk is a
 * surprise price hike when crossing from "free" to paid. So this module prices
 * every run AND, crucially, computes the **shadow** metered cost even on the
 * free path — i.e. "this takeoff cost $0 on gemini-cli, but WOULD cost $X via
 * the Gemini API" — so the free→paid delta is known BEFORE the switch.
 *
 * PRICING IS VOLATILE. `MODEL_PRICING` is a dated snapshot (verify against
 * current vendor pricing before trusting absolute $). The MODEL — image
 * tokenization + token math + the shadow-cost idea — is the durable part; only
 * the numbers need maintenance.
 */

export type TakeoffProvider = 'gemini-cli' | 'agy-cli' | 'local-gpu' | 'gemini-api' | 'anthropic-api' | 'stub'

/** Whether a provider actually meters dollars. CLI subscriptions + local GPU + the
 *  stub are $0 at the margin; only the raw APIs bill per token. */
export const METERED_PROVIDERS: ReadonlySet<TakeoffProvider> = new Set<TakeoffProvider>(['gemini-api', 'anthropic-api'])

export interface ModelPricing {
  /** USD per 1,000,000 input tokens (incl. image tokens). */
  inputPerMillion: number
  /** USD per 1,000,000 output tokens. */
  outputPerMillion: number
  /** Image tokenization family — determines how pixels map to input tokens. */
  imageModel: 'gemini' | 'anthropic'
}

/**
 * Metered Standard-tier rates (text/image input), VERIFIED against
 * ai.google.dev/gemini-api/docs/pricing on 2026-06-05. These are what a run is
 * billed at on the paid API (the "shadow" rate when on a free path). For the
 * tiered Pro models the ≤200K-token input rate is used — a single-sheet takeoff
 * is far under 200K, so that's the right tier. Anthropic rates are the existing
 * pipe-blueprint path; verify those separately.
 *
 * NOTE: Batch tier is 50% off (BATCH_DISCOUNT) — a takeoff is async, so Batch is
 * the real per-takeoff rate at scale. estimateTakeoffCost(tier:'batch') applies it.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Gemini 2.5 (prior gen, still served + cheapest)
  'gemini-2.5-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4, imageModel: 'gemini' },
  'gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5, imageModel: 'gemini' },
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10, imageModel: 'gemini' },
  // Gemini 3.x (current gen, 2026-06)
  'gemini-3.1-flash-lite': { inputPerMillion: 0.25, outputPerMillion: 1.5, imageModel: 'gemini' },
  'gemini-3-flash-preview': { inputPerMillion: 0.5, outputPerMillion: 3, imageModel: 'gemini' },
  'gemini-3.5-flash': { inputPerMillion: 1.5, outputPerMillion: 9, imageModel: 'gemini' },
  'gemini-3.1-pro-preview': { inputPerMillion: 2, outputPerMillion: 12, imageModel: 'gemini' },
  // Anthropic (the existing pipe-blueprint Claude path) — verify rates separately.
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5, imageModel: 'anthropic' },
  'claude-sonnet-4-5': { inputPerMillion: 3, outputPerMillion: 15, imageModel: 'anthropic' },
  'claude-opus-4-x': { inputPerMillion: 15, outputPerMillion: 75, imageModel: 'anthropic' },
}

/** Batch-tier multiplier vs Standard (Gemini Batch + Anthropic batch ≈ 50% off).
 *  Takeoff is async → batchable → this is the real per-takeoff scale rate. */
export const BATCH_DISCOUNT = 0.5

/** Every Gemini model the cost model knows, for the bang-for-buck comparison. */
export const GEMINI_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.5-flash',
  'gemini-3.1-pro-preview',
] as const

/** The model a free CLI/local path is *actually running*, so its shadow cost is
 *  priced against the matching metered rate (gemini-cli ⇒ a Gemini model). */
/**
 * Bang-for-buck winner, from a real 7-model head-to-head on the sample blueprint
 * (2026-06-05, scripts/takeoff-vision/compare-models.ts): the ENTIRE Gemini 2.5
 * generation produced invalid/empty takeoffs; only Gemini 3.x worked, and
 * gemini-3.1-flash-lite won on all three axes — cheapest ($0.003/takeoff,
 * $0.0015 batch → $1.50/1000), fastest (~6s), AND best-balanced extraction (15
 * rooms / 4 walls / 9 dims). The pricier 3.5-flash / 3.1-pro were worse or
 * incomplete. (NOTE: "quality" = valid structured output volume, NOT verified
 * geometric accuracy — that's a separate ground-truth step.)
 */
export const RECOMMENDED_TAKEOFF_MODEL = 'gemini-3.1-flash-lite'

export const DEFAULT_SHADOW_MODEL: Record<TakeoffProvider, string> = {
  // The CLIs auto-pick a model (no -m); empirically a 3.x, so price the shadow
  // against the recommended scale model rather than guessing the CLI's pick.
  'gemini-cli': RECOMMENDED_TAKEOFF_MODEL,
  'agy-cli': RECOMMENDED_TAKEOFF_MODEL,
  'local-gpu': 'gemini-2.5-flash-lite', // closest paid analog to price the "if we had to pay" case
  'gemini-api': RECOMMENDED_TAKEOFF_MODEL,
  'anthropic-api': 'claude-sonnet-4-5',
  stub: 'gemini-2.5-flash-lite',
}

const GEMINI_TILE_PX = 768
const GEMINI_TILE_TOKENS = 258
const GEMINI_SMALL_PX = 384

/**
 * Gemini image tokens. Images whose longest side ≤ 384px cost one 258-token
 * unit; larger images are tiled into 768×768 cells, each 258 tokens. (Matches
 * Gemini's documented image tokenization closely enough for budgeting.)
 */
export function geminiImageTokens(widthPx: number, heightPx: number): number {
  if (widthPx <= 0 || heightPx <= 0) return 0
  if (Math.max(widthPx, heightPx) <= GEMINI_SMALL_PX) return GEMINI_TILE_TOKENS
  const tiles = Math.ceil(widthPx / GEMINI_TILE_PX) * Math.ceil(heightPx / GEMINI_TILE_PX)
  return tiles * GEMINI_TILE_TOKENS
}

/** Anthropic image tokens ≈ (w×h)/750, capped at the documented ~1568px-tile max. */
export function anthropicImageTokens(widthPx: number, heightPx: number): number {
  if (widthPx <= 0 || heightPx <= 0) return 0
  return Math.ceil((widthPx * heightPx) / 750)
}

export function imageTokens(widthPx: number, heightPx: number, family: 'gemini' | 'anthropic'): number {
  return family === 'gemini' ? geminiImageTokens(widthPx, heightPx) : anthropicImageTokens(widthPx, heightPx)
}

export interface TakeoffCostInput {
  provider: TakeoffProvider
  /** Metered model id. Defaults to the provider's DEFAULT_SHADOW_MODEL. */
  model?: string
  /** Plan sheets sent to the model (one image each). */
  pages: Array<{ widthPx: number; heightPx: number }>
  /** Text prompt tokens (instructions + few-shot). */
  promptTokens?: number
  /** Expected JSON output tokens (detected quantities). */
  outputTokens?: number
  /** 'batch' applies the 50%-off Batch tier — the real per-takeoff rate at scale
   *  since takeoff is async. Defaults to 'standard'. */
  tier?: 'standard' | 'batch'
}

export interface TakeoffCostEstimate {
  provider: TakeoffProvider
  model: string
  inputTokens: number
  outputTokens: number
  imageTokens: number
  /** Dollars actually billed for this run ($0 on a free/subscription/local path). */
  billedUsd: number
  /** Dollars this SAME run would cost on the metered API — the scale price. On a
   *  free path this is the "what flipping to paid would cost" number. */
  shadowApiUsd: number
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/** Price a single takeoff run. */
export function estimateTakeoffCost(input: TakeoffCostInput): TakeoffCostEstimate {
  const provider = input.provider
  const model = input.model ?? DEFAULT_SHADOW_MODEL[provider]
  const pricing = MODEL_PRICING[model]
  if (!pricing) throw new Error(`unknown model pricing: ${model}`)

  const imgTokens = input.pages.reduce((sum, p) => sum + imageTokens(p.widthPx, p.heightPx, pricing.imageModel), 0)
  const inputTokens = imgTokens + (input.promptTokens ?? 0)
  const outputTokens = input.outputTokens ?? 0

  const tierMult = input.tier === 'batch' ? BATCH_DISCOUNT : 1
  const meteredUsd =
    ((inputTokens / 1_000_000) * pricing.inputPerMillion + (outputTokens / 1_000_000) * pricing.outputPerMillion) *
    tierMult
  const billedUsd = METERED_PROVIDERS.has(provider) ? meteredUsd : 0

  return {
    provider,
    model,
    inputTokens,
    outputTokens,
    imageTokens: imgTokens,
    billedUsd: round4(billedUsd),
    shadowApiUsd: round4(meteredUsd),
  }
}

/** Project a recurring spend from a per-takeoff shadow cost and a monthly volume. */
export function projectMonthlyCost(
  perTakeoffShadowUsd: number,
  takeoffsPerMonth: number,
): { takeoffsPerMonth: number; monthlyUsd: number; annualUsd: number } {
  const monthlyUsd = round4(perTakeoffShadowUsd * takeoffsPerMonth)
  return { takeoffsPerMonth, monthlyUsd, annualUsd: round4(monthlyUsd * 12) }
}
