/**
 * IssueReporter — the invited-guest "Report an issue" widget (observability T2).
 *
 * A slim, PII-free, explicit issue-report surface for the public portal. An
 * invited visitor opens the pill, optionally captures recent console/network
 * errors, writes a note, and sends — POSTed as typed product-trace events to the
 * gateway public route (which forwards to mesh, where it's clustered into a
 * deduped issue). NO rrweb, NO DOM, NO input values — only error/nav signals +
 * the note, so it's PII-free by construction (the gateway templates + redacts
 * further).
 *
 * OFF BY DEFAULT — renders null unless BOTH:
 *   1. VITE_TRACE_BEACON_URL is set at build time, AND
 *   2. an invite is present (?capture_invite=<t> in the URL, or VITE_CAPTURE_INVITE).
 * So merging this is inert until the operator wires the env + hands out invites.
 */
import { useEffect, useRef, useState } from 'react'

function env(name: string): string {
  try {
    return String((import.meta as { env?: Record<string, string> }).env?.[name] || '').trim()
  } catch {
    return ''
  }
}

function inviteToken(): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('capture_invite')
    return (fromUrl || env('VITE_CAPTURE_INVITE') || '').trim()
  } catch {
    return env('VITE_CAPTURE_INVITE')
  }
}

type Ev = {
  event_class: string
  route_path: string
  outcome: string
  error_code: string
  occurred_at: string
  payload: Record<string, unknown>
}

export function IssueReporter() {
  const beaconUrl = env('VITE_TRACE_BEACON_URL').replace(/\/+$/, '')
  const invite = inviteToken()
  const enabled = Boolean(beaconUrl) && Boolean(invite)

  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [sent, setSent] = useState(false)
  const captured = useRef<Ev[]>([])

  // While the widget is enabled, passively buffer error signals (capped, PII-free)
  // so a report carries the recent failures the user hit. No input values, no DOM.
  useEffect(() => {
    if (!enabled) return
    const route = () => window.location.pathname
    const push = (e: Partial<Ev>) => {
      if (captured.current.length >= 50) captured.current.shift()
      captured.current.push({
        event_class: 'runtime_error',
        route_path: route(),
        outcome: 'failed',
        error_code: '',
        occurred_at: new Date().toISOString(),
        payload: {},
        ...e,
      } as Ev)
    }
    const onErr = (ev: ErrorEvent) => push({ error_code: String(ev.message).slice(0, 120) })
    const onRej = (ev: PromiseRejectionEvent) => push({ error_code: String(ev.reason).slice(0, 120) })
    window.addEventListener('error', onErr)
    window.addEventListener('unhandledrejection', onRej)
    return () => {
      window.removeEventListener('error', onErr)
      window.removeEventListener('unhandledrejection', onRej)
    }
  }, [enabled])

  if (!enabled) return null

  const send = () => {
    const events: Ev[] = [
      ...captured.current,
      {
        event_class: 'user_action',
        route_path: window.location.pathname,
        outcome: 'reported',
        error_code: '',
        occurred_at: new Date().toISOString(),
        payload: { event_name: 'issue_reported', note: note.slice(0, 500) },
      },
    ]
    const body = JSON.stringify({ events })
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(beaconUrl, new Blob([body], { type: 'application/json' }))
      else
        void fetch(beaconUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {})
    } catch {
      /* fire-and-forget */
    }
    setSent(true)
    setOpen(false)
    setNote('')
    captured.current = []
    setTimeout(() => setSent(false), 4000)
  }

  const pill: React.CSSProperties = {
    position: 'fixed',
    right: 16,
    bottom: 16,
    zIndex: 9999,
    padding: '10px 14px',
    borderRadius: 999,
    border: '1px solid var(--m-line, var(--p-line))',
    background: 'var(--m-card, var(--p-paper))',
    color: 'var(--m-ink, var(--p-ink))',
    fontSize: 13,
    cursor: 'pointer',
    boxShadow: 'var(--p-pill-shadow)',
  }

  if (sent) return <div style={{ ...pill, color: 'var(--m-green)' }}>Thanks — issue sent ✓</div>
  if (!open)
    return (
      <button type="button" style={pill} onClick={() => setOpen(true)}>
        Report an issue
      </button>
    )

  return (
    <div
      style={{ ...pill, width: 280, padding: 14, display: 'flex', flexDirection: 'column', gap: 8, cursor: 'default' }}
    >
      <div style={{ fontWeight: 600, fontSize: 13 }}>Report an issue</div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What went wrong? (no personal info needed)"
        rows={3}
        style={{
          width: '100%',
          fontSize: 13,
          padding: 8,
          borderRadius: 8,
          border: '1px solid var(--m-line, var(--p-line))',
          resize: 'vertical',
        }}
      />
      <div style={{ fontSize: 11, color: 'var(--m-ink-3, var(--p-text-4))' }}>
        Shares recent error signals + your note (no page contents, no personal info).
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          style={{ ...pill, position: 'static', boxShadow: 'none', padding: '6px 12px' }}
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          style={{
            ...pill,
            position: 'static',
            boxShadow: 'none',
            padding: '6px 12px',
            background: 'var(--m-accent, var(--p-ink))',
            color: 'var(--p-paper)',
          }}
          onClick={send}
        >
          Send
        </button>
      </div>
    </div>
  )
}
