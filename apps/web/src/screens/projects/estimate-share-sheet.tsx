import { useEffect, useState, type ReactNode } from 'react'
import { MBanner, MButton, MI, MListRow } from '@/components/m'
import { useEstimateShareMachine } from '@/machines/estimate-share'
import { useEstimateShares } from '@/lib/api/estimate-shares'

/**
 * Bottom sheet that captures recipient info and creates a public
 * estimate share link via POST /api/projects/:id/estimate/share.
 *
 * Two phases inside the sheet:
 *   1. form  — recipient email + name + expiry days, submit
 *   2. sent  — show the share_url with a copy button + mailto/sms rows
 *
 * The list of past shares for this project is rendered below the form
 * so the operator can see who has been sent to (and which links are
 * already accepted/declined).
 */
export type EstimateShareSheetProps = {
  open: boolean
  onClose: () => void
  projectId: string
  /** Optional default recipient (e.g. customer email already on file). */
  defaultEmail?: string
  defaultName?: string
}

export function EstimateShareSheet({ open, onClose, projectId, defaultEmail, defaultName }: EstimateShareSheetProps) {
  const [email, setEmail] = useState(defaultEmail ?? '')
  const [name, setName] = useState(defaultName ?? '')
  const [days, setDays] = useState<number>(30)
  const machine = useEstimateShareMachine(projectId)
  const shares = useEstimateShares(open ? projectId : null)
  const [copied, setCopied] = useState(false)

  // Reset the form whenever the sheet is opened so a fresh send
  // doesn't carry stale state from the previous one.
  useEffect(() => {
    if (open) {
      setEmail(defaultEmail ?? '')
      setName(defaultName ?? '')
      setDays(30)
      setCopied(false)
      machine.reset()
    }
  }, [open, defaultEmail, defaultName])

  const onSubmit = () => {
    const trimmedName = name.trim()
    machine.submit({
      recipient_email: email.trim(),
      ...(trimmedName ? { recipient_name: trimmedName } : {}),
      expires_in_days: days,
    })
  }

  const onCopy = async () => {
    if (!machine.result) return
    try {
      await navigator.clipboard.writeText(machine.result.share_url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API blocked — the URL is still visible in the sheet.
    }
  }

  if (!open) return null

  return (
    <MSheet title="Send estimate to client" onClose={onClose}>
      {!machine.result ? (
        <FormPhase
          email={email}
          setEmail={setEmail}
          name={name}
          setName={setName}
          days={days}
          setDays={setDays}
          isSending={machine.isSending}
          error={machine.error}
          onSubmit={onSubmit}
        />
      ) : (
        <SentPhase
          shareUrl={machine.result.share_url}
          recipientEmail={machine.result.recipient_email ?? email}
          copied={copied}
          onCopy={onCopy}
          onSendAnother={() => machine.reset()}
        />
      )}

      {/* History — only render when we have data so we don't flicker. */}
      {shares.data ? (
        <div className="mt-5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-2">Previously sent</div>
          {shares.data.shares.length > 0 ? (
            <div className="m-list-inset" style={{ margin: 0 }}>
              {shares.data.shares.slice(0, 8).map((share) => (
                <MListRow
                  key={share.id}
                  leadingTone={statusTone(share.status)}
                  leading={<span className="text-[10px] font-semibold">{statusInitial(share.status)}</span>}
                  headline={share.recipient_email ?? '—'}
                  supporting={`${prettyStatus(share.status)} · ${formatRelative(share.sent_at)}`}
                />
              ))}
            </div>
          ) : (
            <div className="m-card m-card-tight text-[12px] text-ink-3">No share links sent yet.</div>
          )}
        </div>
      ) : null}
    </MSheet>
  )
}

/**
 * Bottom sheet in the `.m-sheet` idiom (styles/m.css — square corners, 2px
 * ink top rule, hard offset shadow, no grabber/blur). Same pattern as the
 * AssignmentSheet swap in screens/mobile/schedule.tsx (e9b7c7f3) and the R1
 * SettingsSheet; replaces the retired wave-2 kit Sheet. ESC and backdrop-tap
 * dismiss.
 */
function MSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'rgba(15, 14, 12, 0.5)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="m-sheet" style={{ maxWidth: 720 }}>
        <div className="m-sheet-header">
          <div className="m-sheet-title">{title}</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 4,
              color: 'var(--m-ink)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <MI.X size={20} />
          </button>
        </div>
        <div className="m-sheet-body" style={{ padding: '16px 20px 0' }}>
          {children}
        </div>
      </div>
    </div>
  )
}

