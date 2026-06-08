import { useEffect, useState, type CSSProperties } from 'react'
import { useAdminIssueBoard, type AdminIssueBoardFilters, type AdminIssueBoardItem } from '@/lib/api/admin-issue-board'
import { request } from '@/lib/api/client'
import type { IssueBoardGroupBy, IssueBoardLane, IssueBoardStatus } from '@/lib/api/issue-board'
import { usePlatformGrants, useGrantPlatformCapability, useRevokePlatformCapability } from '@/lib/api/platform-grants'
import type { AppIssueCapability } from '@sitelayer/domain'

/**
 * Site Admin console (P3) — a read-only, cross-tenant superadmin surface over
 * the gated /api/admin/* API (design §5/§6). Lazy-loaded as its own chunk and
 * mounted at /admin/* in App.tsx behind Clerk auth; the API enforces the
 * superadmin gate, so a non-admin just sees a 403 here.
 *
 * Companies (cross-tenant list), Workflows (the deterministic-workflow
 * registry), and Scenarios (the checked-in fixtures + a live apply-plan preview
 * and an Apply / spin-up-demo action — POST is gated + blocked in prod). All
 * /api/admin/* calls are API-gated; impersonation start is driven elsewhere.
 */

interface AdminCompany {
  id: string
  slug: string
  name: string
  created_at: string
  member_count: number
}

interface RegistryWorkflow {
  name: string
  schema_version: number
  states: string[]
  initial_state: string
  terminal_states: string[]
}

interface ScenarioSummary {
  slug: string
  name: string
  file: string
}

interface PlanPreviewOp {
  index: number
  kind: string
  label: string
  detail?: string
}

interface PlanPreview {
  slug: string
  company_slug: string
  op_count: number
  ops: PlanPreviewOp[]
}

interface ScenarioApplyResult {
  slug: string
  company_slug: string
  company_id: string
  applied: boolean
}

interface DemoLinkResult {
  role: string
  name: string | null
  link: string
  expires_in_seconds: number
  expires_at: string
  subject: string
  body: string
  fallback: { url: string; access_code: string | null; role_label: string }
}

const DEMO_ROLE_OPTIONS = ['owner', 'estimator', 'foreman', 'crew'] as const

type TabKey = 'companies' | 'issues' | 'grants' | 'workflows' | 'scenarios' | 'demo'

interface LoadState<T> {
  data: T | null
  error: string | null
  loading: boolean
}

function useLoad<T>(enabled: boolean, path: string): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ data: null, error: null, loading: false })
  useEffect(() => {
    if (!enabled || !path) return
    let cancelled = false
    setState({ data: null, error: null, loading: true })
    request<T>(path)
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false })
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({ data: null, error: err instanceof Error ? err.message : String(err), loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [enabled, path])
  return state
}

const styles: Record<string, CSSProperties> = {
  wrap: {
    padding: 24,
    maxWidth: 1000,
    margin: '0 auto',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#1f2937',
  },
  h1: { fontSize: 22, fontWeight: 700, margin: '0 0 4px' },
  sub: { color: '#6b7280', fontSize: 13, margin: '0 0 20px' },
  tabs: { display: 'flex', gap: 8, borderBottom: '1px solid #e5e7eb', marginBottom: 16 },
  tab: {
    padding: '8px 14px',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    fontSize: 14,
    color: '#6b7280',
    borderBottom: '2px solid transparent',
  },
  tabActive: { color: '#111827', borderBottom: '2px solid #2563eb', fontWeight: 600 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e5e7eb', color: '#6b7280', fontWeight: 600 },
  td: { padding: '8px 10px', borderBottom: '1px solid #f3f4f6' },
  card: { border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 8 },
  code: {
    fontFamily: 'ui-monospace, monospace',
    fontSize: 12,
    background: '#f3f4f6',
    padding: '1px 5px',
    borderRadius: 4,
  },
  err: {
    color: '#b91c1c',
    background: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: 6,
    padding: 12,
    fontSize: 13,
  },
  muted: { color: '#9ca3af', fontSize: 13 },
  link: {
    background: 'none',
    border: 'none',
    color: '#2563eb',
    cursor: 'pointer',
    padding: 0,
    fontSize: 13,
    textDecoration: 'underline',
  },
  controls: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 },
  input: { border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13 },
  select: { border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13, background: '#fff' },
  smallButton: {
    background: '#fff',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 13,
    cursor: 'pointer',
  },
  board: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, alignItems: 'start' },
  column: { border: '1px solid #e5e7eb', borderRadius: 8, background: '#f9fafb', minHeight: 120, padding: 10 },
  columnHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  issueCard: { border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', padding: 10, marginBottom: 8 },
  issueTitle: { fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 4 },
  issueMeta: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 999,
    padding: '2px 7px',
    fontSize: 11,
    fontWeight: 600,
  },
}

