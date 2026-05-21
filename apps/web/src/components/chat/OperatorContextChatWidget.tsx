import { useEffect, useState } from 'react'
import { useChatWidget } from '@/machines/chat-widget'
import { useOperatorContext } from '@/lib/operator-context'

/**
 * Operator-context chat widget — v0 floating panel that consumes
 * `window.__operatorContext` (set by the control-plane browser-bridge
 * content script on operator-owned origins) and lets the operator stage
 * draft messages grounded in the active project.
 *
 * v0 shows the latest packet and persists staged messages through
 * POST /api/ai/chat. The endpoint logs the message for audit/follow-up;
 * LLM response generation is still a later worker.
 *
 * Visibility gate: the widget is hidden entirely for non-operator
 * visitors (no packet ever arrives), so this surface is invisible to
 * the public.
 *
 * Design: digital-ontology/operator-context-handshake-design.md
 */
export function OperatorContextChatWidget() {
  const packet = useOperatorContext()
  const widget = useChatWidget()
  const { syncContext } = widget

  // Mirror the global operator-context into the chat-widget machine so
  // anything the machine renders reads from a single, statechart-owned
  // snapshot rather than the global window state directly.
  useEffect(() => {
    syncContext(packet ?? null)
  }, [packet, syncContext])

  // Tick a once-per-second timer so the "responding for Ns" elapsed
  // counter rerenders while the subscription is open. Only runs while
  // awaiting; ride free when idle to avoid the runtime cost of a 1-Hz
  // interval. This is purely a UI clock — the transport itself is
  // server-push (SSE), not polling.
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!widget.isAwaitingResponse) return
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [widget.isAwaitingResponse])

  // Non-operator visitor: never render.
  if (!packet) {
    return null
  }

  // Awaiting elapsed-time + stall classification.
  // Computed once per render so every awaiting message footer shares
  // the same source-of-truth; the 1Hz forceTick effect drives the
  // rerender while the subscription is open.
  const pollingElapsedSec =
    widget.isAwaitingResponse && widget.awaitingResponseSince
      ? Math.max(0, Math.round((Date.now() - widget.awaitingResponseSince) / 1000))
      : null
  // 30s is past the healthy 5–15s range for the subscription-CLI lane;
  // switch the indicator to red so the operator notices. The
  // subscription's safety timeout fires at 60s, so this warning lands
  // well before the auto-fail.
  const pollingStalled = pollingElapsedSec !== null && pollingElapsedSec >= 30

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 print:hidden"
      data-testid="operator-context-chat-widget"
    >
      {widget.isOpen ? (
        <section
          aria-label="Operator context chat"
          className="w-[22rem] max-w-[calc(100vw-2rem)] bg-white shadow-lg rounded-md border border-sand-3 flex flex-col overflow-hidden"
        >
          <header className="px-3 py-2 border-b border-sand-3 flex items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-ink-2">
              Operator context · {packet.origin_context.label}
            </span>
            <span className="ml-auto text-xs text-ink-3 tabular-nums">{formatRelative(packet.generated_at)}</span>
            <button
              type="button"
              onClick={widget.close}
              aria-label="Close operator context chat"
              className="text-ink-2 hover:text-ink-1 text-sm leading-none px-1"
            >
              ×
            </button>
          </header>

          <div className="px-3 py-2 text-xs text-ink-2 space-y-1 max-h-40 overflow-y-auto">
            <div>
              <span className="font-medium text-ink-1">Focus:</span> {packet.current_focus.label}
              <span className="text-ink-3"> ({Math.round(packet.current_focus.confidence * 100)}%)</span>
            </div>
            {packet.origin_context.repo_branch ? (
              <div>
                <span className="font-medium text-ink-1">Branch:</span> {packet.origin_context.repo_branch}
                {packet.origin_context.repo_dirty ? <span className="text-amber-700"> · dirty</span> : null}
              </div>
            ) : null}
            {packet.recent_activity.length ? (
              <details>
                <summary className="cursor-pointer text-ink-2">
                  Recent activity ({packet.recent_activity.length})
                </summary>
                <ul className="mt-1 pl-3 space-y-0.5">
                  {packet.recent_activity.slice(0, 6).map((a, i) => (
                    <li key={i} className="text-ink-3 truncate">
                      <span className="text-ink-2">{a.kind}</span> {a.summary}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>

          {widget.messages.length ? (
            <ol className="border-t border-sand-3 px-3 py-2 space-y-2 max-h-64 overflow-y-auto" data-testid="operator-context-chat-thread">
              {widget.messages.map((m) => {
                const isAwaiting =
                  widget.isAwaitingResponse &&
                  widget.awaitingResponseFor !== null &&
                  m.audit_event_id === widget.awaitingResponseFor
                // A retry slot exists when the staged operator message has
                // an audit_event_id but the response never landed AND we're
                // not currently polling for any other message. Lets the
                // operator re-poll without typing the message again.
                const canRetry =
                  !isAwaiting &&
                  !widget.isAwaitingResponse &&
                  !widget.isSending &&
                  m.role === 'operator' &&
                  m.status === 'staged' &&
                  typeof m.audit_event_id === 'string' &&
                  m.audit_event_id.length > 0
                const isAgent = m.role === 'agent'
                // Bubble styling: operator messages anchor right (amber);
                // agent replies anchor left (sand). Mirrors the standard
                // chat-UI convention without dragging in a chat library.
                const bubbleClass = isAgent
                  ? 'self-start bg-sand-2 border border-sand-3 text-ink-1'
                  : 'self-end bg-amber-50 border border-amber-200 text-ink-1'
                return (
                  <li
                    key={m.id}
                    className={`flex flex-col ${isAgent ? 'items-start' : 'items-end'}`}
                    data-testid={`operator-context-chat-msg-${m.role}`}
                  >
                    <div className={`max-w-[85%] rounded-lg px-3 py-1.5 text-sm ${bubbleClass}`}>
                      <header className="flex items-baseline gap-2 text-[10px] uppercase tracking-wide text-ink-3 mb-0.5">
                        <span>{isAgent ? 'agent' : 'operator'}</span>
                        {isAgent && m.audit_event_id ? (
                          <span className="font-mono normal-case opacity-70" title={`response audit ${m.audit_event_id}`}>
                            {m.audit_event_id.slice(0, 8)}
                          </span>
                        ) : null}
                      </header>
                      <div className="whitespace-pre-wrap">{m.body}</div>
                      {/* Status row: shown only for non-agent messages while the loop is in flight. */}
                      {!isAgent && (m.status || isAwaiting || canRetry) ? (
                        <footer className="flex items-center gap-2 mt-1 text-[10px] text-ink-3">
                          {m.status ? <span>({m.status})</span> : null}
                          {isAwaiting ? (
                            <span
                              className={`inline-flex items-center gap-0.5 ${pollingStalled ? 'text-red-700' : 'text-amber-700'}`}
                              aria-live="polite"
                              aria-label={pollingStalled ? 'agent responding (stalled)' : 'agent responding'}
                              data-testid="operator-context-chat-responding"
                            >
                              <span className={`inline-block w-1 h-1 rounded-full ${pollingStalled ? 'bg-red-600' : 'bg-amber-600'} animate-pulse`} />
                              <span className={`inline-block w-1 h-1 rounded-full ${pollingStalled ? 'bg-red-600' : 'bg-amber-600'} animate-pulse [animation-delay:120ms]`} />
                              <span className={`inline-block w-1 h-1 rounded-full ${pollingStalled ? 'bg-red-600' : 'bg-amber-600'} animate-pulse [animation-delay:240ms]`} />
                              <span className="ml-1">
                                responding
                                {pollingElapsedSec !== null ? ` · ${pollingElapsedSec}s` : null}
                              </span>
                            </span>
                          ) : null}
                          {canRetry ? (
                            <button
                              type="button"
                              onClick={() => widget.retry(m.audit_event_id!)}
                              className="text-amber-700 underline hover:text-amber-900"
                              data-testid="operator-context-chat-retry"
                              aria-label="retry polling for this message"
                            >
                              ↻ retry
                            </button>
                          ) : null}
                        </footer>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ol>
          ) : null}

          {widget.error ? (
            <div className="border-t border-sand-3 px-3 py-2 text-xs text-red-700" role="alert">
              {widget.error}
            </div>
          ) : null}

          <div className="border-t border-sand-3 px-3 py-2 flex gap-2">
            <input
              type="text"
              value={widget.draft}
              onChange={(e) => widget.setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !widget.isSending && !widget.isAwaitingResponse) {
                  e.preventDefault()
                  widget.send()
                }
              }}
              placeholder={widget.isAwaitingResponse ? 'Waiting for the agent reply…' : 'Ask about this project…'}
              disabled={widget.isSending || widget.isAwaitingResponse}
              className="flex-1 text-sm border border-sand-3 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-400"
              data-testid="operator-context-chat-input"
            />
            <button
              type="button"
              onClick={widget.send}
              disabled={!widget.draft.trim() || widget.isSending || widget.isAwaitingResponse}
              className="text-sm min-w-[4.5rem] px-2 py-1 rounded bg-amber-500 text-white disabled:opacity-50"
              data-testid="operator-context-chat-send"
            >
              {widget.isSending ? 'Sending...' : widget.isAwaitingResponse ? 'Awaiting…' : 'Stage'}
            </button>
          </div>
          <footer className="px-3 py-1 text-[10px] text-ink-3 border-t border-sand-3 bg-sand-1">
            v0 · staged messages are logged for operator follow-up.
          </footer>
        </section>
      ) : null}

      <button
        type="button"
        onClick={widget.toggle}
        aria-label={widget.isOpen ? 'Close operator context chat' : 'Open operator context chat'}
        className="bg-amber-500 hover:bg-amber-600 text-white text-sm rounded-full px-3 py-2 shadow-md"
        data-testid="operator-context-chat-toggle"
      >
        {widget.isOpen ? 'Hide' : 'Operator ▴'}
      </button>
    </div>
  )
}

function formatRelative(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const deltaSec = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (deltaSec < 60) return `${deltaSec}s ago`
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3600)}h ago`
  return `${Math.floor(deltaSec / 86_400)}d ago`
}