function FormPhase({
  email,
  setEmail,
  name,
  setName,
  days,
  setDays,
  isSending,
  error,
  onSubmit,
}: {
  email: string
  setEmail: (v: string) => void
  name: string
  setName: (v: string) => void
  days: number
  setDays: (v: number) => void
  isSending: boolean
  error: string | null
  onSubmit: () => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-ink-3">
        We'll create a unique, signed link the customer can open without an account. Accept and decline are recorded
        with their signature.
      </p>

      <Field label="Recipient email">
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="m-input"
          placeholder="client@example.com"
        />
      </Field>

      <Field label="Recipient name (optional)">
        <input value={name} onChange={(e) => setName(e.target.value)} className="m-input" placeholder="Pat Customer" />
      </Field>

      <Field label="Link expires after">
        <select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="m-input">
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
          <option value="60">60 days</option>
          <option value="90">90 days</option>
        </select>
      </Field>

      {error ? (
        // `.m-banner` carries 10/16 margins; pull them back so the banner
        // lines up with the sheet-body fields.
        <div className="-mx-4 -my-2.5">
          <MBanner tone="error" title="Could not send" body={error} />
        </div>
      ) : null}

      <div className="pt-1">
        <MButton variant="primary" disabled={isSending || !email.trim()} onClick={onSubmit}>
          {isSending ? 'Creating link…' : 'Create share link'}
        </MButton>
      </div>
    </div>
  )
}

function SentPhase({
  shareUrl,
  recipientEmail,
  copied,
  onCopy,
  onSendAnother,
}: {
  shareUrl: string
  recipientEmail: string
  copied: boolean
  onCopy: () => void
  onSendAnother: () => void
}) {
  const onEmail = () => {
    const subject = encodeURIComponent('Your estimate')
    const body = encodeURIComponent(`Review and accept your estimate here:\n\n${shareUrl}`)
    window.location.href = `mailto:${encodeURIComponent(recipientEmail)}?subject=${subject}&body=${body}`
  }
  const onText = () => {
    const body = encodeURIComponent(`Review your estimate: ${shareUrl}`)
    window.location.href = `sms:?&body=${body}`
  }

  const rows: ReadonlyArray<{ icon: ReactNode; headline: string; supporting: string; onClick: () => void }> = [
    {
      icon: <span className="text-[10px] font-semibold">@</span>,
      headline: 'Email this link',
      supporting: recipientEmail || 'Open your mail client',
      onClick: onEmail,
    },
    {
      icon: <span className="text-[10px] font-semibold">SMS</span>,
      headline: 'Send by text',
      supporting: 'Best if you have the customer phone number',
      onClick: onText,
    },
    {
      icon: <span className="text-[10px] font-semibold">⧉</span>,
      headline: copied ? 'Copied to clipboard' : 'Copy link',
      supporting: shareUrl,
      onClick: onCopy,
    },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="-mx-4 -my-2.5">
        <MBanner tone="ok" title="Share link created" body="Send it to the customer below." />
      </div>
      <div className="m-list-inset" style={{ margin: 0 }}>
        {rows.map((r, i) => (
          <MListRow
            key={i}
            leadingTone="accent"
            leading={r.icon}
            headline={r.headline}
            supporting={r.supporting}
            onTap={r.onClick}
          />
        ))}
      </div>
      <div className="pt-1">
        <MButton variant="ghost" onClick={onSendAnother}>
          Create another link
        </MButton>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-[0.06em] text-ink-3">{label}</span>
      {children}
    </label>
  )
}

function statusTone(status: 'pending' | 'accepted' | 'declined' | 'expired'): 'accent' | 'green' | 'amber' | 'red' {
  if (status === 'accepted') return 'green'
  if (status === 'declined') return 'red'
  if (status === 'expired') return 'amber'
  return 'accent'
}

function statusInitial(status: 'pending' | 'accepted' | 'declined' | 'expired'): string {
  if (status === 'accepted') return '✓'
  if (status === 'declined') return '✕'
  if (status === 'expired') return '⏱'
  return '·'
}

function prettyStatus(status: 'pending' | 'accepted' | 'declined' | 'expired'): string {
  if (status === 'accepted') return 'Accepted'
  if (status === 'declined') return 'Declined'
  if (status === 'expired') return 'Expired'
  return 'Pending'
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return iso
  if (ms < 60_000) return 'just now'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  if (days < 30) return `${days}d ago`
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}
