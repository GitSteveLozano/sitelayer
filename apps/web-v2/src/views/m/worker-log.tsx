/**
 * Photo + note logger — `wk-log`. Camera-first capture surface; auto-tags
 * the photo by geofence (project) + active scope step. Submits a
 * worker_issues row with kind=other and a [photo_log] tag in the message
 * body until a dedicated photo upload endpoint lands.
 */
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiPost, type BootstrapResponse } from '../../api-v1-compat.js'
import { MBody, MButton, MButtonStack, MI, MInput, MTapCard, MTextarea, MTopBar } from '../../components/m/index.js'
import { useSubmitForm } from '../../machines/submit-form.js'

export function WorkerLog({ bootstrap, companySlug }: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const projectId = bootstrap?.projects.find((p) => /progress|active/i.test(p.status))?.id ?? null
  const projectName = bootstrap?.projects.find((p) => p.id === projectId)?.name ?? 'this site'

  const handleFile = (file: File) => {
    setPreview(URL.createObjectURL(file))
  }

  // Workers post photo+note pings as worker_issues with a `[photo_log]`
  // tag in the message body — the foreman triages these into the
  // project's daily_log at end-of-day. Direct daily_log writes require
  // foreman+ role; the photo-upload path lands when /api/projects/:id/photos
  // ships in a follow-up.
  const { submit, isSubmitting, error } = useSubmitForm<{ projectId: string | null; note: string }, unknown>(
    async ({ projectId: pid, note: n }) => {
      const body: Record<string, unknown> = {
        kind: 'other',
        message: `[photo_log] ${n.trim() || 'Daily log photo.'}`,
      }
      if (pid) body.project_id = pid
      const res = await apiPost('/api/worker-issues', body, companySlug)
      navigate('/today')
      return res
    },
  )
  const handleSend = () => submit({ projectId, note })
  const busy = isSubmitting

  return (
    <>
      <MTopBar back title="Log photo" onBack={() => navigate('/today')} />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div
          style={{
            flex: 1,
            background: '#1a160f',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--m-ink-3)',
            overflow: 'hidden',
          }}
        >
          {preview ? (
            <img src={preview} alt="Captured" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <MTapCard
              onClick={() => inputRef.current?.click()}
              style={{
                background: 'transparent',
                border: '2px dashed var(--m-line-2)',
                color: 'var(--m-ink-3)',
                borderRadius: 18,
                padding: '40px 28px',
                width: 'auto',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <MI.Camera size={36} />
              <span style={{ fontSize: 14, fontWeight: 500 }}>Tap to capture</span>
            </MTapCard>
          )}
          <div
            style={{
              position: 'absolute',
              top: 12,
              left: 12,
              right: 12,
              padding: '6px 12px',
              borderRadius: 999,
              background: 'rgba(217,144,74,0.92)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ width: 6, height: 6, background: '#fff', borderRadius: '50%' }} />
            {projectName} · auto-tagged
          </div>
        </div>
        <MBody pad>
          <MInput
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0]
              if (f) handleFile(f)
            }}
            style={{ display: 'none' }}
          />
          {preview ? (
            <>
              <MTextarea
                value={note}
                onChange={(e) => setNote(e.currentTarget.value)}
                placeholder="Add a note — optional"
                style={{ width: '100%', minHeight: 80 }}
              />
              {error ? <div style={{ marginTop: 12, color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
              <div style={{ marginTop: 12 }}>
                <MButtonStack>
                  <MButton variant="primary" onClick={handleSend} disabled={busy}>
                    {busy ? 'Sending…' : 'Send to daily log'}
                  </MButton>
                  <MButton
                    variant="ghost"
                    onClick={() => {
                      setPreview(null)
                      setNote('')
                    }}
                  >
                    Retake
                  </MButton>
                </MButtonStack>
              </div>
            </>
          ) : null}
        </MBody>
      </div>
    </>
  )
}