function Status({ loading, error }: { loading: boolean; error: string | null }) {
  if (loading) return <p style={styles.muted}>Loading…</p>
  if (error) {
    const denied = /401|403|unauth|admin/i.test(error)
    return (
      <div style={styles.err}>
        {denied ? 'Not authorized — a platform admin (Clerk superadmin) session is required.' : `Error: ${error}`}
      </div>
    )
  }
  return null
}

function CompaniesTab() {
  const { data, error, loading } = useLoad<{ companies: AdminCompany[] }>(true, '/api/admin/companies')
  if (loading || error) return <Status loading={loading} error={error} />
  const companies = data?.companies ?? []
  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>Slug</th>
          <th style={styles.th}>Name</th>
          <th style={styles.th}>Members</th>
          <th style={styles.th}>Created</th>
        </tr>
      </thead>
      <tbody>
        {companies.map((c) => (
          <tr key={c.id}>
            <td style={styles.td}>
              <span style={styles.code}>{c.slug}</span>
            </td>
            <td style={styles.td}>{c.name}</td>
            <td style={styles.td}>{c.member_count}</td>
            <td style={styles.td}>{c.created_at?.slice(0, 10)}</td>
          </tr>
        ))}
        {companies.length === 0 && (
          <tr>
            <td style={styles.td} colSpan={4}>
              <span style={styles.muted}>No companies.</span>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

function WorkflowsTab() {
  const { data, error, loading } = useLoad<{ workflows: RegistryWorkflow[] }>(true, '/api/admin/workflows')
  if (loading || error) return <Status loading={loading} error={error} />
  return (
    <div>
      {(data?.workflows ?? []).map((w) => (
        <div key={`${w.name}@${w.schema_version}`} style={styles.card}>
          <strong>{w.name}</strong> <span style={styles.muted}>v{w.schema_version}</span>
          <div style={{ marginTop: 4, fontSize: 12 }}>
            <span style={styles.muted}>initial</span> <span style={styles.code}>{w.initial_state}</span>{' '}
            <span style={styles.muted}>· states</span> {w.states.length} <span style={styles.muted}>· terminal</span>{' '}
            {w.terminal_states.join(', ') || '—'}
          </div>
        </div>
      ))}
    </div>
  )
}

const STATUS_OPTIONS: IssueBoardStatus[] = [
  'new',
  'triaged',
  'human_assigned',
  'agent_running',
  'review_ready',
  'review_stale',
  'proposal_expired',
  'resolved',
  'reopened',
  'wont_do',
  'reversed',
]
const LANE_OPTIONS: IssueBoardLane[] = ['triage', 'human', 'agent', 'both', 'done']

function WorkRequestsTab() {
  const [groupBy, setGroupBy] = useState<IssueBoardGroupBy>('status_group')
  const [companySlug, setCompanySlug] = useState('')
  const [lane, setLane] = useState<IssueBoardLane | ''>('')
  const [status, setStatus] = useState<IssueBoardStatus | ''>('')
  const filters: AdminIssueBoardFilters = { groupBy, limit: 200 }
  const trimmedCompanySlug = companySlug.trim()
  if (trimmedCompanySlug) filters.companySlug = trimmedCompanySlug
  if (lane) filters.lane = lane
  if (status) filters.status = status
  const board = useAdminIssueBoard(filters)

  if (board.isLoading || board.error) {
    return <Status loading={board.isLoading} error={board.error ? errorMessage(board.error) : null} />
  }

  const columns = board.data?.columns ?? []
  const total = board.data?.items.length ?? 0

  return (
    <div>
      <div style={styles.controls}>
        <input
          value={companySlug}
          onChange={(e) => setCompanySlug(e.target.value)}
          placeholder="company slug"
          style={{ ...styles.input, flex: '0 0 180px' }}
        />
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as IssueBoardGroupBy)} style={styles.select}>
          <option value="status_group">Status groups</option>
          <option value="lane">Lanes</option>
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as IssueBoardStatus | '')}
          style={styles.select}
        >
          <option value="">Any status</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <select value={lane} onChange={(e) => setLane(e.target.value as IssueBoardLane | '')} style={styles.select}>
          <option value="">Any lane</option>
          {LANE_OPTIONS.map((l) => (
            <option key={l} value={l}>
              {label(l)}
            </option>
          ))}
        </select>
        <button type="button" style={styles.smallButton} onClick={() => void board.refetch()}>
          Refresh
        </button>
        <span style={styles.muted}>
          {total} item{total === 1 ? '' : 's'}
          {board.data?.pagination.hasMore ? ' shown, more available' : ''}
        </span>
      </div>

      <div style={styles.board}>
        {columns.map((column) => (
          <section key={column.id} style={styles.column}>
            <div style={styles.columnHead}>
              <strong style={{ fontSize: 13 }}>{column.title}</strong>
              <span style={styles.muted}>{column.items.length}</span>
            </div>
            {column.items.map((item) => (
              <AdminIssueCard key={item.id} item={item} />
            ))}
            {column.items.length === 0 && <span style={styles.muted}>No issues.</span>}
          </section>
        ))}
      </div>
    </div>
  )
}

