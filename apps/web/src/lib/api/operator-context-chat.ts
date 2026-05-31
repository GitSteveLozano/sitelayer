import type { OperatorContextPacket } from '@/lib/operator-context'
import { API_URL, buildAuthHeaders, request } from './client'

export type OperatorContextChatMessage = {
  id: string
  role: 'operator' | 'agent'
  body: string
  packet_generated_at?: string
}

export type StageOperatorContextChatResponse = {
  status: 'staged'
  audit_event_id: string
  response_pending: boolean
  followup_hint: string
}

export type StageOperatorContextChatInput = {
  messages: OperatorContextChatMessage[]
  operatorContext: OperatorContextPacket
}

export function stageOperatorContextChatMessage(
  input: StageOperatorContextChatInput,
): Promise<StageOperatorContextChatResponse> {
  return request('/api/ai/chat', {
    method: 'POST',
    json: {
      messages: input.messages,
      operatorContext: input.operatorContext,
    },
  })
}

/**
 * Shape of the polling endpoint that the chat-widget machine consumes
 * during the awaitingResponse state. Returns 202 with status='staged'
 * while the response is pending, 200 with status='responded' once the
 * subscription-CLI runner has written the respond_message audit row
 * back via the webhook.
 */
export type FetchOperatorContextChatResponseResult =
  | {
      status: 'staged'
      response_pending: true
      audit_event_id: string
      followup_hint?: string
    }
  | {
      status: 'responded'
      audit_event_id: string
      response_audit_event_id: string
      body: string | null
      created_at: string
      raw?: Record<string, unknown>
    }

export async function fetchOperatorContextChatResponse(
  auditEventId: string,
): Promise<FetchOperatorContextChatResponseResult> {
  return request(`/api/ai/chat/${encodeURIComponent(auditEventId)}/response`, {
    method: 'GET',
  })
}

/**
 * Server-pushed delta payload for the chat-response SSE stream. Mirrors
 * the wire envelope the server emits (`event: delta`, JSON body). The
 * client subscriber surfaces these through `subscribeChatResponse`.
 *
 * `status: 'responded'` is terminal — once received, the subscription
 * closes itself; the widget machine flips the staged message to
 * 'responded' and appends the agent reply.
 *
 * `status: 'partial'` (with `body_delta`) is RESERVED for a future
 * streaming-token rollout. No server publish site emits it today, and
 * the widget machine does not model it (a `partial` delta is a no-op).
 * Kept on the wire type so adding token streaming later is purely
 * additive.
 */
export type ChatResponseDelta = {
  audit_event_id: string
  /** `'responded'` is terminal/emitted-today; `'partial'` is reserved (see above). */
  status: 'responded' | 'partial'
  response_audit_event_id?: string
  body?: string | null
  body_delta?: string
  created_at?: string
  raw?: Record<string, unknown>
}

export type ChatSubscriptionHandlers = {
  onDelta: (delta: ChatResponseDelta) => void
  onError: (err: Error) => void
}

/**
 * Open an SSE subscription to GET /api/ai/chat/:id/stream. Returns an
 * `unsubscribe` function the caller invokes on disposal.
 *
 * We use `fetch` + a ReadableStream reader rather than the browser
 * `EventSource` because EventSource cannot attach custom headers
 * (Authorization, x-sitelayer-company-slug, x-request-id) and our API
 * requires them. The wire protocol matches SSE so the server-side
 * handler doesn't have to fork: `event: <name>\ndata: <json>\n\n` frames.
 *
 * Handlers:
 *   - `onDelta` fires once per `event: delta` frame with the parsed JSON.
 *   - `onError` fires on transport failure (network drop, non-200 status,
 *     malformed frame). The subscription is disposed automatically — the
 *     caller doesn't need to call unsubscribe in the error path.
 *
 * The implementation tolerates back-pressure (large frames split across
 * chunks) by buffering until it sees the SSE record-terminator `\n\n`.
 */
