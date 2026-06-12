import { useState, type CSSProperties } from 'react'
import { useCaptureTakeoffDraft, type CaptureKind } from '@/lib/api'

// Capture-pipeline entry — migrated from v1 takeoff-canvas so the consolidated
// est-canvas editor can run a capture without the legacy screen. Each pipeline
// creates a NEW takeoff draft of AI-proposed measurements the estimator then
// reviews on the canvas:
//   • RoomPlan / photogrammetry / drone — upload the captured JSON sidecar.
//   • blueprint_vision — a dry-run pass (the live Claude-vision sheet read needs
//     a server-side PDF + ANTHROPIC_API_KEY; until then dry-run previews the
//     resulting draft layout).
// `onCaptured` receives the new draft id so the host can switch to it.
type FilePipeline = Exclude<CaptureKind, 'blueprint_vision'>

const fileInputStyle: CSSProperties = {
  display: 'none',
}
const chipStyle: CSSProperties = {
  padding: '8px 10px',
  background: 'var(--m-card-soft)',
  color: 'var(--m-ink-2)',
  border: '2px solid var(--m-ink)',
  fontFamily: 'var(--m-num)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.04em',
  cursor: 'pointer',
}

export function CapturePanel({ projectId, onCaptured }: { projectId: string; onCaptured: (draftId: string) => void }) {
  const captureDraft = useCaptureTakeoffDraft(projectId)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const dispatch = (kind: CaptureKind, payload: Record<string, unknown>, name?: string) => {
    setError(null)
    setNote(null)
    captureDraft.mutate(
      { kind, ...(name ? { name } : {}), payload },
      {
        onSuccess: (res) => {
          onCaptured(res.draft.id)
          // Every pipeline this panel runs is synchronous today (file uploads +
          // blueprint dry-run), but the capture endpoint can 202 a live
          // blueprint read (async split 2026-06-12) — report it honestly
          // instead of claiming 0 captured quantities.
          setNote(
            res.result_summary.status === 'processing'
              ? 'Capture accepted — the AI read is running; the draft fills in when it completes.'
              : res.result_summary.review_required
                ? `Captured ${res.result_summary.quantities_count} quantities — some need review.`
                : `Captured ${res.result_summary.quantities_count} quantities.`,
          )
        },
        onError: (err) => setError(err instanceof Error ? err.message : 'Capture failed'),
      },
    )
  }

  const runFileCapture = (kind: FilePipeline, file: File | null) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result ?? '{}')) as unknown
        if (kind === 'roomplan') {
          dispatch(kind, { capturedRoomJson: parsed, capturedRoomJsonUri: `upload://${file.name}` }, file.name)
        } else if (kind === 'photogrammetry') {
          dispatch(kind, { labeledMesh: parsed }, file.name)
        } else {
          dispatch(kind, { sidecar: parsed, sidecarPath: `upload://${file.name}` }, file.name)
        }
      } catch (e) {
        setError(e instanceof Error ? `Invalid JSON: ${e.message}` : 'Invalid JSON')
      }
    }
    reader.onerror = () => setError('Failed to read file')
    reader.readAsText(file)
  }

  const runBlueprint = () => {
    const raw = typeof window !== 'undefined' ? window.prompt('Known dimension (ft)?', '30') : '30'
    const knownDimensionFt = raw ? Number(raw) : 30
    dispatch('blueprint_vision', { dryRun: true, knownDimensionFt }, 'Blueprint capture (dry-run)')
  }

  const pickers: Array<{ kind: FilePipeline; label: string }> = [
    { kind: 'roomplan', label: 'RoomPlan JSON…' },
    { kind: 'photogrammetry', label: 'Photogrammetry…' },
    { kind: 'drone', label: 'Drone sidecar…' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--m-ink-3)',
        }}
      >
        Capture / import scan
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {pickers.map((p) => (
          <label key={p.kind} style={chipStyle}>
            {p.label}
            <input
              type="file"
              accept="application/json,.json"
              style={fileInputStyle}
              disabled={captureDraft.isPending}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                e.target.value = ''
                runFileCapture(p.kind, f)
              }}
            />
          </label>
        ))}
        <button
          type="button"
          onClick={runBlueprint}
          disabled={captureDraft.isPending}
          style={{ ...chipStyle, opacity: captureDraft.isPending ? 0.5 : 1 }}
          title="Run blueprint_vision in dry-run mode"
        >
          Blueprint (dry-run)
        </button>
        {captureDraft.isPending ? (
          <span style={{ fontSize: 12, fontStyle: 'italic', color: 'var(--m-ink-3)' }}>capturing…</span>
        ) : null}
      </div>
      {error ? <div style={{ fontSize: 12, color: 'var(--m-red)' }}>{error}</div> : null}
      {note ? <div style={{ fontSize: 12, color: 'var(--m-green)' }}>{note}</div> : null}
    </div>
  )
}
