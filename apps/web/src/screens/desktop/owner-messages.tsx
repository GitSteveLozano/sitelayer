/**
 * Owner desktop MESSAGES (Desktop v2 · project chat). A classic two-pane
 * inbox: the left pane lists every project as a selectable thread, the
 * right pane shows the selected project's cross-role conversation with
 * role-tagged MPill chips, hard-bordered square bubbles, and a composer
 * (MInput/MTextarea + Send MButton via usePostProjectMessage).
 *
 * Built on the components/d page head (DEyebrow / DH1) + components/m
 * primitives on the shared var(--m-*) tokens (no new global CSS). The
 * two-pane grid is inline (fixed 280px left + flexible right) since the
 * message inbox wants a fixed thread rail, not .d-split's aside. The
 * thread list + bubble approach mirror screens/mobile/chat.tsx.
 */
import { useMemo, useState } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import type { ProjectMessage } from '@/lib/api/messaging'
import { useMessageSummary, useProjectMessages, usePostProjectMessage } from '@/lib/api/messaging'
import { useProjectAssignments } from '@/lib/api/project-assignments'
import { DEyebrow, DH1 } from '@/components/d'
import { MButton, MInput, MPill } from '@/components/m'
import type { MTone } from '@/components/m'

const MONO = 'var(--m-num)'

/**
 * Maps an author role onto the m-* tone palette, matching the mobile
 * chat.tsx reference so a given role reads the same color on every surface:
 * OWNER/ADMIN = green, FOREMAN = accent (brand yellow), CREW/everyone-else =
 * plain ink (the default MPill look).
 */
function roleTone(role: string): MTone | undefined {
  const r = (role || '').toLowerCase()
  if (r.includes('owner') || r.includes('admin')) return 'green'
  if (r.includes('foreman')) return 'accent'
  return undefined
}

/**
 * Display name for a message author. The author id is a Clerk user id
 * (`project_messages.author_user_id`), which matches
 * `project_assignments.clerk_user_id`; the assignments endpoint resolves that
 * against the clerk_users mirror and returns `assignee_name`. Falls back to a
 * readable id token when the author isn't a (mapped) assignee. Mirrors mobile
 * chat.tsx.
 */
function displayName(authorUserId: string, names: ReadonlyMap<string, string>): string {
  const id = authorUserId || ''
  const resolved = names.get(id)
  if (resolved) return resolved
  if (!/^user_/i.test(id) && !/^[0-9a-f-]{20,}$/i.test(id)) return id
  return id.length > 12 ? `…${id.slice(-8)}` : id
}

