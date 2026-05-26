/**
 * Customer dedup picker — QuickBooks-style inline dedup during project
 * creation (handoff design `prj-create-qb`).
 *
 * As the estimator types a client name in `project-new.tsx`, this component
 * surfaces the closest EXISTING customers from the company roster so they
 * LINK to an existing record instead of minting a duplicate. Customers that
 * are QBO-linked carry an "IN QUICKBOOKS" indicator (matching the design's
 * "IN QUICKBOOKS · 92% MATCH" card). The estimator can "Use this" to adopt
 * the canonical name, or keep typing to create a brand-new customer.
 *
 * Data sources (existing endpoints only — no new backend routes):
 *   - `useCustomers()`           → GET /api/customers   (company roster)
 *   - `useQboMappings({customer})`→ GET /api/integrations/qbo/mappings
 *
 * The customers list endpoint has NO server-side search param, so matching
 * is done client-side over the roster. For pilot-scale rosters that's fine;
 * a very large roster would want a `?q=` search added to the route (noted in
 * the handoff report).
 */
import { useMemo } from 'react'
import { MBanner, MButton, MI, MListInset, MListRow, MPill, Spark } from '../../components/m/index.js'
import { useCustomers, type Customer } from '@/lib/api/customers'
import { useQboMappings } from '@/lib/api/qbo'

export interface CustomerMatch {
  customer: Customer
  /** 0..100 similarity score against the typed name. */
  score: number
  /** True when the customer is linked to a QuickBooks record. */
  qboLinked: boolean
  /** QBO display label when available (the canonical QBO name). */
  qboLabel: string | null
}

/** Below this score we don't consider it a plausible duplicate. */
const MATCH_THRESHOLD = 55
/** Exactly this name already exists — already linked, suppress the prompt. */
const EXACT = 100
const MAX_MATCHES = 3

/**
 * Normalize for comparison: lowercase, strip common business suffixes and
 * punctuation, collapse whitespace. "Acme Holdings, LLC" ≈ "acme holdings".
 */
function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,&]/g, ' ')
    .replace(/\b(llc|inc|incorporated|co|corp|company|ltd|limited|holdings?|group|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Levenshtein edit distance between two strings. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const deletion = (curr[j - 1] ?? 0) + 1
      const insertion = (prev[j] ?? 0) + 1
      const substitution = (prev[j - 1] ?? 0) + cost
      curr[j] = Math.min(deletion, insertion, substitution)
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[b.length] ?? Math.max(a.length, b.length)
}

/**
 * Similarity score 0..100. Blends normalized edit-distance with a token /
 * substring containment bonus so "Acme" against "Acme Holdings, LLC" still
 * reads as a strong match instead of being penalised for length.
 */
export function similarity(typedRaw: string, candidateRaw: string): number {
  const typed = normalizeName(typedRaw)
  const cand = normalizeName(candidateRaw)
  if (!typed || !cand) return 0
  if (typed === cand) return EXACT

  const dist = editDistance(typed, cand)
  const maxLen = Math.max(typed.length, cand.length)
  const editScore = maxLen === 0 ? 0 : (1 - dist / maxLen) * 100

  // Containment bonus: one normalized name fully contains the other.
  let containment = 0
  if (cand.includes(typed) || typed.includes(cand)) {
    const ratio = Math.min(typed.length, cand.length) / maxLen
    containment = 70 + ratio * 25
  }

  return Math.round(Math.min(EXACT - 1, Math.max(editScore, containment)))
}

/**
 * Compute the best existing-customer matches for a typed name, annotated
 * with QBO-link status. Pure + exported so it can be unit-tested without the
 * React surface.
 */
export function computeMatches(
  typed: string,
  customers: Customer[],
  qboLocalRefs: Map<string, string | null>,
): CustomerMatch[] {
  const trimmed = typed.trim()
  if (trimmed.length < 2) return []
  return customers
    .map((customer): CustomerMatch => {
      const hasMapping = qboLocalRefs.has(customer.id)
      const qboLinked = hasMapping || customer.source === 'qbo' || Boolean(customer.external_id)
      const qboLabel = qboLocalRefs.get(customer.id) ?? null
      return { customer, score: similarity(trimmed, customer.name), qboLinked, qboLabel }
    })
    .filter((m) => m.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES)
}

export interface CustomerDedupPickerProps {
  /** Current typed client name from the project-new form. */
  typedName: string
  /** Id of the existing customer the form is currently linked to (if any). */
  linkedCustomerId: string | null
  /**
   * Adopt an existing customer: parent sets the canonical name + records the
   * linked customer id (so create can carry external_id/source through).
   */
  onLink: (customer: CustomerMatch) => void
  /** User dismissed the match prompt — keep the typed name, create new. */
  onCreateNew: () => void
}

/**
 * Renders the "Match this customer?" prompt. Returns null when there's
 * nothing to suggest (too-short input, already-linked, or an exact-name
 * match that's effectively already the record).
 */
export function CustomerDedupPicker({ typedName, linkedCustomerId, onLink, onCreateNew }: CustomerDedupPickerProps) {
  const customersQuery = useCustomers()
  const mappingsQuery = useQboMappings({ entityType: 'customer' })

  const qboLocalRefs = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const m of mappingsQuery.data?.mappings ?? []) {
      if (m.deleted_at) continue
      map.set(m.local_ref, m.label)
    }
    return map
  }, [mappingsQuery.data])

  const matches = useMemo(
    () => computeMatches(typedName, customersQuery.data?.customers ?? [], qboLocalRefs),
    [typedName, customersQuery.data, qboLocalRefs],
  )

  // Suppress when we've already linked to a customer, or when the typed name
  // is an exact match to the linked record (nothing to dedupe).
  if (linkedCustomerId) return null
  if (matches.length === 0) return null
  // If the single best match is an exact-name hit, treat it as the obvious
  // record rather than a fuzzy suggestion — still show it so the user links.

  return (
    <div style={{ padding: '4px 16px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <MBanner
        tone="info"
        icon={<Spark size={18} />}
        title="Match this customer?"
        body={
          matches.some((m) => m.qboLinked)
            ? 'You may already have this client — link instead of creating a duplicate.'
            : 'You may already have this client in your roster.'
        }
      />

      <div>
        <div style={dimLabelStyle}>You typed</div>
        <div
          style={{
            border: '1px solid var(--m-line)',
            background: 'var(--m-card-soft)',
            borderRadius: 12,
            padding: '10px 14px',
            fontWeight: 600,
            color: 'var(--m-ink)',
          }}
        >
          {typedName.trim()}
        </div>
      </div>

      <MListInset>
        {matches.map((m) => (
          <MListRow
            key={m.customer.id}
            headline={m.qboLabel ?? m.customer.name}
            supporting={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {m.qboLinked ? (
                  <MPill tone="accent">
                    <Spark size={11} /> IN QUICKBOOKS
                  </MPill>
                ) : (
                  <MPill tone="blue">IN ROSTER</MPill>
                )}
                <span style={{ color: 'var(--m-accent-ink)', fontWeight: 600 }}>{m.score}% match</span>
              </span>
            }
            trailing={
              <MButton size="sm" variant="primary" onClick={() => onLink(m)}>
                Use this
              </MButton>
            }
          />
        ))}
      </MListInset>

      <MButton variant="quiet" size="sm" onClick={onCreateNew}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <MI.Plus size={14} /> No — create “{typedName.trim()}” as new
        </span>
      </MButton>
    </div>
  )
}

const dimLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--m-ink-3)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  marginBottom: 6,
}
