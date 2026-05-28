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
import { useProjectMessages, usePostProjectMessage } from '@/lib/api/messaging'
import { DEyebrow, DH1 } from '@/components/d'
import { MButton, MInput, MPill } from '@/components/m'
import type { MTone } from '@/components/m'

const MONO = 'var(--m-num)'

/** Maps an author role onto the m-* tone palette (owner/admin = accent, foreman = blue, else ink). */
function roleTone(role: string): MTone | undefined {
  const r = (role || '').toLowerCase()
  if (r.includes('owner') || r.includes('admin')) return 'accent'
  if (r.includes('foreman')) return 'blue'
  return undefined
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
            gridTemplateColumns: '280px 1fr',
            border: '2px solid var(--m-ink)',
            background: 'var(--m-card)',
            minHeight: 480,
          }}
        >
          {/* ---- Left pane: project thread list ---- */}
          <div style={{ borderRight: '2px solid var(--m-ink)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
                {projects.map((p) => {
                  const active = p.id === selectedProjectId
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setSelectedProjectId(p.id)}
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
                      <div
                        style={{
                          fontFamily: 'var(--m-font-display)',
                          fontWeight: 700,
                          fontSize: 15,
                          letterSpacing: '-0.01em',
                        }}
                      >
                        {p.name}
                      </div>
                      <div
                        style={{
                          fontFamily: MONO,
                          fontSize: 11,
                          color: active ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                          marginTop: 2,
                        }}
                      >
                        {p.customer_name} · {p.division_code}
                      </div>
                    </button>
                  )
                })}
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

function MessageThread({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { data, isLoading } = useProjectMessages(projectId)
  const post = usePostProjectMessage(projectId)
  const [draft, setDraft] = useState('')

  const messages = data?.messages ?? []

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
          <div style={{ color: 'var(--m-ink-3)', fontSize: 13 }}>
            No messages yet. Start the conversation below.
          </div>
        ) : (
          messages.map((m) => <MessageRow key={m.id} message={m} />)
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
