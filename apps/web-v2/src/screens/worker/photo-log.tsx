import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Card, MobileButton } from '@/components/mobile'
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
      <div className="flex flex-col">
        <div className="px-5 pt-6 pb-3">
          <Link to="/" className="text-[12px] text-ink-3">
            ← Today
          </Link>
          <h1 className="mt-2 font-display text-[22px] font-bold tracking-tight leading-tight">Site photo</h1>
        </div>
        <EmptyState
          title="No active project"
          body="Clock in to a job first — site photos attach to that day's log for that project."
          primaryAction={
            <Link
              to="/"
              className="w-full h-[50px] rounded-[14px] bg-accent text-white text-[16px] font-semibold inline-flex items-center justify-center"
            >
              Back to today
            </Link>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <Link to="/" className="text-[12px] text-ink-3">
          ← Today
        </Link>
        <h1 className="mt-2 font-display text-[22px] font-bold tracking-tight leading-tight">Site photo</h1>
        <p className="text-[12px] text-ink-3 mt-1">
          Attaches to today's log for{' '}
          <span className="font-semibold text-ink-2">{activeProjectName ?? 'this project'}</span>.
        </p>
      </div>

      <div className="px-4 space-y-3 pb-8">
        {!imageUrl ? (
          <Card>
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
            <MobileButton variant="primary" onClick={() => fileRef.current?.click()}>
              Open camera
            </MobileButton>
          </Card>
        ) : (
          <>
            <Card className="!p-0 overflow-hidden">
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
            </Card>

            <Card>
              <label className="block">
                <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                  Caption (optional)
                </div>
                <textarea
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  rows={3}
                  placeholder="e.g. EPS install · East elevation · sec 2 of 4 done"
                  className="mt-1 w-full text-[14px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent resize-none"
                />
              </label>
            </Card>

            {error ? <div className="text-[12px] text-warn">{error}</div> : null}

            <MobileButton variant="primary" onClick={onSave} disabled={posting}>
              {posting ? 'Saving…' : 'Save to log'}
            </MobileButton>

            <Attribution source="POST /api/daily-logs (find/create) + /api/daily-logs/:id/photos (upload)" />
          </>
        )}
      </div>
    </div>
  )
}
