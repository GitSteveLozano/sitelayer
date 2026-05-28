/**
 * Owner broadcast — the one-way megaphone (Desktop v2). Owner picks an
 * audience (everyone / foremen / crew), types one message, and fires it at
 * the whole company. Replies are off by design; this is announcements only
 * (emergencies, weather, policy). The right rail is the audit trail of what
 * already went out.
 *
 * Desktop sibling of screens/mobile/broadcast.tsx — same messaging hooks
 * (useBroadcasts / usePostBroadcast), recomposed into the .d-content +
 * .d-split desktop shell. Mono micro-labels, square 2px ink borders,
 * full-yellow active audience chip.
 */
import { useState } from 'react'
import type { BroadcastAudience } from '@sitelayer/domain'
import { DEyebrow, DH1 } from '@/components/d'
import { MButton, MChip, MPill, MTextarea } from '@/components/m'
import { useBroadcasts, usePostBroadcast } from '../../lib/api/messaging.js'

const AUDIENCES: ReadonlyArray<{ value: BroadcastAudience; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'foremen', label: 'Foremen' },
  { value: 'crew', label: 'Crew' },
]

const AUDIENCE_LABEL: Record<BroadcastAudience, string> = {
  all: 'ALL',
  foremen: 'FOREMEN',
  crew: 'CREW',
}

const MONO: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  letterSpacing: '0.06em',
}

export function OwnerBroadcast() {
  const [audience, setAudience] = useState<BroadcastAudience>('all')
  const [body, setBody] = useState('')

  const broadcastsQuery = useBroadcasts()
  const post = usePostBroadcast()

  const broadcasts = broadcastsQuery.data?.broadcasts ?? []

  const trimmed = body.trim()
  const canSend = trimmed.length > 0 && !post.isPending

  const handleSend = () => {
    if (!canSend) return
    post.mutate({ body: trimmed, audience }, { onSuccess: () => setBody('') })
  }

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Comms · Broadcast</DEyebrow>
          <DH1>Broadcast</DH1>
          <div
            style={{
              ...MONO,
              fontSize: 12,
              fontWeight: 600,
              lineHeight: 1.5,
              color: 'var(--m-ink-3)',
              marginTop: 8,
            }}
          >
            ONE-WAY MEGAPHONE · REPLIES OFF. EMERGENCIES · WEATHER · POLICY.
          </div>
        </div>

        <div className="d-split">
          {/* LEFT — compose. */}
          <div className="d-card">
            <div style={{ ...MONO, fontSize: 11, fontWeight: 600, color: 'var(--m-ink-3)', marginBottom: 8 }}>TO</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {AUDIENCES.map((a) => (
                <MChip key={a.value} active={audience === a.value} onClick={() => setAudience(a.value)}>
                  {a.label}
                </MChip>
              ))}
            </div>

            <div style={{ ...MONO, fontSize: 11, fontWeight: 600, color: 'var(--m-ink-3)', margin: '20px 0 8px' }}>
              MESSAGE
            </div>
            <MTextarea
              value={body}
              onChange={(e) => setBody(e.currentTarget.value)}
              placeholder="Heads up — rain forecast for Wednesday. Wrap exterior coats by lunch Tuesday."
              style={{ width: '100%', minHeight: 160 }}
            />

            {post.isError ? (
              <div
                style={{
                  ...MONO,
                  marginTop: 12,
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--m-red)',
                }}
              >
                COULDN&apos;T SEND — {post.error instanceof Error ? post.error.message.toUpperCase() : 'TRY AGAIN.'}
              </div>
            ) : null}

            <div style={{ marginTop: 16 }}>
              <MButton variant="primary" disabled={!canSend} onClick={handleSend}>
                {post.isPending ? 'Sending…' : 'Send broadcast'}
              </MButton>
            </div>
          </div>

          {/* RIGHT — audit trail. */}
          <div className="d-card">
            <div style={{ ...MONO, fontSize: 11, fontWeight: 600, color: 'var(--m-ink-3)', marginBottom: 12 }}>
              RECENT BROADCASTS
            </div>
            <RecentList broadcasts={broadcasts} loading={broadcastsQuery.isLoading} />
          </div>
        </div>
      </div>
    </div>
  )
}

function RecentList({
  broadcasts,
  loading,
}: {
  broadcasts: ReadonlyArray<{ id: string; audience: BroadcastAudience; body: string; created_at: string }>
  loading: boolean
}) {
  if (loading) {
    return (
      <div style={{ ...MONO, fontSize: 11, fontWeight: 600, color: 'var(--m-ink-4)', padding: '4px 0' }}>LOADING…</div>
    )
  }
  if (broadcasts.length === 0) {
    return (
      <div style={{ ...MONO, fontSize: 11, fontWeight: 600, color: 'var(--m-ink-4)', padding: '4px 0' }}>
        NOTHING SENT YET.
      </div>
    )
  }
  return (
    <div style={{ borderTop: '2px solid var(--m-line)' }}>
      {broadcasts.map((b) => (
        <div key={b.id} style={{ padding: '14px 0', borderBottom: '2px solid var(--m-line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <MPill>{AUDIENCE_LABEL[b.audience]}</MPill>
            <span style={{ ...MONO, fontSize: 10, fontWeight: 600, color: 'var(--m-ink-4)' }}>
              {formatBroadcastTime(b.created_at)}
            </span>
          </div>
          <div style={{ marginTop: 8, fontSize: 14, fontWeight: 600, lineHeight: 1.4, color: 'var(--m-ink)' }}>
            {b.body}
          </div>
        </div>
      ))}
    </div>
  )
}

function formatBroadcastTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.toUpperCase()
  return d
    .toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    .toUpperCase()
}
