import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { MBanner, MBody, MPill, MTopBar } from '../../components/m/index.js'
import { MSkeletonList } from '../../components/m-states/index.js'
import { useRole, type Role } from '../../lib/role.js'
import {
  fetchNotifications,
  notificationQueryKeys,
  useMarkNotificationRead,
  type NotificationRow,
} from '../../lib/api/notifications.js'

// ---------------------------------------------------------------------------
// Kind → role/tone mapping
//
// `notifications.kind` is a free-form string from the worker (e.g.
// `worker_issue_resolved`, `estimator_escalation`, `daily_log_submitted`).
// We map the leading token to a short mono micro-label + a tone so the row
// gets a role-tagged MPill — mirroring Steve's V2NotifOwner/Foreman/Worker
// kind chips without inventing new wire fields.
// ---------------------------------------------------------------------------

type PillTone = 'accent' | 'green' | 'red' | 'amber' | 'blue'

function kindTag(kind: string): { label: string; tone: PillTone } {
  const k = kind.toLowerCase()
  if (k.includes('escalat')) return { label: 'RISK', tone: 'red' }
  if (k.includes('blocker') || k.includes('issue') || k.includes('flag')) return { label: 'FIELD', tone: 'red' }
  if (k.includes('resolved') || k.includes('approved') || k.includes('paid') || k.includes('posted'))
    return { label: 'OK', tone: 'green' }
  if (k.includes('auth') || k.includes('request') || k.includes('review')) return { label: 'AUTH', tone: 'accent' }
  if (k.includes('schedule') || k.includes('crew') || k.includes('shift')) return { label: 'CREW', tone: 'amber' }
  if (k.includes('log') || k.includes('photo') || k.includes('brief')) return { label: 'LOG', tone: 'blue' }
  // Fall back to the first token of the kind, uppercased + truncated.
  const head = (k.split(/[_\s.]/)[0] ?? 'NOTE').slice(0, 6).toUpperCase()
  return { label: head || 'NOTE', tone: 'blue' }
}

// Pull a navigable target out of the notification payload, if one was set.
// The worker stamps a route/href/path on payload for actionable rows; absent
// that, the tap is a no-op (we only mark-read).
function targetFor(n: NotificationRow): string | null {
  const p = n.payload ?? {}
  for (const key of ['route', 'href', 'path', 'url', 'target']) {
    const v = p[key]
    if (typeof v === 'string' && v.startsWith('/')) return v
  }
  return null
}

function relativeAge(iso: string): string {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return `${Math.floor(s)}S`
  if (s < 3600) return `${Math.floor(s / 60)}M`
  if (s < 86_400) return `${Math.floor(s / 3600)}H`
  if (s < 604_800) return `${Math.floor(s / 86_400)}D`
  return `${Math.floor(s / 604_800)}W`
}

// Bucket a notification into the design's NOW / TODAY / EARLIER groups
// (mirrors V2NotifOwner's NOW + TODAY section bars). NOW = within the last
// ~3 hours, TODAY = same calendar day, EARLIER = anything older.
type Group = 'NOW' | 'TODAY' | 'EARLIER'

function groupFor(iso: string): Group {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return 'EARLIER'
  const now = new Date()
  const then = new Date(ts)
  if (now.getTime() - ts < 3 * 3600_000) return 'NOW'
  const sameDay =
    now.getFullYear() === then.getFullYear() && now.getMonth() === then.getMonth() && now.getDate() === then.getDate()
  return sameDay ? 'TODAY' : 'EARLIER'
}

const GROUP_ORDER: readonly Group[] = ['NOW', 'TODAY', 'EARLIER']

// Role → header framing (msg__78/79/80). Owner & crew show the live unread
// count as the headline ("4 NEW") under a "<ROLE> · INBOX" eyebrow; the foreman
// inbox is the "FROM THE FIELD" framing. The crew/worker variant additionally
// renders on the dark surface (see `.m-dark`).
function inboxFraming(role: Role, unread: number): { eyebrow: string; title: string; dark: boolean } {
  const countTitle = unread > 0 ? `${unread} NEW` : 'INBOX'
  switch (role) {
    case 'owner':
      return { eyebrow: 'OWNER · INBOX', title: countTitle, dark: false }
    case 'foreman':
      return { eyebrow: 'FOREMAN · INBOX', title: 'FROM THE FIELD', dark: false }
    case 'bookkeeper':
      return { eyebrow: 'BOOKKEEPER · INBOX', title: countTitle, dark: false }
    case 'worker':
    default:
      return { eyebrow: 'CREW · INBOX', title: countTitle, dark: true }
  }
}

