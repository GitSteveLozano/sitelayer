/**
 * Cross-role project chat (v2 brutalist). Two screens in one file:
 *
 *  - MobileChatList  — every active project is a chat thread. Square
 *    monogram + project name + mono last-activity meta; tap → the thread.
 *  - MobileChatThread — a single project's cross-role conversation. Each
 *    message carries a role chip (MPill, tone by role), the body in a
 *    hard-bordered square bubble, and a mono timestamp. A bottom composer
 *    posts a new message through usePostProjectMessage.
 *
 * Mirrors Steve's V2ChatList / V2ChatThread layout, rebuilt on the m-*
 * primitives + var(--m-*) tokens (no new global CSS). Data comes from the
 * messaging hooks; the list takes the same `bootstrap` prop as admin-home.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import type { ProjectMessage } from '@/lib/api/messaging'
import {
  useMarkThreadRead,
  useMessageSummary,
  usePostProjectMessage,
  useProjectMessages,
} from '@/lib/api/messaging'
import { useProjectAssignments } from '@/lib/api/project-assignments'
import { MAvatar, MButton, MInput, MListInset, MListRow, MPill, MTopBar } from '../../components/m/index.js'
import type { MTone } from '../../components/m/list.js'
import { avatarToneFor, initialsFor } from '../../components/m/avatar.js'

const MONO = 'var(--m-num)'

/**
 * Maps an author role onto the m-* tone palette, matching Steve's
 * V2ChatThread role colors: OWNER/ADMIN = green, FOREMAN = accent (brand
 * yellow), CREW/everyone-else = plain ink (the default MPill look).
 */
function roleTone(role: string): MTone | undefined {
  const r = (role || '').toLowerCase()
  if (r.includes('owner') || r.includes('admin')) return 'green'
  if (r.includes('foreman')) return 'accent'
  return undefined // ink — the default MPill look
}

/**
 * Display name for a message author. The author id is a Clerk user id
 * (`project_messages.author_user_id`), which matches
 * `project_assignments.clerk_user_id`; the assignments endpoint resolves
 * that against the clerk_users mirror and returns `assignee_name`. So we
 * pass a `Map<clerk_user_id, name>` built from the project's roster and
 * fall back to a readable id token when the author isn't a (mapped)
 * assignee — e.g. an owner/office user who posts but isn't assigned, or
 * an identity the Clerk webhook hasn't mirrored yet.
 */
function displayName(authorUserId: string, names: ReadonlyMap<string, string>): string {
  const id = authorUserId || ''
  const resolved = names.get(id)
  if (resolved) return resolved
  // A non-clerk-looking id (e.g. an email or a seeded name) is already
  // readable — show it directly.
  if (!/^user_/i.test(id) && !/^[0-9a-f-]{20,}$/i.test(id)) return id
  return id.length > 12 ? `…${id.slice(-8)}` : id
}

/**
 * Format a numeric amount as `$1,234` / `$1,234.50` for marker labels.
 */
