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
  MPill,
  MSectionH,
  MSelect,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'
import { useBroadcasts, usePostBroadcast } from '../../lib/api/messaging.js'
import { useProjects } from '../../lib/api/projects.js'
import { useWorkers } from '../../lib/api/workers.js'

const AUDIENCE_LABEL: Record<BroadcastAudience, string> = {
  all: 'ALL',
  foremen: 'FOREMEN',
  crew: 'CREW',
}

// UI-level audience selection. `by_project` is not a wire audience — it posts
// `audience: 'all'` scoped by `project_id` (the messaging API already accepts
// an optional `project_id` on a broadcast). The other three map 1:1 onto the
// domain BroadcastAudience.
type AudienceChoice = BroadcastAudience | 'by_project'

const MAX_BROADCAST_CHARS = 280

const MONO: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  letterSpacing: '0.06em',
}

export function MobileBroadcast() {
  const navigate = useNavigate()
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

  const audienceTiles: ReadonlyArray<{ value: AudienceChoice; label: string; count?: number }> = [
    { value: 'all', label: 'ALL', count: counts.all },
    { value: 'foremen', label: 'FOREMEN', count: counts.foremen },
    { value: 'crew', label: 'CREW', count: counts.crew },
    { value: 'by_project', label: 'BY PROJECT' },
  ]

  const trimmed = body.trim()
  const overLimit = body.length > MAX_BROADCAST_CHARS
  const projectRequiredButMissing = audience === 'by_project' && !projectId
  const canSend = trimmed.length > 0 && !overLimit && !projectRequiredButMissing && !post.isPending

  const sendCount =
    audience === 'by_project' ? null : audience === 'all' ? counts.all : audience === 'foremen' ? counts.foremen : counts.crew

  const handleSend = () => {
    if (!canSend) return
    const payload =
      audience === 'by_project'
        ? { body: trimmed, audience: 'all' as BroadcastAudience, project_id: projectId }
        : { body: trimmed, audience }
    post.mutate(payload, {
      onSuccess: () => setBody(''),
    })
  }

  return (
    <>
      <MTopBar back title="Broadcast" onBack={() => navigate(-1)} />
      <MBody pad>
        <div style={{ ...MONO, fontSize: 12, fontWeight: 600, lineHeight: 1.5, color: 'var(--m-ink-3)' }}>
          ONE-WAY MEGAPHONE · REPLIES OFF. EMERGENCIES · WEATHER · POLICY.
        </div>

        {/* Audience selector — 2×2 grid of square tiles with head-counts,
            full-yellow active tile per the v2 reference. */}
        <div className="m-topbar-eyebrow" style={{ margin: '18px 0 8px' }}>
          TO
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 0,
            border: '2px solid var(--m-ink)',
          }}
        >
          {audienceTiles.map((t, i) => {
            const on = audience === t.value
            const isRight = i % 2 === 1
            const isLastRow = i >= 2
            return (
              <button
                key={t.value}
                type="button"
                aria-pressed={on}
                onClick={() => setAudience(t.value)}
                style={{
                  padding: '16px 0',
                  background: on ? 'var(--m-accent)' : 'transparent',
                  color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                  border: 'none',
                  borderRight: isRight ? 'none' : '2px solid var(--m-ink)',
                  borderBottom: isLastRow ? 'none' : '2px solid var(--m-ink)',
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  cursor: 'pointer',
                }}
              >
                {t.label}
                {typeof t.count === 'number' ? ` · ${t.count}` : ''}
              </button>
            )
          })}
        </div>

        {/* BY PROJECT → scope the broadcast to one project's crew. */}
        {audience === 'by_project' ? (
          <div style={{ marginTop: 10 }}>
            <MSelect value={projectId} onChange={(e) => setProjectId(e.currentTarget.value)} style={{ width: '100%' }}>
              <option value="">Pick a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </MSelect>
          </div>
        ) : null}

        {/* Message body + char counter. */}
        <div className="m-topbar-eyebrow" style={{ margin: '18px 0 8px' }}>
          MESSAGE
        </div>
        <MTextarea
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
          maxLength={MAX_BROADCAST_CHARS}
          placeholder="Heads up — rain forecast for Wednesday. Wrap exterior coats by lunch Tuesday."
          style={{ width: '100%', minHeight: 120 }}
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
        <div className="m-topbar-eyebrow" style={{ margin: '18px 0 8px' }}>
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
          <span style={{ width: 14, height: 14, background: 'var(--m-accent)', border: '1.5px solid var(--m-ink)', flexShrink: 0 }} />
          <span style={{ ...MONO, flex: 1, fontSize: 11, fontWeight: 600 }}>PUSH · SMS · EMAIL · ALL THREE</span>
        </div>

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
            {post.isPending
              ? 'Sending…'
              : audience === 'by_project'
                ? 'Broadcast to project'
                : `Broadcast to ${sendCount ?? 0}`}
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
      <div style={{ ...MONO, fontSize: 11, fontWeight: 600, color: 'var(--m-ink-4)', padding: '12px 0' }}>LOADING…</div>
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
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <MPill>{b.project_id ? 'BY PROJECT' : AUDIENCE_LABEL[b.audience]}</MPill>
            </span>
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