export function subscribeChatResponse(auditEventId: string, handlers: ChatSubscriptionHandlers): () => void {
  const controller = new AbortController()
  let disposed = false
  const unsubscribe = (): void => {
    if (disposed) return
    disposed = true
    try {
      controller.abort()
    } catch {
      /* abort is best-effort */
    }
  }

  ;(async () => {
    let response: Response
    try {
      const headers = await buildAuthHeaders()
      // The server emits `text/event-stream`. Setting Accept also lets
      // future content-negotiation logic distinguish stream requests
      // from JSON requests on the same path namespace.
      headers.set('Accept', 'text/event-stream')
      response = await fetch(`${API_URL}/api/ai/chat/${encodeURIComponent(auditEventId)}/stream`, {
        method: 'GET',
        headers,
        signal: controller.signal,
        // Disable browser caching — streams must never be cached and a
        // stale cached 200 with no body would silently look like an
        // immediate close.
        cache: 'no-store',
      })
    } catch (err) {
      if (disposed) return
      handlers.onError(err instanceof Error ? err : new Error('chat stream connect failed'))
      unsubscribe()
      return
    }

    if (!response.ok) {
      if (!disposed) {
        handlers.onError(new Error(`chat stream connect failed: status ${response.status}`))
      }
      unsubscribe()
      return
    }

    const body = response.body
    if (!body) {
      if (!disposed) handlers.onError(new Error('chat stream connect returned empty body'))
      unsubscribe()
      return
    }

    const reader = body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    const dispatchFrame = (frame: string): void => {
      // SSE frame parser. We only care about `event:` and `data:` lines;
      // comments (`:`) and unknown fields are dropped per the spec.
      let eventName = 'message'
      const dataLines: string[] = []
      for (const rawLine of frame.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (!line || line.startsWith(':')) continue
        const colonIdx = line.indexOf(':')
        const field = colonIdx === -1 ? line : line.slice(0, colonIdx)
        const value = colonIdx === -1 ? '' : line.slice(colonIdx + 1).replace(/^ /, '')
        if (field === 'event') eventName = value
        else if (field === 'data') dataLines.push(value)
      }
      if (!dataLines.length) return
      const dataPayload = dataLines.join('\n')
      let parsed: unknown
      try {
        parsed = JSON.parse(dataPayload)
      } catch {
        // Malformed JSON — most likely a transport bug. Surface as a
        // non-fatal error and continue reading; the next valid frame
        // can still wake the subscriber.
        if (!disposed) handlers.onError(new Error('chat stream emitted non-JSON frame'))
        return
      }
      if (eventName === 'delta') {
        handlers.onDelta(parsed as ChatResponseDelta)
      } else if (eventName === 'timeout') {
        if (!disposed) handlers.onError(new Error('chat stream timed out before response'))
        unsubscribe()
      }
      // 'subscribed' event is just an open-confirmation; nothing to do.
    }

    try {
      while (!disposed) {
        const { value, done } = await reader.read()
        if (done) {
          // Server closed the connection without sending a terminal
          // event. Surface as an error so the machine can fall back.
          if (!disposed) handlers.onError(new Error('chat stream closed by server'))
          break
        }
        buffer += decoder.decode(value, { stream: true })
        // SSE frame separator is a blank line — i.e. \n\n (or \r\n\r\n).
        // Split greedily so multiple frames in one chunk all dispatch.
        let sep = buffer.indexOf('\n\n')
        while (sep !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          dispatchFrame(frame)
          if (disposed) break
          sep = buffer.indexOf('\n\n')
        }
      }
    } catch (err) {
      if (disposed) return
      // AbortError fires when unsubscribe() is invoked normally — that's
      // not an application error; the caller knows it tore the stream
      // down.
      const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))
      if (!isAbort) {
        handlers.onError(err instanceof Error ? err : new Error('chat stream read failed'))
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* reader may already be closed */
      }
      unsubscribe()
    }
  })()

  return unsubscribe
}
