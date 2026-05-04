/**
 * Daily log builder — `fm-log`. End-of-day report. AI assembles a draft
 * from the day's events; foreman edits, adds material usage, signs off.
 * Submits to /api/daily-logs (existing route).
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiGet, apiPost, type BootstrapResponse } from '../../api.js'
import { MBody, MButton, MI, MKpi, MKpiRow, MSectionH, MTopBar } from '../../components/m/index.js'
import { MAiStripe } from '../../components/m/ai.js'
import { formatDecimalHours, todayIso } from './format.js'

type IssueRow = {
  id: string
  project_id: string | null
  message: string
  resolved_at: string | null
  created_at: string
}

export function ForemanLog({ bootstrap, companySlug }: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const navigate = useNavigate()
  const projects = bootstrap?.projects.filter((p) => /progress|active/i.test(p.status)) ?? []
  const [projectId, setProjectId] = useState<string>(() => projects[0]?.id ?? '')
  const project = projects.find((p) => p.id === projectId)

  const today = todayIso()
  const todayLabor = useMemo(() => {
    return (bootstrap?.laborEntries ?? []).filter(
      (l) => l.occurred_on === today && !l.deleted_at && l.project_id === projectId,
    )
  }, [bootstrap?.laborEntries, projectId, today])
  const totalHours = todayLabor.reduce((sum, l) => sum + Number(l.hours ?? 0), 0)

  const [photoCount, setPhotoCount] = useState(0)
  const [issues, setIssues] = useState<readonly IssueRow[]>([])

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    apiGet<{ worker_issues: IssueRow[] }>(`/api/worker-issues?resolved=true&project_id=${projectId}`, companySlug)
      .then((r) => {
        if (cancelled) return
        const todayIssues = (r.worker_issues ?? []).filter((i) => i.created_at.slice(0, 10) === today)
        setIssues(todayIssues)
        setPhotoCount(todayIssues.filter((i) => /^\[photo_log\]/.test(i.message)).length)
      })
      .catch(() => {
        if (!cancelled) {
          setIssues([])
          setPhotoCount(0)
        }
      })
    return () => {
      cancelled = true
    }
  }, [projectId, companySlug, today])

  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSummary(
      `Sunny, ${todayLabor.length === 0 ? 'no crew on site' : `${formatDecimalHours(totalHours, 1)} crew-hrs across ${todayLabor.length} entries`}. ${
        issues.filter((i) => i.resolved_at).length
      } issues resolved, ${issues.filter((i) => !i.resolved_at).length} still open.`,
    )
  }, [todayLabor.length, totalHours, issues])

  const handleSend = async () => {
    if (!project) return
    setBusy(true)
    setError(null)
    try {
      await apiPost(
        '/api/daily-logs',
        {
          project_id: project.id,
          effective_date: today,
          summary: summary.trim(),
        },
        companySlug,
      )
      navigate('/m/today')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <MTopBar
        title="Daily log"
        sub={project ? `${project.name} · ${today}` : today}
        actionIcon={<MI.FileText size={20} />}
        actionLabel="Send"
        onAction={handleSend}
      />
      <MBody pad>
        {projects.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--m-ink-3)', fontSize: 13 }}>No active projects today.</div>
        ) : (
          <>
            {projects.length > 1 ? (
              <div style={{ marginBottom: 12 }}>
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.currentTarget.value)}
                  className="m-input"
                  style={{ width: '100%' }}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <MKpiRow cols={3}>
              <MKpi label="Photos" value={String(photoCount)} />
              <MKpi label="Hours" value={formatDecimalHours(totalHours, 1)} />
              <MKpi label="Issues" value={String(issues.length)} metaTone={issues.length > 0 ? 'amber' : undefined} />
            </MKpiRow>
            <div style={{ marginTop: 12 }}>
              <MAiStripe
                eyebrow={`DRAFT SUMMARY · ${todayLabor.length + issues.length} events`}
                title="Edit before sending"
                attribution={
                  <>
                    Drafted from <strong>today's events</strong>.
                  </>
                }
              >
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.currentTarget.value)}
                  className="m-input m-textarea"
                  style={{ width: '100%', minHeight: 100, marginTop: 8 }}
                />
              </MAiStripe>
            </div>
            <MSectionH>Issues today</MSectionH>
            {issues.length === 0 ? (
              <div className="m-quiet-sm" style={{ padding: '0 16px' }}>
                None.
              </div>
            ) : (
              <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {issues.map((i) => (
                  <div key={i.id} className="m-card-tight m-card" style={{ padding: '8px 12px' }}>
                    <div style={{ fontSize: 13 }}>{i.message.replace(/^\[[^\]]+\]\s*/, '')}</div>
                    <div className="m-quiet-sm" style={{ marginTop: 2 }}>
                      {i.resolved_at ? 'Resolved' : 'Open'}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {error ? <div style={{ marginTop: 12, color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
            <div style={{ marginTop: 16 }}>
              <MButton variant="primary" onClick={handleSend} disabled={busy || !project}>
                {busy ? 'Sending…' : 'Send to office'}
              </MButton>
            </div>
          </>
        )}
      </MBody>
    </>
  )
}
