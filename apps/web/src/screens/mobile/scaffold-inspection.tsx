/**
 * Mobile scaffold-tag inspection flow.
 *
 * Given a QR token (typed or scanned), resolves the tag, shows the
 * latest inspection summary, and lets a foreman record a new
 * pass/fail/tag-out inspection with a default checklist + free-form
 * defects/remediation. Photos are placeholders for now — uploading
 * into daily_log_photos is a follow-up.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useCreateInspection, useTagByToken } from '@/lib/api/scaffold-tags'
import {
  MBody,
  MButton,
  MInput,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'

const DEFAULT_CHECKLIST: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'base', label: 'Base plates / sole plates seated' },
  { key: 'plumb', label: 'Standards plumb' },
  { key: 'bracing', label: 'Bracing complete' },
  { key: 'ties', label: 'Ties / anchors secure' },
  { key: 'planks', label: 'Planks free of gaps / damage' },
  { key: 'guardrails', label: 'Guardrails + toeboards on all open sides' },
  { key: 'access', label: 'Access ladders / stairs in place' },
  { key: 'tag', label: 'QR tag visible from ground level' },
]

type ChecklistState = Record<string, boolean | null>

export function MobileScaffoldInspectionScreen() {
  const { token: paramToken } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const [token, setToken] = useState(paramToken ?? '')
  const [checklist, setChecklist] = useState<ChecklistState>({})
  const [defects, setDefects] = useState('')
  const [remediation, setRemediation] = useState('')
  const [status, setStatus] = useState<'pass' | 'fail' | 'tagged_out'>('pass')

  const lookup = useTagByToken(token)
  const tag = lookup.data?.tag
  const lastInspection = lookup.data?.inspections?.[0]
  const tagId = tag?.id ?? ''
  const createInspection = useCreateInspection(tagId)

  // Reset checklist when a new tag loads.
  useEffect(() => {
    if (tag) {
      setChecklist(Object.fromEntries(DEFAULT_CHECKLIST.map((c) => [c.key, null])))
      setDefects('')
      setRemediation('')
    }
  }, [tag?.id])

  const computedStatus = useMemo<'pass' | 'fail' | null>(() => {
    const responses = Object.values(checklist)
    if (responses.length === 0 || responses.some((v) => v === null)) return null
    return responses.every((v) => v === true) ? 'pass' : 'fail'
  }, [checklist])

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!tag) return
    const payload: Parameters<typeof createInspection.mutate>[0] = {
      status,
      checklist: DEFAULT_CHECKLIST.map((c) => ({
        key: c.key,
        label: c.label,
        ok: checklist[c.key] === true,
      })),
    }
    if (defects) payload.defects = defects
    if (remediation) payload.remediation = remediation
    createInspection.mutate(payload, {
      onSuccess: () => {
        navigate(`/scaffold-inspections/${encodeURIComponent(token)}/done`)
      },
    })
  }

  const doneCount = useMemo(() => Object.values(checklist).filter((v) => v !== null).length, [checklist])

  return (
    <>
      <MTopBar
        back
        eyebrow="SCAFFOLD · INSPECT"
        title="Scaffold inspection"
        sub="Scan the tag or paste its token to record a daily check."
        onBack={() => navigate(-1)}
      />
      <MBody>
        <MSectionH>QR token</MSectionH>
        <div style={{ padding: '0 16px' }}>
          <MInput
            type="text"
            inputMode="text"
            value={token}
            onChange={(e) => setToken(e.target.value.trim())}
            placeholder="Paste or type the token from the QR sticker"
            style={{ width: '100%', fontFamily: 'var(--m-num)' }}
          />
        </div>

        {token && lookup.isPending ? (
          <div className="m-section-bar" style={{ marginTop: 18 }}>
            <span>LOOKING UP TAG…</span>
          </div>
        ) : null}

        {lookup.error ? (
          <div style={{ padding: '12px 16px 0' }}>
            <div
              className="m-card"
              data-tone="accent"
              style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.35 }}
            >
              Tag not found for that token. Check it again or ask the office to re-print the sticker.
            </div>
          </div>
        ) : null}

        {tag ? (
          <>
            <div style={{ padding: '0 16px', marginTop: 18 }}>
              <MListInset>
                <MListRow
                  headline={tag.label}
                  supporting={
                    <>
                      {tag.structure_type}
                      {tag.height_m ? <> · {tag.height_m} m</> : null}
                      {tag.load_class ? <> · {tag.load_class}</> : null}
                    </>
                  }
                  trailing={
                    <MPill tone={tag.status === 'tagged_out' ? 'red' : tag.status === 'active' ? 'green' : undefined}>
                      {tag.status}
                    </MPill>
                  }
                />
                <MListRow
                  headline={
                    lastInspection ? (
                      <>
                        Last check {new Date(lastInspection.signed_at).toLocaleDateString()} —{' '}
                        <span
                          style={{
                            color:
                              lastInspection.status === 'pass' ? 'var(--m-good)' : 'var(--m-amber)',
                            fontWeight: 700,
                          }}
                        >
                          {lastInspection.status}
                        </span>
                      </>
                    ) : (
                      'No inspections recorded yet.'
                    )
                  }
                  supporting={
                    lastInspection?.next_due_on ? <>Next due {lastInspection.next_due_on}</> : undefined
                  }
                />
              </MListInset>
            </div>

            <form onSubmit={onSubmit}>
              <div className="m-section-bar" style={{ marginTop: 18 }}>
                <span>CHECKLIST</span>
                <span className="num" style={{ color: 'var(--m-ink)', fontWeight: 700 }}>
                  {doneCount}/{DEFAULT_CHECKLIST.length}
                </span>
              </div>
              <div style={{ borderBottom: '2px solid var(--m-ink)' }}>
                {DEFAULT_CHECKLIST.map((c) => (
                  <div
                    key={c.key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '14px 16px',
                      borderTop: '1px solid var(--m-line-2)',
                    }}
                  >
                    <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{c.label}</span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => setChecklist((s) => ({ ...s, [c.key]: true }))}
                        style={{
                          fontFamily: 'var(--m-num)',
                          fontSize: 11,
                          fontWeight: 700,
                          letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                          padding: '6px 12px',
                          border: '2px solid var(--m-ink)',
                          background: checklist[c.key] === true ? 'var(--m-good)' : 'transparent',
                          color: checklist[c.key] === true ? '#fff' : 'var(--m-ink-3)',
                        }}
                      >
                        OK
                      </button>
                      <button
                        type="button"
                        onClick={() => setChecklist((s) => ({ ...s, [c.key]: false }))}
                        style={{
                          fontFamily: 'var(--m-num)',
                          fontSize: 11,
                          fontWeight: 700,
                          letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                          padding: '6px 12px',
                          border: '2px solid var(--m-ink)',
                          background: checklist[c.key] === false ? 'var(--m-amber)' : 'transparent',
                          color: checklist[c.key] === false ? '#fff' : 'var(--m-ink-3)',
                        }}
                      >
                        Issue
                      </button>
                    </div>
                  </div>
                ))}
                {computedStatus ? (
                  <div
                    style={{
                      padding: '12px 16px',
                      borderTop: '1px solid var(--m-line-2)',
                      fontFamily: 'var(--m-num)',
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: 'var(--m-ink-3)',
                    }}
                  >
                    Suggested status:{' '}
                    <span style={{ color: 'var(--m-ink)', fontWeight: 700 }}>{computedStatus}</span>
                  </div>
                ) : null}
              </div>

              <MSectionH>Defects observed</MSectionH>
              <div style={{ padding: '0 16px' }}>
                <MTextarea
                  value={defects}
                  onChange={(e) => setDefects(e.target.value)}
                  rows={3}
                  style={{ width: '100%' }}
                />
              </div>

              <MSectionH>Remediation / next steps</MSectionH>
              <div style={{ padding: '0 16px' }}>
                <MTextarea
                  value={remediation}
                  onChange={(e) => setRemediation(e.target.value)}
                  rows={2}
                  style={{ width: '100%' }}
                />
              </div>

              <div className="m-section-bar" style={{ marginTop: 18 }}>
                <span>DECISION</span>
              </div>
              <div style={{ display: 'flex', gap: 8, padding: '14px 16px' }}>
                {(['pass', 'fail', 'tagged_out'] as const).map((s) => {
                  const active = status === s
                  const activeBg =
                    s === 'pass' ? 'var(--m-good)' : s === 'fail' ? 'var(--m-amber)' : 'var(--m-red)'
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setStatus(s)}
                      style={{
                        flex: 1,
                        fontFamily: 'var(--m-num)',
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        padding: '12px 0',
                        border: '2px solid var(--m-ink)',
                        background: active ? activeBg : 'transparent',
                        color: active ? '#fff' : 'var(--m-ink-3)',
                      }}
                    >
                      {s === 'tagged_out' ? 'Tag out' : s}
                    </button>
                  )
                })}
              </div>
              <p className="m-quiet-sm" style={{ padding: '0 16px', margin: 0 }}>
                "Tag out" locks the scaffold from use until a follow-up pass clears it.
              </p>

              <div style={{ padding: 16 }}>
                <MButton
                  type="submit"
                  variant="primary"
                  disabled={createInspection.isPending}
                  style={{ width: '100%' }}
                >
                  {createInspection.isPending ? 'Saving…' : 'Sign + save inspection'}
                </MButton>
              </div>
            </form>
          </>
        ) : null}
      </MBody>
    </>
  )
}