function AdminIssueCard({ item }: { item: AdminIssueBoardItem }) {
  return (
    <article style={styles.issueCard}>
      <div style={styles.issueTitle}>{item.title || 'Untitled issue'}</div>
      {item.summary ? <div style={{ color: '#4b5563', fontSize: 12 }}>{item.summary}</div> : null}
      <div style={styles.issueMeta}>
        <span style={{ ...styles.chip, background: '#eef2ff', color: '#3730a3' }}>{item.companySlug}</span>
        <span style={{ ...styles.chip, ...statusChipStyle(item.status) }}>{label(item.status)}</span>
        <span style={{ ...styles.chip, background: '#ecfdf5', color: '#047857' }}>{label(item.lane)}</span>
        {item.severity ? (
          <span style={{ ...styles.chip, background: '#fff7ed', color: '#c2410c' }}>{label(item.severity)}</span>
        ) : null}
        {item.captureSessionId ? (
          <span style={{ ...styles.chip, background: '#f5f3ff', color: '#6d28d9' }}>captured</span>
        ) : null}
      </div>
      <div style={{ ...styles.muted, marginTop: 8 }}>
        {age(item.createdAt)} · <span style={styles.code}>{item.id.slice(0, 8)}</span>
      </div>
      {item.route ? (
        <div style={{ ...styles.code, display: 'block', marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.route}
        </div>
      ) : null}
    </article>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function label(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

function age(createdAt: string): string {
  const created = Date.parse(createdAt)
  if (!Number.isFinite(created)) return createdAt.slice(0, 10)
  const elapsed = Math.max(0, Date.now() - created)
  const minutes = Math.floor(elapsed / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function statusChipStyle(status: IssueBoardStatus): CSSProperties {
  switch (status) {
    case 'new':
      return { background: '#eff6ff', color: '#1d4ed8' }
    case 'triaged':
    case 'reopened':
      return { background: '#eef2ff', color: '#4338ca' }
    case 'human_assigned':
      return { background: '#fff7ed', color: '#c2410c' }
    case 'agent_running':
    case 'review_ready':
      return { background: '#ecfeff', color: '#0e7490' }
    case 'review_stale':
    case 'proposal_expired':
      return { background: '#fef2f2', color: '#b91c1c' }
    case 'resolved':
      return { background: '#f0fdf4', color: '#15803d' }
    case 'wont_do':
    case 'reversed':
      return { background: '#f3f4f6', color: '#4b5563' }
    default:
      return { background: '#f3f4f6', color: '#4b5563' }
  }
}

function ScenariosTab() {
  const [selected, setSelected] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState<ScenarioApplyResult | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [resetResult, setResetResult] = useState<ScenarioApplyResult | null>(null)
  const [resetError, setResetError] = useState<string | null>(null)
  const list = useLoad<{ scenarios: ScenarioSummary[] }>(true, '/api/admin/scenarios')
  const plan = useLoad<{ plan: PlanPreview }>(
    !!selected,
    selected ? `/api/admin/scenarios/${encodeURIComponent(selected)}/plan` : '',
  )

  useEffect(() => {
    setApplyResult(null)
    setApplyError(null)
    setResetResult(null)
    setResetError(null)
    setTarget('')
  }, [selected])

  async function doApply() {
    if (!selected) return
    setApplying(true)
    setApplyResult(null)
    setApplyError(null)
    try {
      const body = target.trim() ? { target: target.trim() } : {}
      const res = await request<ScenarioApplyResult>(`/api/admin/scenarios/${encodeURIComponent(selected)}/apply`, {
        method: 'POST',
        json: body,
      })
      setApplyResult(res)
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  async function doReset() {
    if (!selected) return
    setResetting(true)
    setResetResult(null)
    setResetError(null)
    try {
      const body = target.trim() ? { target: target.trim() } : {}
      const res = await request<ScenarioApplyResult>(`/api/admin/scenarios/${encodeURIComponent(selected)}/reset`, {
        method: 'POST',
        json: body,
      })
      setResetResult(res)
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err))
    } finally {
      setResetting(false)
    }
  }

  if (list.loading || list.error) return <Status loading={list.loading} error={list.error} />
  const scenarios = list.data?.scenarios ?? []
  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <div style={{ flex: '0 0 280px' }}>
        {scenarios.length === 0 && <span style={styles.muted}>No fixtures (set SCENARIO_DIR?).</span>}
        {scenarios.map((s) => (
          <div key={s.slug} style={styles.card}>
            <button type="button" style={styles.link} onClick={() => setSelected(s.slug)}>
              {s.name}
            </button>
            <div style={styles.muted}>
              <span style={styles.code}>{s.slug}</span> · {s.file}
            </div>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {!selected && <span style={styles.muted}>Select a scenario to preview its apply plan.</span>}
        {selected && <Status loading={plan.loading} error={plan.error} />}
        {plan.data?.plan && (
          <div>
            <p style={styles.sub}>
              <strong>{plan.data.plan.op_count}</strong> ops for{' '}
              <span style={styles.code}>{plan.data.plan.company_slug}</span>
            </p>
            <ol style={{ fontSize: 12, paddingLeft: 18 }}>
              {plan.data.plan.ops.map((op) => (
                <li key={op.index} style={{ marginBottom: 2 }}>
                  <span style={styles.code}>{op.kind}</span> {op.label}
                  {op.detail ? <span style={styles.muted}> — {op.detail}</span> : null}
                </li>
              ))}
            </ol>
            <div style={{ marginTop: 12, borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
              <p style={{ ...styles.muted, marginBottom: 6 }}>
                Apply (or reset) to the dev/demo DB (optionally as a fresh company). Blocked in prod. Reset idempotently
                re-asserts the curated fixture (additive reseed — see PR notes).
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="fresh company slug (optional)"
                  style={{
                    border: '1px solid #d1d5db',
                    borderRadius: 6,
                    padding: '6px 8px',
                    fontSize: 13,
                    flex: '0 0 220px',
                  }}
                />
                <button
                  type="button"
                  disabled={applying}
                  onClick={() => void doApply()}
                  style={{
                    background: applying ? '#9ca3af' : '#2563eb',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    padding: '6px 14px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: applying ? 'default' : 'pointer',
                  }}
                >
                  {applying ? 'Applying…' : 'Apply'}
                </button>
                <button
                  type="button"
                  disabled={resetting}
                  onClick={() => void doReset()}
                  style={{
                    background: '#fff',
                    color: resetting ? '#9ca3af' : '#b45309',
                    border: `1px solid ${resetting ? '#e5e7eb' : '#f59e0b'}`,
                    borderRadius: 6,
                    padding: '6px 14px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: resetting ? 'default' : 'pointer',
                  }}
                >
                  {resetting ? 'Resetting…' : 'Reset to scenario'}
                </button>
              </div>
              {applyError && <div style={{ ...styles.err, marginTop: 8 }}>{applyError}</div>}
              {applyResult && (
                <p style={{ color: '#15803d', fontSize: 13, marginTop: 8 }}>
                  ✓ Seeded <span style={styles.code}>{applyResult.company_slug}</span> ·{' '}
                  {applyResult.company_id.slice(0, 8)}…
                </p>
              )}
              {resetError && <div style={{ ...styles.err, marginTop: 8 }}>{resetError}</div>}
              {resetResult && (
                <p style={{ color: '#15803d', fontSize: 13, marginTop: 8 }}>
                  ✓ Reset <span style={styles.code}>{resetResult.company_slug}</span> ·{' '}
                  {resetResult.company_id.slice(0, 8)}… to its scenario fixture.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function DemoLinksTab() {
  const [role, setRole] = useState<(typeof DEMO_ROLE_OPTIONS)[number]>('owner')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DemoLinkResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  async function generate() {
    setBusy(true)
    setResult(null)
    setError(null)
    setCopied(null)
    try {
      const res = await request<DemoLinkResult>('/api/admin/demo-link', {
        method: 'POST',
        json: { role, name: name.trim() || undefined },
      })
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function copy(label: string, text: string) {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(label))
      .catch(() => setCopied(null))
  }

  const wrongTier = !!error && /dev\/demo tiers/i.test(error)
  const hours = result ? Math.round(result.expires_in_seconds / 3600) : 0

  return (
    <div style={{ maxWidth: 720 }}>
      <p style={styles.sub}>
        Mint a one-click, 24-hour sign-in link for a seeded role and a ready-to-send email. Dev/demo only — the link
        signs the recipient straight into the seeded environment as that role.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as (typeof DEMO_ROLE_OPTIONS)[number])}
          style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13 }}
        >
          {DEMO_ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="recipient name (optional)"
          style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13, flex: '0 0 220px' }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void generate()}
          style={{
            background: busy ? '#9ca3af' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '6px 14px',
            fontSize: 13,
            fontWeight: 600,
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Generating…' : 'Generate link'}
        </button>
      </div>

      {error && (
        <div style={styles.err}>
          {wrongTier
            ? 'Seeded-user links can only be generated from the dev/demo console with the Clerk test instance and seeded users configured.'
            : `Error: ${error}`}
        </div>
      )}

      {result && (
        <div>
          <div style={styles.card}>
            <div style={styles.muted}>
              One-click link · {result.fallback.role_label} · valid ~{hours}h (until {result.expires_at.slice(0, 16)}Z)
            </div>
            <div style={{ ...styles.code, display: 'block', marginTop: 6, wordBreak: 'break-all', padding: 8 }}>
              {result.link}
            </div>
            <button type="button" style={{ ...styles.link, marginTop: 6 }} onClick={() => copy('link', result.link)}>
              {copied === 'link' ? '✓ copied' : 'Copy link'}
            </button>
          </div>

          <div style={styles.card}>
            <div style={styles.muted}>Email — subject: {result.subject}</div>
            <textarea
              readOnly
              value={result.body}
              rows={12}
              style={{
                width: '100%',
                marginTop: 6,
                fontFamily: 'ui-monospace, monospace',
                fontSize: 12,
                border: '1px solid #e5e7eb',
                borderRadius: 6,
                padding: 8,
                resize: 'vertical',
              }}
            />
            <button
              type="button"
              style={{ ...styles.link, marginTop: 6 }}
              onClick={() => copy('email', `Subject: ${result.subject}\n\n${result.body}`)}
            >
              {copied === 'email' ? '✓ copied' : 'Copy email'}
            </button>
          </div>

          <p style={styles.muted}>
            Fallback if the link expires: <span style={styles.code}>{result.fallback.url}</span>
            {result.fallback.access_code ? (
              <>
                {' '}
                · access code <span style={styles.code}>{result.fallback.access_code}</span>
              </>
            ) : null}
          </p>
        </div>
      )}
    </div>
  )
}

// app_issue.* capability → short human description for the grants table.
const APP_ISSUE_CAP_BLURB: Record<string, string> = {
  'app_issue.capture': 'Open the capture dock + record an app issue.',
  'app_issue.view': 'See the /issues board + capture artifacts, replays, support packets.',
  'app_issue.triage': 'Route / resolve / dispatch app issues.',
}

/**
 * Platform grants (app_issue.*) — the superadmin surface that opts a specific
 * person into ONE platform capability without making them a full superadmin.
 * app_issue.* caps are problems with the sitelayer SOFTWARE (internal,
 * cross-tenant) and live ONLY on this platform boundary — they can never be
 * reached from a company role. Superadmins implicitly hold them all; the rows
 * here are the additive opt-in for non-superadmin teammates.
 */
function PlatformGrantsTab() {
  const grantsQuery = usePlatformGrants()
  const grant = useGrantPlatformCapability()
  const revoke = useRevokePlatformCapability()
  const [clerkUserId, setClerkUserId] = useState('')
  const [capability, setCapability] = useState<AppIssueCapability | ''>('')
  const [error, setError] = useState<string | null>(null)

  const catalog = grantsQuery.data?.catalog ?? []
  const grants = grantsQuery.data?.grants ?? []

  async function add() {
    setError(null)
    const id = clerkUserId.trim()
    if (!id || !capability) {
      setError('Enter a Clerk user id and pick a capability.')
      return
    }
    try {
      await grant.mutateAsync({ clerk_user_id: id, capability })
      setClerkUserId('')
      setCapability('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (grantsQuery.isLoading || grantsQuery.error) {
    return <Status loading={grantsQuery.isLoading} error={grantsQuery.error ? errorMessage(grantsQuery.error) : null} />
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <p style={styles.sub}>
        Opt a teammate into a platform <span style={styles.code}>app_issue.*</span> capability (the sitelayer
        software&apos;s own issues). Superadmins already hold all of these; these rows grant one capability to a
        non-superadmin person.
      </p>

      <div style={styles.controls}>
        <input
          value={clerkUserId}
          onChange={(e) => setClerkUserId(e.target.value)}
          placeholder="Clerk user id (e.g. user_2ab…)"
          style={{ ...styles.input, flex: '0 0 240px' }}
        />
        <select
          value={capability}
          onChange={(e) => setCapability(e.target.value as AppIssueCapability | '')}
          style={styles.select}
        >
          <option value="">Pick a capability…</option>
          {catalog.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={grant.isPending}
          onClick={() => void add()}
          style={{
            background: grant.isPending ? '#9ca3af' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '6px 14px',
            fontSize: 13,
            fontWeight: 600,
            cursor: grant.isPending ? 'default' : 'pointer',
          }}
        >
          {grant.isPending ? 'Granting…' : 'Grant'}
        </button>
      </div>
      {capability ? <p style={styles.muted}>{APP_ISSUE_CAP_BLURB[capability] ?? ''}</p> : null}
      {error ? <div style={styles.err}>{error}</div> : null}

      <table style={{ ...styles.table, marginTop: 12 }}>
        <thead>
          <tr>
            <th style={styles.th}>Clerk user id</th>
            <th style={styles.th}>Capability</th>
            <th style={styles.th}>Granted</th>
            <th style={styles.th}></th>
          </tr>
        </thead>
        <tbody>
          {grants.map((g) => (
            <tr key={`${g.clerk_user_id}:${g.capability}`}>
              <td style={styles.td}>
                <span style={styles.code}>{g.clerk_user_id}</span>
              </td>
              <td style={styles.td}>
                <span style={styles.code}>{g.capability}</span>
              </td>
              <td style={styles.td}>{g.created_at?.slice(0, 10)}</td>
              <td style={styles.td}>
                <button
                  type="button"
                  style={styles.link}
                  disabled={revoke.isPending}
                  onClick={() => void revoke.mutateAsync({ clerk_user_id: g.clerk_user_id, capability: g.capability })}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
          {grants.length === 0 && (
            <tr>
              <td style={styles.td} colSpan={4}>
                <span style={styles.muted}>
                  No opt-in grants yet — superadmins still hold every app_issue.* capability.
                </span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export default function AdminRoute() {
  const [tab, setTab] = useState<TabKey>('companies')
  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'companies', label: 'Companies' },
    { key: 'issues', label: 'Issues' },
    { key: 'grants', label: 'Platform grants' },
    { key: 'workflows', label: 'Workflows' },
    { key: 'scenarios', label: 'Scenarios' },
    { key: 'demo', label: 'Demo links' },
  ]
  return (
    <div style={styles.wrap}>
      <h1 style={styles.h1}>Site Admin</h1>
      <p style={styles.sub}>Cross-tenant superadmin console.</p>
      <div style={styles.tabs}>
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            style={{ ...styles.tab, ...(tab === t.key ? styles.tabActive : {}) }}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'companies' && <CompaniesTab />}
      {tab === 'issues' && <WorkRequestsTab />}
      {tab === 'grants' && <PlatformGrantsTab />}
      {tab === 'workflows' && <WorkflowsTab />}
      {tab === 'scenarios' && <ScenariosTab />}
      {tab === 'demo' && <DemoLinksTab />}
    </div>
  )
}