export function MobileNotificationsInbox() {
  const navigate = useNavigate()
  const role = useRole()
  const markRead = useMarkNotificationRead()

  const params = useMemo(() => ({ limit: 75 }), [])
  const query = useQuery({
    queryKey: notificationQueryKeys.list(params),
    queryFn: () => fetchNotifications(params),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })

  const rows = query.data?.notifications ?? []
  const unread = useMemo(() => rows.filter((n) => !n.read_at).length, [rows])
  const framing = inboxFraming(role, unread)

  // Group rows into NOW / TODAY / EARLIER section bars (design grouping),
  // preserving the API's newest-first order within each group.
  const grouped = useMemo(() => {
    const buckets: Record<Group, NotificationRow[]> = { NOW: [], TODAY: [], EARLIER: [] }
    for (const n of rows) buckets[groupFor(n.created_at)].push(n)
    return GROUP_ORDER.map((g) => ({ group: g, items: buckets[g] })).filter((s) => s.items.length > 0)
  }, [rows])

  const onTap = (n: NotificationRow) => {
    if (!n.read_at) markRead.mutate(n.id)
    const target = targetFor(n)
    if (target) navigate(target)
  }

  return (
    <div
      className={framing.dark ? 'm-dark' : undefined}
      style={framing.dark ? { background: 'var(--m-bg)', minHeight: '100%' } : undefined}
    >
      <MTopBar back title={framing.title} eyebrow={framing.eyebrow} onBack={() => navigate(-1)} />
      <MBody>
        {query.error ? (
          <div style={{ padding: '0 16px 8px' }}>
            <MBanner
              tone="error"
              title="Load failed"
              body={query.error instanceof Error ? query.error.message : 'Request failed.'}
            />
          </div>
        ) : null}

        {query.isPending ? (
          <MSkeletonList count={5} />
        ) : rows.length === 0 ? (
          <div
            style={{
              padding: '40px 20px',
              textAlign: 'center',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              color: 'var(--m-ink-3)',
            }}
          >
            INBOX EMPTY
          </div>
        ) : (
          grouped.map((section) => (
            <section key={section.group}>
              <div
                style={{
                  padding: '10px 16px',
                  borderTop: '2px solid var(--m-ink)',
                  borderBottom: '1px solid var(--m-line-2)',
                  background: 'var(--m-card-soft)',
                  fontFamily: 'var(--m-num)',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  color: 'var(--m-ink-2)',
                }}
              >
                {section.group}
              </div>
              {section.items.map((n) => (
                <NotificationRowView key={n.id} n={n} onTap={() => onTap(n)} />
              ))}
            </section>
          ))
        )}
      </MBody>
    </div>
  )
}

// Map the canonical delivery `state` to a small inbox badge. Returns null
// for the common/happy states (pending/sending/sent) so the inbox stays
// quiet and only flags problems.
function deliveryBadge(state: string | null | undefined): { label: string; tone: PillTone } | null {
  if (!state) return null
  if (state.startsWith('failed')) return { label: 'Delivery failed', tone: 'red' }
  if (state === 'voided') return { label: 'Canceled', tone: 'amber' }
  return null
}

function NotificationRowView({ n, onTap }: { n: NotificationRow; onTap: () => void }) {
  const tag = kindTag(n.kind)
  const delivery = deliveryBadge(n.state)
  const unread = !n.read_at
  const hasTarget = targetFor(n) != null
  const Tag = hasTarget || unread ? 'button' : 'div'
  return (
    <Tag
      type={Tag === 'button' ? 'button' : undefined}
      onClick={onTap}
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        width: '100%',
        textAlign: 'left',
        padding: '16px',
        // Accent left edge marks unread; read rows get a flush border to keep
        // the column aligned.
        borderLeft: unread ? '4px solid var(--m-accent)' : '4px solid transparent',
        borderBottom: '2px solid var(--m-ink)',
        background: unread ? 'var(--m-card-soft)' : 'transparent',
        cursor: hasTarget || unread ? 'pointer' : 'default',
        font: 'inherit',
        color: 'inherit',
      }}
    >
      <span style={{ flexShrink: 0, marginTop: 1 }}>
        <MPill tone={tag.tone} dot={unread}>
          {tag.label}
        </MPill>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 700,
            fontSize: 15,
            lineHeight: 1.3,
            color: 'var(--m-ink)',
          }}
        >
          {n.subject}
        </div>
        {delivery ? (
          <span style={{ display: 'inline-block', marginTop: 5 }}>
            <MPill tone={delivery.tone}>{delivery.label}</MPill>
          </span>
        ) : null}
        {n.body_text ? (
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 600,
              lineHeight: 1.45,
              letterSpacing: '0.02em',
              color: 'var(--m-ink-3)',
              marginTop: 5,
            }}
          >
            {n.body_text}
          </div>
        ) : null}
      </div>
      <span
        style={{
          flexShrink: 0,
          fontFamily: 'var(--m-num)',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.04em',
          color: 'var(--m-ink-4)',
          marginTop: 2,
        }}
      >
        {relativeAge(n.created_at)}
      </span>
    </Tag>
  )
}
