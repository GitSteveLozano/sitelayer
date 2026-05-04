/**
 * Flag a problem — `wk-issue`. Six-tile category grid (per the screenshot,
 * not the README's 4 chips). Submits a worker_issues row server-side via
 * the existing /api/worker-issues route.
 *
 * Categories map to the worker_issues.kind enum. Migration 044 currently
 * accepts materials_out / crew_short / safety / other; the design's new
 * 6 categories (out_of_materials / equipment_broken / safety_concern /
 * weather_hold / scope_question / other) will need a follow-up migration
 * to amend the CHECK constraint. For now we send the closest match and
 * surface the design label in copy.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiPost, type BootstrapResponse } from '../../api.js'
import { MBody, MButton, MButtonStack, MI, MTopBar } from '../../components/m/index.js'

type IssueCategory = {
  /** Displayed label */
  label: string
  /** Sub label */
  sub: string
  /** Maps to worker_issues.kind on the server. */
  kind: 'materials_out' | 'crew_short' | 'safety' | 'other'
  /** Matching design-level token; lands in the message body until the
   *  server constraint is amended. */
  designKind: 'out_of_materials' | 'equipment_broken' | 'safety_concern' | 'weather_hold' | 'scope_question' | 'other'
  Icon: typeof MI.AlertTri
  tone: 'amber' | 'red' | 'blue' | 'accent'
}

const CATEGORIES: ReadonlyArray<IssueCategory> = [
  { label: 'Out of materials', sub: 'Need delivery', kind: 'materials_out', designKind: 'out_of_materials', Icon: MI.Layers, tone: 'amber' },
  { label: 'Equipment broken', sub: 'Tool / scaffold', kind: 'other', designKind: 'equipment_broken', Icon: MI.Drill, tone: 'red' },
  { label: 'Safety concern', sub: 'Stop work', kind: 'safety', designKind: 'safety_concern', Icon: MI.ShieldAlert, tone: 'red' },
  { label: 'Weather hold', sub: 'Rain / wind', kind: 'other', designKind: 'weather_hold', Icon: MI.CloudRain, tone: 'amber' },
  { label: 'Scope question', sub: 'Need clarity', kind: 'other', designKind: 'scope_question', Icon: MI.AlertTri, tone: 'blue' },
  { label: 'Other', sub: 'Type it out', kind: 'other', designKind: 'other', Icon: MI.Alert, tone: 'accent' },
]

export function WorkerIssue({
  bootstrap,
  companySlug,
}: {
  bootstrap: BootstrapResponse | null
  companySlug: string
}) {
  const navigate = useNavigate()
  const [category, setCategory] = useState<IssueCategory | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const projectId = bootstrap?.projects.find((p) => /progress|active/i.test(p.status))?.id ?? null

  const handleSend = async () => {
    if (!category) return
    setBusy(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        kind: category.kind,
        message: message.trim() || `${category.label}: ${category.sub}`,
      }
      if (projectId) body.project_id = projectId
      // Tag the design-level category in the message body until the
      // server enum is amended. Foreman triage UI can render off this
      // prefix before the migration lands.
      if (category.designKind !== category.kind) {
        body.message = `[${category.designKind}] ${body.message as string}`
      }
      await apiPost('/api/worker-issues', body, companySlug)
      navigate('/m/today')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (category) {
    return (
      <>
        <MTopBar back title="Flag a problem" sub={category.label} onBack={() => setCategory(null)} />
        <MBody pad>
          <div style={{ padding: '0 0 12px', fontSize: 12, color: 'var(--m-ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            What's wrong?
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.currentTarget.value)}
            placeholder="Describe the issue — short is fine."
            className="m-input m-textarea"
            style={{ width: '100%', minHeight: 120 }}
          />
          {error ? (
            <div style={{ marginTop: 12, color: 'var(--m-red)', fontSize: 13 }}>{error}</div>
          ) : null}
          <div style={{ marginTop: 16 }}>
            <MButtonStack>
              <MButton variant="primary" onClick={handleSend} disabled={busy}>
                {busy ? 'Sending…' : 'Send to foreman'}
              </MButton>
              <MButton variant="ghost" onClick={() => setCategory(null)}>
                Pick a different category
              </MButton>
            </MButtonStack>
          </div>
        </MBody>
      </>
    )
  }

  return (
    <>
      <MTopBar back title="Flag a problem" onBack={() => navigate('/m/today')} />
      <MBody pad>
        <div className="m-topbar-eyebrow" style={{ marginBottom: 12 }}>
          WHAT'S THE ISSUE?
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {CATEGORIES.map((c) => (
            <button
              key={c.designKind}
              type="button"
              onClick={() => setCategory(c)}
              style={{
                aspectRatio: '1.1 / 1',
                borderRadius: 14,
                border: '1px solid var(--m-line)',
                background: 'var(--m-card)',
                padding: 14,
                textAlign: 'left',
                cursor: 'pointer',
                fontFamily: 'inherit',
                color: 'inherit',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: 6,
              }}
            >
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: `var(--m-${c.tone === 'accent' ? 'accent' : c.tone}-soft)`,
                  color: `var(--m-${c.tone === 'accent' ? 'accent' : c.tone})`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <c.Icon size={18} />
              </span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{c.label}</div>
                <div className="m-quiet-sm" style={{ marginTop: 2 }}>
                  {c.sub}
                </div>
              </div>
            </button>
          ))}
        </div>
      </MBody>
    </>
  )
}
