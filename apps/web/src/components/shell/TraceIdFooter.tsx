import { useCallback, useState } from 'react'

/**
 * Compact "Trace ID: <id> · Copy" footer for error displays. Renders only
 * when a request id is present (so we don't dump empty footers on hand-
 * written error strings). The button is the only meaningful interaction
 * — clicking it writes the id to the clipboard so the user can paste it
 * into the support thread.
 *
 * Wire this through the `requestId` prop on MBanner / ErrorState rather
 * than mounting it directly, so the placement stays consistent across
 * banner-style and centred-state error displays.
 *
 * The infrastructure that consumes the trace id lives at
 * `apps/api/src/routes/system.ts` (GET /api/debug/traces/:traceId,
 * Bearer DEBUG_TRACE_TOKEN). The id we surface is the same `x-request-id`
 * value the API echoes on every response — see ApiError.requestId in
 * `apps/web/src/lib/api/client.ts`.
 *
 * Clipboard guard: `navigator.clipboard.writeText` is a Promise that can
 * reject (denied permission, insecure context). We swallow the failure
 * so the UI doesn't crash; the "Copied" feedback only flips on success.
 */
export interface TraceIdFooterProps {
  requestId: string
  /** Optional className for layout overrides. */
  className?: string
}

export function TraceIdFooter({ requestId, className }: TraceIdFooterProps) {
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(() => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard) return
    void clipboard
      .writeText(requestId)
      .then(() => {
        setCopied(true)
        // Reset after a short beat so a follow-up copy on the same
        // banner can still flash the visual confirmation.
        window.setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => {
        // Permission denied or unsupported (Safari private mode w/o
        // gesture). Stay silent — the trace id is still visible
        // on-screen so the user can hand-copy it.
      })
  }, [requestId])

  return (
    <div
      className={['mt-2 flex items-center gap-2 text-[11px] text-ink-3', className].filter(Boolean).join(' ')}
      data-testid="trace-id-footer"
    >
      <span className="font-mono truncate" title={requestId}>
        Trace ID: {requestId}
      </span>
      <button
        type="button"
        onClick={onCopy}
        className="text-[11px] font-semibold underline-offset-2 hover:underline shrink-0"
        aria-label={copied ? 'Trace ID copied' : 'Copy trace ID'}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
