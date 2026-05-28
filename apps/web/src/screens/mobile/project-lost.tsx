/**
 * PROJECT · LOST capture (v2 brutalist). The operator marks a bid lost,
 * picks one of the six LostReasonCode reasons from a 2-col tile grid, and
 * optionally leaves a note. Submits via useSetProjectLostReason; if a
 * reason already exists it's preselected from the query.
 *
 * Pure renderer over the project-lost-reasons hooks — no business state
 * lives here beyond the local picker selection + note draft.
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  LOST_REASON_CODES,
  LOST_REASON_LABELS,
  type LostReasonCode,
  useProjectLostReason,
  useSetProjectLostReason,
} from '../../lib/api/project-lost-reasons.js'
import { MBanner, MBody, MButton, MTextarea, MTopBar } from '../../components/m/index.js'

export function MobileProjectLost() {
  const navigate = useNavigate()
  const { projectId = '' } = useParams<{ projectId: string }>()

  const query = useProjectLostReason(projectId)
  const mutation = useSetProjectLostReason(projectId)

  const [reason, setReason] = useState<LostReasonCode | null>(null)
  const [note, setNote] = useState('')

  // Preselect from the server snapshot once it lands. Only seed local state
  // while the picker is still untouched so we don't clobber an in-progress
  // edit on a background refetch.
  const existing = query.data?.lost_reason ?? null
  useEffect(() => {
    if (!existing) return
    setReason((prev) => prev ?? existing.reason)
    setNote((prev) => (prev ? prev : (existing.note ?? '')))
  }, [existing])

  const handleSave = () => {
    if (!reason) return
    const trimmed = note.trim()
    mutation.mutate(
      { reason, ...(trimmed ? { note: trimmed } : {}) },
      { onSuccess: () => navigate(-1) },
    )
  }

  return (
    <>
      <MTopBar back title="Mark lost" onBack={() => navigate(-1)} />
      <MBody pad>
        <MBanner tone="error" title="Bid lost" body="Log why this one got away so the win-rate report stays honest." />

        <div className="m-topbar-eyebrow" style={{ margin: '18px 0 10px' }}>
          REASON
        </div>
        {/* 2-col grid of square selectable tiles. Reuses the v2-styled
         * `.m-qa` surface; the picked tile flips to accent fill. */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {LOST_REASON_CODES.map((code) => {
            const isPicked = reason === code
            return (
              <button
                key={code}
                type="button"
                className="m-qa"
                data-tone={isPicked ? 'accent' : 'dark'}
                onClick={() => setReason(code)}
                aria-pressed={isPicked}
                style={{ minHeight: 96, justifyContent: 'space-between', gap: 8 }}
              >
                <span
                  style={{
                    fontFamily: 'var(--m-num)',
                    fontSize: 11,
                    letterSpacing: '0.08em',
                    color: 'var(--m-ink-3)',
                  }}
                >
                  {code.toUpperCase()}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--m-font-display)',
                    fontSize: 22,
                    fontWeight: 800,
                    lineHeight: 1.05,
                    letterSpacing: '-0.01em',
                    textAlign: 'left',
                  }}
                >
                  {LOST_REASON_LABELS[code]}
                </span>
              </button>
            )
          })}
        </div>

        <div className="m-topbar-eyebrow" style={{ margin: '22px 0 8px' }}>
          NOTES · OPTIONAL
        </div>
        <MTextarea
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          placeholder="What happened? Competitor, budget, timing…"
          style={{ width: '100%', minHeight: 110 }}
        />

        {mutation.isError ? (
          <div style={{ marginTop: 14 }}>
            <MBanner
              tone="error"
              title="Couldn't save the reason"
              body={mutation.error instanceof Error ? mutation.error.message : 'Try again.'}
            />
          </div>
        ) : null}

        <div style={{ marginTop: 18 }}>
          <MButton variant="primary" disabled={!reason || mutation.isPending} onClick={handleSave}>
            {mutation.isPending ? 'Saving…' : 'Save reason'}
          </MButton>
        </div>
      </MBody>
    </>
  )
}
