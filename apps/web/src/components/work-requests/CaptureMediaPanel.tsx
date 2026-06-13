import { useEffect, useState, type CSSProperties } from 'react'
import { MButton } from '../m/index.js'
import { fetchCaptureArtifactBlob, type CaptureArtifactSummary } from '@/lib/api/capture-sessions'
import { ReproReplayPanel } from './ReproReplayPanel'

type CaptureMediaPanelProps = {
  captureSessionId: string | null | undefined
  artifacts: CaptureArtifactSummary[]
}

type MediaShape = 'video' | 'audio' | 'image' | 'text' | 'download'

function mediaShape(a: CaptureArtifactSummary): MediaShape {
  const ct = (a.content_type ?? '').toLowerCase()
  if (ct.startsWith('video/') || a.kind === 'video') return 'video'
  if (ct.startsWith('audio/') || a.kind === 'audio') return 'audio'
  if (ct.startsWith('image/') || a.kind === 'screenshot' || a.kind === 'image') return 'image'
  if (ct.startsWith('text/') || a.kind === 'transcript') return 'text'
  return 'download'
}

function formatBytes(value: string | number | null): string {
  const n = typeof value === 'string' ? Number(value) : value
  if (n === null || !Number.isFinite(n as number)) return ''
  let size = n as number
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (size < 1024 || unit === 'GB') return `${size < 10 && unit !== 'B' ? size.toFixed(1) : Math.round(size)} ${unit}`
    size /= 1024
  }
  return ''
}

function ArtifactRow({ captureSessionId, artifact }: { captureSessionId: string; artifact: CaptureArtifactSummary }) {
  const shape = mediaShape(artifact)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [objectUrl])

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const blob = await fetchCaptureArtifactBlob(captureSessionId, artifact.id)
      if (shape === 'text') {
        setText(await blob.text())
      } else {
        setObjectUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return URL.createObjectURL(blob)
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load artifact')
    } finally {
      setLoading(false)
    }
  }

  const meta = [artifact.kind, artifact.content_type, formatBytes(artifact.byte_size), artifact.pii_level]
    .filter(Boolean)
    .join(' · ')

  return (
    <div style={rowStyle}>
      <div style={metaStyle}>{meta}</div>
      {error ? <div style={errorStyle}>{error}</div> : null}

      {objectUrl && shape === 'video' ? (
        <video src={objectUrl} controls style={mediaStyle} />
      ) : objectUrl && shape === 'audio' ? (
        <audio src={objectUrl} controls style={{ width: '100%' }} />
      ) : objectUrl && shape === 'image' ? (
        <img src={objectUrl} alt={`${artifact.kind} capture`} style={mediaStyle} />
      ) : text !== null ? (
        <pre style={textStyle}>{text}</pre>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {shape !== 'download' && objectUrl === null && text === null ? (
          <MButton variant="ghost" disabled={loading} onClick={load}>
            {loading
              ? 'Loading…'
              : shape === 'video'
                ? 'Play recording'
                : shape === 'audio'
                  ? 'Play audio'
                  : shape === 'image'
                    ? 'Show screenshot'
                    : 'Show text'}
          </MButton>
        ) : null}
        {objectUrl ? (
          <a href={objectUrl} download style={linkStyle}>
            Download
          </a>
        ) : shape === 'download' ? (
          <MButton variant="ghost" disabled={loading} onClick={load}>
            {loading ? 'Loading…' : 'Download / open'}
          </MButton>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Operator-side viewer for the media a collaborator (e.g. Steve) captured:
 * screen recording, mic audio, screenshots, transcript. Reads the artifact
 * list already snapshotted into the support packet's
 * `server_context.capture_session.artifacts[]`; each item fetches its bytes
 * on demand through the authed file route. The DOM replay (`rrweb`) and the
 * reproduction summary (`repro_bracket`) are surfaced together in
 * `ReproReplayPanel`, which plays the replay in-app and seeks to marks.
 */
export function CaptureMediaPanel({ captureSessionId, artifacts }: CaptureMediaPanelProps) {
  if (!captureSessionId || artifacts.length === 0) return null
  const rrwebArtifact = artifacts.find((a) => a.kind === 'rrweb') ?? null
  const reproArtifact = artifacts.find((a) => a.kind === 'repro_bracket') ?? null
  const rest = artifacts.filter((a) => a.kind !== 'rrweb' && a.kind !== 'repro_bracket')
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {rrwebArtifact || reproArtifact ? (
        <ReproReplayPanel
          captureSessionId={captureSessionId}
          reproArtifact={reproArtifact}
          rrwebArtifact={rrwebArtifact}
        />
      ) : null}
      {rest.map((artifact) => (
        <ArtifactRow key={artifact.id} captureSessionId={captureSessionId} artifact={artifact} />
      ))}
    </div>
  )
}

const rowStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
  padding: 12,
  border: '1px solid #e2dccc',
  background: '#fffdf7',
}
const metaStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  color: '#6b6155',
}
const mediaStyle: CSSProperties = { width: '100%', maxHeight: 360, background: '#000' }
const textStyle: CSSProperties = {
  whiteSpace: 'pre-wrap',
  fontSize: 12,
  maxHeight: 240,
  overflow: 'auto',
  margin: 0,
  padding: 8,
  background: '#f5f1e8',
}
const errorStyle: CSSProperties = { color: '#b4231f', fontSize: 12 }
const linkStyle: CSSProperties = { fontSize: 13, color: '#2d5fa6', alignSelf: 'center' }
