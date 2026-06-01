import { useEffect, useState, type CSSProperties } from 'react'
import { request } from '@/lib/api/client'

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

type TabKey = 'companies' | 'workflows' | 'scenarios'

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

function ScenariosTab() {
  const [selected, setSelected] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState<ScenarioApplyResult | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const list = useLoad<{ scenarios: ScenarioSummary[] }>(true, '/api/admin/scenarios')
  const plan = useLoad<{ plan: PlanPreview }>(
    !!selected,
    selected ? `/api/admin/scenarios/${encodeURIComponent(selected)}/plan` : '',
  )

  useEffect(() => {
    setApplyResult(null)
    setApplyError(null)
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
                Apply to the dev/demo DB (optionally as a fresh company). Blocked in prod.
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
              </div>
              {applyError && <div style={{ ...styles.err, marginTop: 8 }}>{applyError}</div>}
              {applyResult && (
                <p style={{ color: '#15803d', fontSize: 13, marginTop: 8 }}>
                  ✓ Seeded <span style={styles.code}>{applyResult.company_slug}</span> ·{' '}
                  {applyResult.company_id.slice(0, 8)}…
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function AdminRoute() {
  const [tab, setTab] = useState<TabKey>('companies')
  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'companies', label: 'Companies' },
    { key: 'workflows', label: 'Workflows' },
    { key: 'scenarios', label: 'Scenarios' },
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
      {tab === 'workflows' && <WorkflowsTab />}
      {tab === 'scenarios' && <ScenariosTab />}
    </div>
  )
}