function formatAmount(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

/**
 * Does this message read as a field-intake-linked blocker? Prefers the
 * structured marker (migration 105: `meta.linked_field_event_id`, set when the
 * field-event pipeline auto-posts a crew flag) and falls back to the legacy
 * body heuristic for rows written before the column existed.
 */
function attachedBlocker(m: ProjectMessage): string | null {
  if (m.meta?.linked_field_event_id) return 'AUTO-LINKED FROM FIELD INTAKE'
  // Legacy fallback: rows posted before project_messages.meta existed carry no
  // marker, so sniff the body the way the pre-105 UI did.
  const body = (m.body || '').toLowerCase()
  if (/out of |blocker|need \d+|ran out|short on/.test(body)) return 'AUTO-LINKED FROM FIELD INTAKE'
  return null
}

/**
 * Should this message render as a highlighted approval bubble ("✓ APPROVED
 * $510")? Prefers the structured marker (migration 105: `meta.kind ===
 * 'approval'`, with an optional `meta.amount`) and falls back to the legacy
 * body-prefix heuristic for unmarked rows.
 */
function approvalHighlight(m: ProjectMessage): string | null {
  if (m.meta?.kind === 'approval') {
    return typeof m.meta.amount === 'number' ? `APPROVED ${formatAmount(m.meta.amount)}` : 'APPROVED'
  }
  // Legacy fallback: pre-105 rows have no marker; sniff the "approved …" prefix.
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

// =====================================================================
// 1 · PROJECT CHAT LIST
// =====================================================================
export function MobileChatList({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])

  return (
    <>
      <MTopBar
        title="Chats"
        eyebrow="CROSS-ROLE"
        sub={`${projects.length} project ${projects.length === 1 ? 'thread' : 'threads'}`}
      />
      {projects.length === 0 ? (
        <div style={{ padding: '24px 16px', color: 'var(--m-ink-3)', fontSize: 13 }}>
          No projects yet. Every project gets a shared chat thread once it exists.
        </div>
      ) : (
        <MListInset>
          {projects.map((p) => (
            <ChatListRow
              key={p.id}
              projectId={p.id}
              name={p.name}
              fallbackPreview={`${p.customer_name} · ${p.division_code}`}
              fallbackTime={p.updated_at}
              onTap={() => navigate(`/chat/${p.id}`)}
            />
          ))}
        </MListInset>
      )}
    </>
  )
}

/**
 * One project's chat-list row. Pulls the thread summary (last message preview +
 * the caller's unread count) from GET /api/projects/:id/messages/summary so the
 * row shows a real last-message line and an unread badge. Until the summary
 * resolves (or when the thread is empty) it falls back to the customer/division
 * line and the project's updated_at timestamp — the row always routes into the
 * live thread regardless.
 */
function ChatListRow({
  projectId,
  name,
  fallbackPreview,
  fallbackTime,
  onTap,
}: {
  projectId: string
  name: string
  fallbackPreview: string
  fallbackTime: string
  onTap: () => void
}) {
  const { data: summary } = useMessageSummary(projectId)
  const last = summary?.last_message ?? null
  const unread = summary?.unread_count ?? 0
  const preview = last ? last.body : fallbackPreview
  const time = last ? relativeTime(last.created_at) : relativeTime(fallbackTime)

  return (
    <MListRow
      leading={<MAvatar initials={initialsFor(name)} tone={avatarToneFor(projectId)} />}
      headline={name}
      supporting={
        <span
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: 'var(--m-ink-3)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'block',
          }}
        >
          {preview}
        </span>
      }
      trailing={
        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: 'var(--m-ink-3)' }}>{time}</span>
      }
      badge={
        unread > 0 ? (
          <span
            style={{
              marginTop: 6,
              padding: '2px 6px',
              background: 'var(--m-accent)',
              color: 'var(--m-accent-ink)',
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 800,
              border: '1.5px solid var(--m-ink)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {unread}
          </span>
        ) : undefined
      }
      chev
      onTap={onTap}
    />
  )
}

// =====================================================================
// 2 · PROJECT CHAT THREAD
// =====================================================================
export function MobileChatThread() {
  const navigate = useNavigate()
  const { projectId } = useParams<{ projectId: string }>()
  const { data, isLoading } = useProjectMessages(projectId)
  const assignments = useProjectAssignments(projectId)
  const post = usePostProjectMessage(projectId ?? '')
  const markRead = useMarkThreadRead(projectId ?? '')
  const [draft, setDraft] = useState('')

  const messages = data?.messages ?? []

  // Mark the thread read on open and whenever its latest message changes, so
  // the unread badge in the chat list clears once the operator views it. Keyed
  // on the newest message id so re-running only fires when there's something
  // new to acknowledge (not on every render). markReadMutate is stable across
  // renders (TanStack Query mutate identity), so it's safe to omit.
  const latestMessageId = messages.length > 0 ? messages[messages.length - 1]!.id : null
  const markReadMutate = markRead.mutate
  useEffect(() => {
    if (!projectId || !latestMessageId) return
    markReadMutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, latestMessageId])

  // Resolve author clerk_user_ids → display names from the project roster.
  // assignee_name is the clerk_users-mirror name (first+last) or null when
  // unmapped; we only seed the map for ids that resolved.
  const authorNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of assignments.data?.assignments ?? []) {
      if (a.assignee_name) map.set(a.clerk_user_id, a.assignee_name)
    }
    return map
  }, [assignments.data?.assignments])

  const send = () => {
    const body = draft.trim()
    if (!body || !projectId || post.isPending) return
    post.mutate(
      { body },
      {
        onSuccess: () => setDraft(''),
      },
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <MTopBar
        back
        onBack={() => navigate('/chat')}
        eyebrow="PROJECT CHAT"
        title="Thread"
        sub={`${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 16px 8px' }}>
        {isLoading && messages.length === 0 ? (
          <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--m-ink-3)', padding: '8px 0' }}>LOADING…</div>
        ) : messages.length === 0 ? (
          <div style={{ color: 'var(--m-ink-3)', fontSize: 13, padding: '8px 0' }}>
            No messages yet. Start the conversation below.
          </div>
        ) : (
          messages.map((m) => <MessageRow key={m.id} message={m} authorNames={authorNames} />)
        )}
      </div>

      <div
        style={{
          padding: '12px 16px',
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

function MessageRow({
  message,
  authorNames,
}: {
  message: ProjectMessage
  authorNames: ReadonlyMap<string, string>
}) {
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
