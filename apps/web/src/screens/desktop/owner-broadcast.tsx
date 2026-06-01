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
import { useMemo, useState } from 'react'
import type { BroadcastAudience } from '@sitelayer/domain'
import { DEyebrow, DH1 } from '@/components/d'
import { MButton, MChip, MPill, MSelect, MTextarea } from '@/components/m'
import { useBroadcasts, usePostBroadcast } from '../../lib/api/messaging.js'
import { useProjects } from '../../lib/api/projects.js'
import { useWorkers } from '../../lib/api/workers.js'

const AUDIENCE_LABEL: Record<BroadcastAudience, string> = {
  all: 'ALL',
  foremen: 'FOREMEN',
  crew: 'CREW',
}

// UI-level audience selection. `by_project` is not a wire audience — it posts
// `audience: 'all'` scoped by `project_id` (the messaging API already accepts an
// optional `project_id` on a broadcast). The other three map 1:1 onto the domain
// BroadcastAudience. Mirrors screens/mobile/broadcast.tsx.
type AudienceChoice = BroadcastAudience | 'by_project'

const MAX_BROADCAST_CHARS = 280

const MONO: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  letterSpacing: '0.06em',
}

export function OwnerBroadcast() {
  const [audience, setAudience] = useState<AudienceChoice>('all')
  const [projectId, setProjectId] = useState<string>('')
  const [body, setBody] = useState('')

  const broadcastsQuery = useBroadcasts()
  const workersQuery = useWorkers()
  const projectsQuery = useProjects({ limit: 100 })
  const post = usePostBroadcast()

  const broadcasts = broadcastsQuery.data?.broadcasts ?? []
  const projects = projectsQuery.data?.projects ?? []

  // Audience head-counts off the live company roster. Foremen are matched by
  // role token; everyone else counts as crew. `all` is the full roster.
  const counts = useMemo(() => {
    const workers = workersQuery.data?.workers ?? []
    const foremen = workers.filter((w) => /foreman/i.test(w.role)).length
    const all = workers.length
    return { all, foremen, crew: all - foremen }
  }, [workersQuery.data?.workers])

  const audienceChips: ReadonlyArray<{ value: AudienceChoice; label: string; count?: number }> = [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'foremen', label: 'Foremen', count: counts.foremen },
    { value: 'crew', label: 'Crew', count: counts.crew },
    { value: 'by_project', label: 'By project' },
  ]

  const trimmed = body.trim()
  const overLimit = body.length > MAX_BROADCAST_CHARS
  const projectRequiredButMissing = audience === 'by_project' && !projectId
  const canSend = trimmed.length > 0 && !overLimit && !projectRequiredButMissing && !post.isPending

  const sendCount =
    audience === 'by_project'
      ? null
      : audience === 'all'
        ? counts.all
        : audience === 'foremen'
          ? counts.foremen
          : counts.crew

  const handleSend = () => {
    if (!canSend) return
    const payload =
      audience === 'by_project'
        ? { body: trimmed, audience: 'all' as BroadcastAudience, project_id: projectId }
        : { body: trimmed, audience }
    post.mutate(payload, { onSuccess: () => setBody('') })
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
              {audienceChips.map((a) => (
                <MChip key={a.value} active={audience === a.value} onClick={() => setAudience(a.value)}>
                  {a.label}
                  {typeof a.count === 'number' ? ` · ${a.count}` : ''}
                </MChip>
              ))}
            </div>

            {/* BY PROJECT → scope the broadcast to one project's crew. */}
            {audience === 'by_project' ? (
              <div style={{ marginTop: 10 }}>
                <MSelect
                  value={projectId}
                  onChange={(e) => setProjectId(e.currentTarget.value)}
                  style={{ width: '100%' }}
                  aria-label="Project"
                >
                  <option value="">Pick a project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </MSelect>
              </div>
            ) : null}

            <div style={{ ...MONO, fontSize: 11, fontWeight: 600, color: 'var(--m-ink-3)', margin: '20px 0 8px' }}>
              MESSAGE
            </div>
            <MTextarea
              value={body}
              onChange={(e) => setBody(e.currentTarget.value)}
              maxLength={MAX_BROADCAST_CHARS}
              placeholder="Heads up — rain forecast for Wednesday. Wrap exterior coats by lunch Tuesday."
              style={{ width: '100%', minHeight: 160 }}
            />
            <div
              style={{
                ...MONO,
                marginTop: 6,
                fontSize: 10,
                fontWeight: 600,
                textAlign: 'right',
                color: overLimit ? 'var(--m-red)' : 'var(--m-ink-3)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {body.length} / {MAX_BROADCAST_CHARS}
            </div>

            {/* Delivery channel tile — every broadcast fans out to all three. */}
            <div style={{ ...MONO, fontSize: 11, fontWeight: 600, color: 'var(--m-ink-3)', margin: '20px 0 8px' }}>
              DELIVERY
            </div>
            <div
              style={{
                padding: '12px 14px',
                background: 'var(--m-card-soft)',
                border: '2px solid var(--m-ink)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 14,
                  background: 'var(--m-accent)',
                  border: '1.5px solid var(--m-ink)',
                  flexShrink: 0,
                }}
              />
              <span style={{ ...MONO, flex: 1, fontSize: 11, fontWeight: 600 }}>PUSH · SMS · EMAIL · ALL THREE</span>
            </div>

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
                {post.isPending
                  ? 'Sending…'
                  : audience === 'by_project'
                    ? 'Broadcast to project'
                    : `Broadcast to ${sendCount ?? 0}`}
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
  broadcasts: ReadonlyArray<{
    id: string
    audience: BroadcastAudience
    body: string
    created_at: string
    project_id?: string | null
  }>
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
            <MPill>{b.project_id ? 'BY PROJECT' : AUDIENCE_LABEL[b.audience]}</MPill>
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
