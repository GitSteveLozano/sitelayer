// Dispatch lanes admin screen — operator kill-switch UI.
//
// Lists every lane with its current state badge, pause reason, and
// last-decided-by/at. Operators can pause a lane (reason required,
// optional resume_after timestamp) or resume a lane (reason required).
// API is admin-only; on 403 the table renders empty + an error notice.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MPill, type MTone } from '@/components/m'
import {
  useDispatchLanes,
  usePauseDispatchLane,
  useResumeDispatchLane,
  type DispatchLane,
  type DispatchLaneState,
} from '@/lib/api'

const STATE_TONE: Record<DispatchLaneState, MTone> = {
  active: 'green',
  paused: 'red',
  degraded: 'amber',
}

export function DispatchLanesAdminScreen() {
  const lanes = useDispatchLanes()
  const rows = lanes.data?.lanes ?? []

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more" className="text-[12px] text-ink-3">
        ← More
      </Link>
      <h1 className="mt-2 font-display text-[26px] font-bold tracking-tight leading-tight">Dispatch lanes</h1>
      <p className="text-[12px] text-ink-3 mt-1">
        Per-runner kill-switches. Pause a lane to halt its drain without redeploying; resume to re-enable. The
        auto-pause keeper handles QBO circuit + outbox backlog automatically.
      </p>

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">
          {lanes.isPending ? 'Loading…' : `${rows.length} lane${rows.length === 1 ? '' : 's'}`}
        </div>
        {lanes.isError ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-bad">Failed to load lanes — admin role required.</div>
          </div>
        ) : null}
        {rows.length === 0 && !lanes.isPending && !lanes.isError ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">No lanes seeded yet.</div>
          </div>
        ) : (
          rows.map((lane) => <LaneRow key={lane.name} lane={lane} />)
        )}
      </div>
    </div>
  )
}

function LaneRow({ lane }: { lane: DispatchLane }) {
  const [showPauseModal, setShowPauseModal] = useState(false)
  const [showResumeModal, setShowResumeModal] = useState(false)

  return (
    <div className="m-card m-card-tight">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-[13px] font-semibold">{lane.name}</div>
            <MPill tone={STATE_TONE[lane.state]}>{lane.state}</MPill>
          </div>
          {lane.pause_reason ? (
            <div className="text-[11px] text-ink-3 mt-1 break-words">reason: {lane.pause_reason}</div>
          ) : null}
          {lane.paused_at ? (
            <div className="text-[11px] text-ink-3 mt-0.5">paused {new Date(lane.paused_at).toLocaleString()}</div>
          ) : null}
          {lane.resume_after ? (
            <div className="text-[11px] text-ink-3 mt-0.5">
              resume after {new Date(lane.resume_after).toLocaleString()}
            </div>
          ) : null}
          <div className="text-[11px] text-ink-3 mt-0.5">
            decided by {lane.last_decided_by} · {new Date(lane.last_decided_at).toLocaleString()}
          </div>
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          {lane.state === 'active' ? (
            <button
              type="button"
              onClick={() => setShowPauseModal(true)}
              className="text-[11px] px-3 py-1 rounded border border-line hover:bg-card-soft"
            >
              Pause
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setShowResumeModal(true)}
              className="text-[11px] px-3 py-1 rounded border border-line hover:bg-card-soft"
            >
              Resume
            </button>
          )}
        </div>
      </div>
      {showPauseModal ? <PauseModal lane={lane} onClose={() => setShowPauseModal(false)} /> : null}
      {showResumeModal ? <ResumeModal lane={lane} onClose={() => setShowResumeModal(false)} /> : null}
    </div>
  )
}

function PauseModal({ lane, onClose }: { lane: DispatchLane; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [resumeAfter, setResumeAfter] = useState('')
  const pause = usePauseDispatchLane()

  const handleSubmit = () => {
    const trimmed = reason.trim()
    if (!trimmed) return
    pause.mutate(
      {
        name: lane.name,
        body: {
          reason: trimmed,
          resume_after: resumeAfter ? new Date(resumeAfter).toISOString() : null,
        },
      },
      {
        onSuccess: onClose,
      },
    )
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-5"
      onClick={onClose}
    >
      <div className="bg-card rounded-lg p-4 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
        <div className="text-[14px] font-semibold mb-3">Pause lane: {lane.name}</div>
        <label className="block">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Reason</div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. qbo_live_flip: dry-run before QBO push"
            className="mt-1 w-full text-[13px] py-2 px-2 border border-line rounded bg-transparent focus:outline-none focus:border-accent"
          />
        </label>
        <label className="block mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
            Resume after (optional)
          </div>
          <input
            type="datetime-local"
            value={resumeAfter}
            onChange={(e) => setResumeAfter(e.target.value)}
            className="mt-1 w-full text-[13px] py-2 px-2 border border-line rounded bg-transparent focus:outline-none focus:border-accent"
          />
        </label>
        {pause.isError ? (
          <div className="text-[11px] text-bad mt-2">Failed to pause — check console for details.</div>
        ) : null}
        <div className="flex gap-2 mt-4 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] px-3 py-1.5 rounded border border-line hover:bg-card-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!reason.trim() || pause.isPending}
            className="text-[12px] px-3 py-1.5 rounded bg-bad text-white hover:opacity-80 disabled:opacity-40"
          >
            {pause.isPending ? 'Pausing…' : 'Pause lane'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ResumeModal({ lane, onClose }: { lane: DispatchLane; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const resume = useResumeDispatchLane()

  const handleSubmit = () => {
    const trimmed = reason.trim()
    if (!trimmed) return
    resume.mutate(
      { name: lane.name, body: { reason: trimmed } },
      {
        onSuccess: onClose,
      },
    )
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-5"
      onClick={onClose}
    >
      <div className="bg-card rounded-lg p-4 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
        <div className="text-[14px] font-semibold mb-3">Resume lane: {lane.name}</div>
        <label className="block">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Reason</div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. issue resolved, restoring service"
            className="mt-1 w-full text-[13px] py-2 px-2 border border-line rounded bg-transparent focus:outline-none focus:border-accent"
          />
        </label>
        {resume.isError ? (
          <div className="text-[11px] text-bad mt-2">Failed to resume — check console for details.</div>
        ) : null}
        <div className="flex gap-2 mt-4 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] px-3 py-1.5 rounded border border-line hover:bg-card-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!reason.trim() || resume.isPending}
            className="text-[12px] px-3 py-1.5 rounded bg-good text-white hover:opacity-80 disabled:opacity-40"
          >
            {resume.isPending ? 'Resuming…' : 'Resume lane'}
          </button>
        </div>
      </div>
    </div>
  )
}
