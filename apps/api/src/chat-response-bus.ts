/**
 * In-process pub/sub bus for AI-chat response deltas.
 *
 * The chat widget's SSE endpoint (`GET /api/ai/chat/:id/stream`) subscribes
 * here, and the runner webhook (`POST /api/ai/chat/:id/respond`) publishes
 * after persisting the `respond_message` audit row. Decouples the two
 * code paths so the SSE handler doesn't have to poll the DB.
 *
 * Scope is single-process: there is no cross-instance fan-out yet. The
 * production API runs as one container (see CLAUDE.md "Current Infrastructure
 * Snapshot"), and the runner webhook hits whichever instance owns the
 * subscription via sticky routing through Caddy → single backend. If we
 * scale the API beyond one replica, this needs to become a Postgres
 * `LISTEN/NOTIFY` channel or a Redis pub/sub. The SSE handler has a 60s
 * safety timeout and falls through to a final DB read on disconnect, so
 * a lost in-process notify still produces the correct result via the
 * widget's existing polling fallback path.
 */

export type ChatResponseEvent = {
  audit_event_id: string
  status: 'responded' | 'partial'
  response_audit_event_id?: string
  body?: string | null
  body_delta?: string
  created_at?: string
  raw?: Record<string, unknown>
}

type Listener = (event: ChatResponseEvent) => void

const subscribers = new Map<string, Set<Listener>>()

export function subscribe(auditEventId: string, listener: Listener): () => void {
  let set = subscribers.get(auditEventId)
  if (!set) {
    set = new Set()
    subscribers.set(auditEventId, set)
  }
  set.add(listener)
  return () => {
    const current = subscribers.get(auditEventId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) subscribers.delete(auditEventId)
  }
}

export function publish(event: ChatResponseEvent): void {
  const set = subscribers.get(event.audit_event_id)
  if (!set || set.size === 0) return
  // Snapshot listeners so unsubscribe-during-publish (the common path —
  // listener finishes the connection, calls its unsubscribe) doesn't
  // mutate the set we're iterating.
  for (const listener of Array.from(set)) {
    try {
      listener(event)
    } catch {
      // A misbehaving listener must not poison the bus for other
      // subscribers. The SSE handler installs a safe listener; this
      // try/catch is defense-in-depth for future callers.
    }
  }
}

/** Test-only — clear all subscribers between tests. */
export function __resetForTests(): void {
  subscribers.clear()
}

/** Test-only — current subscriber count for the given audit_event_id. */
export function __subscriberCountForTests(auditEventId: string): number {
  return subscribers.get(auditEventId)?.size ?? 0
}
