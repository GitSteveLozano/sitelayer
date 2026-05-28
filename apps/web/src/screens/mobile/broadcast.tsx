/**
 * Owner broadcast — the one-way megaphone (v2 brutalist). Owner picks an
 * audience (everyone / foremen / crew), types one message, and fires it at
 * the whole company. Replies are off by design; this is announcements only
 * (emergencies, weather, policy). The "Recent" list below is the audit
 * trail of what already went out.
 *
 * Mirrors the V2Broadcast reference: mono micro-labels, square 2px ink
 * borders, full-yellow active audience tile. Data flows through the
 * messaging hooks (useBroadcasts / usePostBroadcast) — no local mock.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BroadcastAudience } from '@sitelayer/domain'
import {
  MBanner,
  MBody,
  MButton,
  MChip,
  MChipRow,
  MPill,
  MSectionH,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'
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

export function MobileBroadcast() {
  const navigate = useNavigate()
  const [audience, setAudience] = useState<BroadcastAudience>('all')
  const [body, setBody] = useState('')

  const broadcastsQuery = useBroadcasts()
  const post = usePostBroadcast()

  const broadcasts = broadcastsQuery.data?.broadcasts ?? []

  const trimmed = body.trim()
  const canSend = trimmed.length > 0 && !post.isPending

  const handleSend = () => {
    if (!canSend) return
    post.mutate(
      { body: trimmed, audience },
      {
        onSuccess: () => setBody(''),
      },
    )
  }

  return (
    <>
      <MTopBar back title="Broadcast" onBack={() => navigate(-1)} />
      <MBody pad>
        <div style={{ ...MONO, fontSize: 12, fontWeight: 600, lineHeight: 1.5, color: 'var(--m-ink-3)' }}>
          ONE-WAY MEGAPHONE · REPLIES OFF. EMERGENCIES · WEATHER · POLICY.
        </div>

        {/* Audience selector — full-yellow active chip per the v2 reference. */}
        <div className="m-topbar-eyebrow" style={{ margin: '18px 0 8px' }}>
          TO
        </div>
        <MChipRow>
          {AUDIENCES.map((a) => (
            <MChip key={a.value} active={audience === a.value} onClick={() => setAudience(a.value)}>
              {a.label}
            </MChip>
          ))}
        </MChipRow>

        {/* Message body. */}
        <div className="m-topbar-eyebrow" style={{ margin: '18px 0 8px' }}>
          MESSAGE
        </div>
        <MTextarea
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
          placeholder="Heads up — rain forecast for Wednesday. Wrap exterior coats by lunch Tuesday."
          style={{ width: '100%', minHeight: 120 }}
        />

        {post.isError ? (
          <div style={{ marginTop: 12 }}>
            <MBanner
              tone="error"
              title="Couldn't send the broadcast"
              body={post.error instanceof Error ? post.error.message : 'Try again.'}
            />
          </div>
        ) : null}

        <div style={{ marginTop: 16 }}>
          <MButton variant="primary" disabled={!canSend} onClick={handleSend}>
            {post.isPending ? 'Sending…' : 'Send broadcast'}
          </MButton>
        </div>

        {/* Recent — audit trail of what's already gone out. */}
        <div style={{ marginTop: 28 }}>
          <MSectionH>Recent</MSectionH>
          <RecentList broadcasts={broadcasts} loading={broadcastsQuery.isLoading} />
        </div>
      </MBody>
    </>
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
      <div style={{ ...MONO, fontSize: 11, fontWeight: 600, color: 'var(--m-ink-4)', padding: '12px 0' }}>
        LOADING…
      </div>
    )
  }
  if (broadcasts.length === 0) {
    return (
      <div style={{ ...MONO, fontSize: 11, fontWeight: 600, color: 'var(--m-ink-4)', padding: '12px 0' }}>
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
          <div style={{ marginTop: 8, fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: 'var(--m-ink)' }}>
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
