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
import { Card, MobileButton, Pill } from '@/components/mobile'
import { useCreateInspection, useTagByToken } from '@/lib/api/scaffold-tags'

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

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <h1 className="font-display text-[26px] font-bold tracking-tight leading-tight">Scaffold inspection</h1>
      <p className="text-[12px] text-ink-3 mt-1">Scan the tag or paste its token to record a daily check.</p>

      <Card tight>
        <label className="block">
          <span className="text-[12px] text-ink-3">QR token</span>
          <input
            type="text"
            inputMode="text"
            value={token}
            onChange={(e) => setToken(e.target.value.trim())}
            placeholder="Paste or type the token from the QR sticker"
            className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[14px] font-mono"
          />
        </label>
      </Card>

      {token && lookup.isPending ? (
        <Card tight>
          <div className="text-[12px] text-ink-3 mt-4">Looking up tag…</div>
        </Card>
      ) : null}

      {lookup.error ? (
        <Card tight>
          <div className="text-[12px] text-warning mt-4">
            Tag not found for that token. Check it again or ask the office to re-print the sticker.
          </div>
        </Card>
      ) : null}

      {tag ? (
        <>
          <Card>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[15px] font-semibold">{tag.label}</div>
                <div className="text-[11px] text-ink-3 mt-0.5">
                  {tag.structure_type}
                  {tag.height_m ? <> · {tag.height_m} m</> : null}
                  {tag.load_class ? <> · {tag.load_class}</> : null}
                </div>
              </div>
              <Pill tone={tag.status === 'tagged_out' ? 'bad' : tag.status === 'active' ? 'good' : 'default'}>
                {tag.status}
              </Pill>
            </div>
            {lastInspection ? (
              <div className="text-[11px] text-ink-3 mt-2">
                Last check {new Date(lastInspection.signed_at).toLocaleDateString()} —{' '}
                <span
                  className={
                    lastInspection.status === 'pass'
                      ? 'text-good'
                      : lastInspection.status === 'fail'
                        ? 'text-warning'
                        : 'text-warning'
                  }
                >
                  {lastInspection.status}
                </span>
                {lastInspection.next_due_on ? <> · next due {lastInspection.next_due_on}</> : null}
              </div>
            ) : (
              <div className="text-[11px] text-ink-3 mt-2">No inspections recorded yet.</div>
            )}
          </Card>

          <form onSubmit={onSubmit} className="mt-6 space-y-3">
            <Card>
              <div className="text-[13px] font-semibold mb-2">Checklist</div>
              <ul className="space-y-2">
                {DEFAULT_CHECKLIST.map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-3">
                    <span className="text-[13px] flex-1">{c.label}</span>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setChecklist((s) => ({ ...s, [c.key]: true }))}
                        className={`px-2 py-1 text-[12px] rounded ${
                          checklist[c.key] === true ? 'bg-good text-white' : 'bg-base-2 text-ink-3'
                        }`}
                      >
                        OK
                      </button>
                      <button
                        type="button"
                        onClick={() => setChecklist((s) => ({ ...s, [c.key]: false }))}
                        className={`px-2 py-1 text-[12px] rounded ${
                          checklist[c.key] === false ? 'bg-warning text-white' : 'bg-base-2 text-ink-3'
                        }`}
                      >
                        Issue
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {computedStatus ? (
                <div className="text-[11px] text-ink-3 mt-3">
                  Suggested status: <span className="font-semibold">{computedStatus}</span>
                </div>
              ) : null}
            </Card>

            <Card>
              <label className="block">
                <span className="text-[12px] text-ink-3">Defects observed</span>
                <textarea
                  value={defects}
                  onChange={(e) => setDefects(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[13px]"
                />
              </label>
              <label className="block mt-3">
                <span className="text-[12px] text-ink-3">Remediation / next steps</span>
                <textarea
                  value={remediation}
                  onChange={(e) => setRemediation(e.target.value)}
                  rows={2}
                  className="mt-1 w-full rounded-md border border-line bg-base p-2 text-[13px]"
                />
              </label>
            </Card>

            <Card>
              <div className="text-[13px] font-semibold mb-2">Decision</div>
              <div className="flex gap-2">
                {(['pass', 'fail', 'tagged_out'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatus(s)}
                    className={`flex-1 py-2 text-[13px] rounded ${
                      status === s
                        ? s === 'pass'
                          ? 'bg-good text-white'
                          : s === 'fail'
                            ? 'bg-warning text-white'
                            : 'bg-danger text-white'
                        : 'bg-base-2 text-ink-3'
                    }`}
                  >
                    {s === 'tagged_out' ? 'Tag out' : s}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-ink-3 mt-2">
                "Tag out" locks the scaffold from use until a follow-up pass clears it.
              </p>
            </Card>

            <MobileButton type="submit" variant="primary" disabled={createInspection.isPending} className="w-full">
              {createInspection.isPending ? 'Saving…' : 'Sign + save inspection'}
            </MobileButton>
          </form>
        </>
      ) : null}
    </div>
  )
}