/** Format a numeric amount as `$1,234` / `$1,234.50` for marker labels. */
function formatAmount(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

/**
 * Does this message read as a field-intake-linked blocker? Prefers the
 * structured marker (`meta.linked_field_event_id`) and falls back to the legacy
 * body heuristic for rows written before the column existed. Mirrors mobile
 * chat.tsx.
 */
function attachedBlocker(m: ProjectMessage): string | null {
  if (m.meta?.linked_field_event_id) return 'AUTO-LINKED FROM FIELD INTAKE'
  const body = (m.body || '').toLowerCase()
  if (/out of |blocker|need \d+|ran out|short on/.test(body)) return 'AUTO-LINKED FROM FIELD INTAKE'
  return null
}

/**
 * Should this message render as a highlighted approval bubble? Prefers the
 * structured marker (`meta.kind === 'approval'`, optional `meta.amount`) and
 * falls back to the legacy body-prefix heuristic. Mirrors mobile chat.tsx.
 */
function approvalHighlight(m: ProjectMessage): string | null {
  if (m.meta?.kind === 'approval') {
    return typeof m.meta.amount === 'number' ? `APPROVED ${formatAmount(m.meta.amount)}` : 'APPROVED'
  }
  const body = (m.body || '').trim()
  if (!/^approved\b/i.test(body)) return null
  const amount = body.match(/\$[\d,]+(?:\.\d{2})?/)?.[0]
  return amount ? `APPROVED ${amount}` : 'APPROVED'
}

function relativeTime(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.valueOf())) return ''
  const diffMs = Date.now() - then.valueOf()
  const min = Math.round(diffMs / 60000)
  if (min < 1) return 'NOW'
  if (min < 60) return `${min}M`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}H`
  const day = Math.round(hr / 24)
  if (day === 1) return 'YEST'
  if (day < 7) return `${day}D`
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
}

function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.valueOf())) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export function OwnerMessages({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)

  const selected = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  )

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Comms · Messages</DEyebrow>
          <DH1>Messages</DH1>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '280px minmax(0, 1fr)',
            border: '2px solid var(--m-ink)',
            background: 'var(--m-card)',
            minHeight: 480,
          }}
        >
          {/* ---- Left pane: project thread list ---- */}
          <div
            style={{ borderRight: '2px solid var(--m-ink)', display: 'flex', flexDirection: 'column', minHeight: 0 }}
          >
            <div
              style={{
                fontFamily: MONO,
                fontSize: 10,
                fontWeight: 500,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--m-ink-3)',
                padding: '14px 16px',
                borderBottom: '2px solid var(--m-ink)',
              }}
            >
              Threads · {projects.length}
            </div>
            {projects.length === 0 ? (
              <div style={{ padding: '16px', color: 'var(--m-ink-3)', fontSize: 13 }}>
                No projects yet. Every project gets a shared thread once it exists.
              </div>
            ) : (
              <div style={{ overflowY: 'auto', minHeight: 0 }}>
                {projects.map((p) => (
                  <ThreadListRow
                    key={p.id}
                    projectId={p.id}
                    name={p.name}
                    fallbackPreview={`${p.customer_name} · ${p.division_code}`}
                    fallbackTime={p.updated_at}
                    active={p.id === selectedProjectId}
                    onSelect={() => setSelectedProjectId(p.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* ---- Right pane: selected thread ---- */}
          {selected ? (
            <MessageThread key={selected.id} projectId={selected.id} projectName={selected.name} />
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '48px 24px',
                color: 'var(--m-ink-3)',
                fontSize: 14,
                textAlign: 'center',
              }}
            >
              Select a project on the left to open its cross-role thread.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * One project's thread-list row. Pulls the thread summary (last-message
 * preview + the caller's unread count) from GET /api/projects/:id/messages/summary
 * so the row shows a real last-message line and an unread badge — mirroring
 * mobile chat.tsx ChatListRow. Falls back to the customer/division line and the
 * project's updated_at when the thread is empty.
 */
function ThreadListRow({
  projectId,
  name,
  fallbackPreview,
  fallbackTime,
  active,
  onSelect,
}: {
  projectId: string
  name: string
  fallbackPreview: string
  fallbackTime: string
  active: boolean
  onSelect: () => void
}) {
  const { data: summary } = useMessageSummary(projectId)
  const last = summary?.last_message ?? null
  const unread = summary?.unread_count ?? 0
  const preview = last ? last.body : fallbackPreview
  const time = last ? relativeTime(last.created_at) : relativeTime(fallbackTime)

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        border: 'none',
        borderBottom: '1px solid var(--m-line-2)',
        padding: '12px 16px',
        background: active ? 'var(--m-accent)' : 'transparent',
        color: active ? 'var(--m-accent-ink)' : 'var(--m-ink)',
        font: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: 'var(--m-font-display)',
            fontWeight: 700,
            fontSize: 15,
            letterSpacing: '-0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </div>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10,
            fontWeight: 700,
            color: active ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
            flexShrink: 0,
          }}
        >
          {time}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: MONO,
            fontSize: 11,
            color: active ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {preview}
        </span>
        {unread > 0 ? (
          <span
            style={{
              padding: '2px 6px',
              background: active ? 'var(--m-accent-ink)' : 'var(--m-accent)',
              color: active ? 'var(--m-accent)' : 'var(--m-accent-ink)',
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 800,
              border: '1.5px solid var(--m-ink)',
              fontVariantNumeric: 'tabular-nums',
              flexShrink: 0,
            }}
          >
            {unread}
          </span>
        ) : null}
      </div>
    </button>
  )
}

function MessageThread({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { data, isLoading } = useProjectMessages(projectId)
  const assignments = useProjectAssignments(projectId)
  const post = usePostProjectMessage(projectId)
  const [draft, setDraft] = useState('')

  const messages = data?.messages ?? []

  // Resolve author clerk_user_ids → display names from the project roster, the
  // same way mobile chat.tsx does. assignee_name is the clerk_users-mirror name
  // or null when unmapped; we only seed the map for ids that resolved.
  const authorNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of assignments.data?.assignments ?? []) {
      if (a.assignee_name) map.set(a.clerk_user_id, a.assignee_name)
    }
    return map
  }, [assignments.data?.assignments])

  const send = () => {
    const body = draft.trim()
    if (!body || post.isPending) return
    post.mutate({ body }, { onSuccess: () => setDraft('') })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          padding: '14px 18px',
          borderBottom: '2px solid var(--m-ink)',
        }}
      >
        <span style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 18, letterSpacing: '-0.01em' }}>
          {projectName}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--m-ink-3)' }}>
          {messages.length} {messages.length === 1 ? 'message' : 'messages'}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 18px' }}>
        {isLoading && messages.length === 0 ? (
          <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--m-ink-3)' }}>LOADING…</div>
        ) : messages.length === 0 ? (
          <div style={{ color: 'var(--m-ink-3)', fontSize: 13 }}>No messages yet. Start the conversation below.</div>
        ) : (
          messages.map((m) => <MessageRow key={m.id} message={m} authorNames={authorNames} />)
        )}
      </div>

      <div
        style={{
          padding: '12px 18px',
          borderTop: '2px solid var(--m-ink)',
          background: 'var(--m-card)',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <MInput
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Type a message…"
          aria-label="Message"
          style={{ flex: 1 }}
        />
        <MButton
          variant="primary"
          onClick={send}
          disabled={post.isPending || draft.trim().length === 0}
          aria-label="Send"
        >
          Send
        </MButton>
      </div>
    </div>
  )
}

function MessageRow({ message, authorNames }: { message: ProjectMessage; authorNames: ReadonlyMap<string, string> }) {
  const tone = roleTone(message.author_role)
  const attached = attachedBlocker(message)
  const highlight = approvalHighlight(message)
  return (
    <div style={{ marginBottom: 14 }}>
      {/* Auto-linked-from-field-intake banner — red, sits above the message. */}
      {attached ? (
        <div
          style={{
            padding: '8px 10px',
            background: 'var(--m-red)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 6,
            border: '1.5px solid var(--m-ink)',
          }}
        >
          <span style={{ width: 8, height: 8, background: '#fff', flexShrink: 0 }} />
          <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em' }}>
            BLOCKER · {attached}
          </span>
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 800, color: 'var(--m-ink)' }}>
          {displayName(message.author_user_id, authorNames)}
        </span>
        <MPill tone={tone}>{(message.author_role || 'member').toUpperCase()}</MPill>
        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, color: 'var(--m-ink-3)', marginLeft: 'auto' }}>
          {clockTime(message.created_at)}
        </span>
      </div>

      {highlight ? (
        // Approval highlight bubble — accent fill, e.g. "✓ APPROVED $510".
        <div
          style={{
            marginTop: 6,
            padding: '10px 12px',
            background: 'var(--m-accent)',
            color: 'var(--m-accent-ink)',
            fontFamily: 'var(--m-font-display)',
            fontWeight: 800,
            fontSize: 14,
            letterSpacing: '-0.005em',
          }}
        >
          ✓ {highlight}
        </div>
      ) : (
        <div
          style={{
            marginTop: 6,
            padding: '12px 14px',
            background: 'var(--m-sand)',
            border: '2px solid var(--m-ink)',
            fontSize: 14,
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {message.body}
        </div>
      )}
    </div>
  )
}
