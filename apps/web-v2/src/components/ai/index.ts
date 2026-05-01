/**
 * AI Layer — locked visual primitives.
 *
 * Three tiers from `AI Layer.html`:
 *   1. inline atom  → Spark + Attribution
 *   2. stripe card  → StripeCard
 *   3. agent surface → AgentSurface (with Dismiss)
 *
 * Plus the WhyThis explainer overlay.
 *
 * Hard rules these primitives encode (don't bypass them at the call site):
 *   - confidence is ordinal (Spark state), never a numeric percent
 *   - every AI value carries an Attribution naming its source
 *   - dismiss is signal (record it); never delete the suggestion silently
 *   - the AI mark is the brand amber — never red
 */
export { Spark, type SparkProps, type SparkState } from './Spark'
export { Attribution, type AttributionProps } from './Attribution'
export { StripeCard, type StripeCardProps, type StripeTone } from './StripeCard'
export { AgentSurface, type AgentSurfaceProps } from './AgentSurface'
export { Dismiss, type DismissProps } from './Dismiss'
export { WhyThis, type WhyThisProps } from './WhyThis'
