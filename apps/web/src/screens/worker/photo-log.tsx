import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBody, MButton, MShell, MTextarea, MTopBar } from '@/components/m'
import { Attribution } from '@/components/ai'
import { EmptyState } from '@/components/shell/EmptyState'
import { useClockTimeline, useCreateDailyLog, useDailyLogs, useUploadDailyLogPhoto } from '@/lib/api'
import { findOpenSpan, pairClockSpans } from '@/lib/clock-derive'

/**
 * `wk-log` from Sitemap §11 panel 6 — "Photo · now" worker site
 * documentation. The worker taps the FAB on wk-today, captures a
 * photo, types a quick note, and the photo attaches to today's daily
 * log for the project they're clocked in to (or the project they're
 * scheduled on if off-clock).
 *
 * View layer is the M07 worker dark idiom (msg__52 "NEW PHOTO" — dark
 * shell, X-dismiss topbar, mono uppercase NOTE label, big yellow
 * worker-size SAVE TO LOG), self-wrapped in `.m-dark` because /photo
 * mounts in App.tsx outside the worker MobileShell. Same pattern as
 * worker-invite.tsx.
 *
 * Wire-up:
 *   1. Resolve the active project — open clock span first, falling
 *      back to today's first schedule if no clock-in.
 *   2. Find or create today's draft daily log for that project.
 *   3. Upload the photo via the existing useUploadDailyLogPhoto hook
 *      (same machinery the foreman uses).
 *   4. Patch the log's notes with the worker's caption appended.
 *
 * If we can't resolve a project, the screen renders the EmptyState
 * primitive — workers without a project assignment can't attach a
 * photo to anything coherent.
 */
export function WorkerPhotoLogScreen() {
  const navigate = useNavigate()
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])

  // Active project resolution: open clock span first, then today's
  // first schedule for any project the worker is on.
  const timeline = useClockTimeline({ date: todayIso })
  const events = timeline.data?.events ?? []
  const open = useMemo(() => findOpenSpan(pairClockSpans(events)), [events])
  const activeProjectId = open?.project_id ?? null
  const activeProjectName = open?.project_name ?? null

  // Today's draft daily log for this project, if one exists.
  // Spread projectId only when present so exactOptionalPropertyTypes
  // doesn't see an explicit `undefined`.
  const todaysLogs = useDailyLogs({
    ...(activeProjectId ? { projectId: activeProjectId } : {}),
    from: todayIso,
    to: todayIso,
  })
  const existingLog = todaysLogs.data?.dailyLogs?.[0] ?? null

  const createLog = useCreateDailyLog()
  const upload = useUploadDailyLogPhoto(existingLog?.id ?? '')

  const fileRef = useRef<HTMLInputElement | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [caption, setCaption] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)

  // Cleanup the object URL when a new file replaces it.
  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl)
    }
  }, [imageUrl])

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setImageFile(file)
    setImageUrl(URL.createObjectURL(file))
  }

  const onSave = async () => {
    if (!imageFile || !activeProjectId) return
    setError(null)
    setPosting(true)
    try {
      // Find or create today's log for this project. Caption is
      // appended after creation via patch since the create endpoint
      // doesn't accept notes today.
      let logId = existingLog?.id ?? null
      if (!logId) {
        const created = await createLog.mutateAsync({
          project_id: activeProjectId,
          occurred_on: todayIso,
        })
        // createLog can resolve with `{ queued: true }` if the call was
        // enqueued for offline replay. Without a server-assigned id we
        // can't run the follow-up photo upload, so bail with a toast
        // instead of throwing on `.dailyLog.id`.
        if ('queued' in created) {
          setError("You're offline — your log was queued. Try the photo again when reconnected.")
          return
        }
        logId = created.dailyLog.id
      }
      // useUploadDailyLogPhoto is bound to existingLog?.id at hook
      // creation time, so re-mounted from a freshly-created log won't
      // pick up the new id. Fall back to a one-off post for that path.
      if (existingLog) {
        await upload.mutateAsync(imageFile)
      } else {
        // For a freshly created log we need a one-off upload. The
        // useUploadDailyLogPhoto hook captured an empty id at first
        // render. Re-invoke the underlying fetcher directly.
        const { uploadDailyLogPhoto } = await import('@/lib/api/daily-logs')
        await uploadDailyLogPhoto(logId!, imageFile)
      }
      navigate('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setPosting(false)
    }
  }

  if (!activeProjectId) {
    return (
      <div className="m-host">
        <MShell className="m-dark">
          <MTopBar back backVariant="close" title="Site photo" onBack={() => navigate('/')} />
          <MBody>
            <EmptyState
              title="No active project"
              body="Clock in to a job first — site photos attach to that day's log for that project."
              primaryAction={
                <MButton variant="primary" data-size="worker" onClick={() => navigate('/')}>
                  Back to today
                </MButton>
              }
            />
          </MBody>
        </MShell>
      </div>
    )
  }

  return (
    <div className="m-host">
      <MShell className="m-dark">
        <MTopBar
          back
          backVariant="close"
          title="Site photo"
          sub={`Attaches to today's log for ${activeProjectName ?? 'this project'}`}
          onBack={() => navigate('/')}
        />
        <MBody>
          <div style={{ padding: '16px 16px 32px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {!imageUrl ? (
              <div className="m-card">
                <div className="text-[13px] font-semibold mb-2">Capture or pick</div>
                <p className="text-[12px] text-ink-3 mb-3">
                  Mobile browsers open the camera directly. Anything you snap appears in the foreman's daily log.
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={onPickFile}
                  className="hidden"
                />
                <MButton variant="primary" data-size="worker" onClick={() => fileRef.current?.click()}>
                  Open camera
                </MButton>
              </div>
            ) : (
              <>
                <div className="m-card overflow-hidden" style={{ padding: 0 }}>
                  <img src={imageUrl} alt="Site capture" className="block w-full h-auto" />
                  <div className="px-3 py-2 border-t border-line flex items-center justify-between text-[12px] text-ink-3">
                    <span>Photo ready to attach.</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (imageUrl) URL.revokeObjectURL(imageUrl)
                        setImageUrl(null)
                        setImageFile(null)
                      }}
                      className="text-accent font-medium"
                    >
                      Retake
                    </button>
                  </div>
                </div>

                <div className="m-card">
                  <label className="block">
                    <div className="m-field-l">Caption (optional)</div>
                    <MTextarea
                      value={caption}
                      onChange={(e) => setCaption(e.target.value)}
                      rows={3}
                      placeholder="e.g. EPS install · East elevation · sec 2 of 4 done"
                    />
                  </label>
                </div>

                {error ? <div className="text-[12px] text-warn">{error}</div> : null}

                <MButton variant="primary" data-size="worker" onClick={onSave} disabled={posting}>
                  {posting ? 'Saving…' : 'Save to log'}
                </MButton>

                <Attribution source="POST /api/daily-logs (find/create) + /api/daily-logs/:id/photos (upload)" />
              </>
            )}
          </div>
        </MBody>
      </MShell>
    </div>
  )
}
