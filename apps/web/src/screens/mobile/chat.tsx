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
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import type { ProjectMessage } from '@/lib/api/messaging'
import { useProjectMessages, usePostProjectMessage } from '@/lib/api/messaging'
import {
  MAvatar,
  MButton,
  MI,
  MInput,
  MListInset,
  MListRow,
  MPill,
  MTopBar,
} from '../../components/m/index.js'
import type { MTone } from '../../components/m/list.js'
import { avatarToneFor, initialsFor } from '../../components/m/avatar.js'

const MONO = "var(--m-num)"

/**
 * Maps an author role onto the m-* tone palette. Owner/admin reads as the
 * brand accent, foreman as blue, everyone else (worker/crew) as plain ink.
 */
function roleTone(role: string): MTone | undefined {
  const r = (role || '').toLowerCase()
  if (r.includes('owner') || r.includes('admin')) return 'accent'
  if (r.includes('foreman')) return 'blue'
  return undefined // ink — the default MPill look
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
  return then
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    .toUpperCase()
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
      <MTopBar title="Chats" eyebrow="CROSS-ROLE" sub={`${projects.length} project ${projects.length === 1 ? 'thread' : 'threads'}`} />
      {projects.length === 0 ? (
        <div style={{ padding: '24px 16px', color: 'var(--m-ink-3)', fontSize: 13 }}>
          No projects yet. Every project gets a shared chat thread once it exists.
        </div>
      ) : (
        <MListInset>
          {projects.map((p) => (
            <MListRow
              key={p.id}
              leading={<MAvatar initials={initialsFor(p.name)} tone={avatarToneFor(p.id)} />}
              headline={p.name}
              supporting={
                <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--m-ink-3)' }}>
                  {p.customer_name} · {p.division_code}
                </span>
              }
              trailing={
                <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: 'var(--m-ink-3)' }}>
                  {relativeTime(p.updated_at)}
                </span>
              }
              chev
              onTap={() => navigate(`/chat/${p.id}`)}
            />
          ))}
        </MListInset>
      )}
    </>
  )
}

// =====================================================================
// 2 · PROJECT CHAT THREAD
// =====================================================================
export function MobileChatThread() {
  const navigate = useNavigate()
  const { projectId } = useParams<{ projectId: string }>()
  const { data, isLoading } = useProjectMessages(projectId)
  const post = usePostProjectMessage(projectId ?? '')
  const [draft, setDraft] = useState('')

  const messages = data?.messages ?? []

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
          messages.map((m) => <MessageRow key={m.id} message={m} />)
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

function MessageRow({ message }: { message: ProjectMessage }) {
  const tone = roleTone(message.author_role)
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 800, color: 'var(--m-ink)' }}>
          {message.author_user_id}
        </span>
        <MPill tone={tone}>{(message.author_role || 'member').toUpperCase()}</MPill>
        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, color: 'var(--m-ink-3)', marginLeft: 'auto' }}>
          {clockTime(message.created_at)}
        </span>
      </div>
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
    </div>
  )
}
