import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { MButton } from '../m/index.js'
import { fetchCaptureArtifactBlob, type CaptureArtifactSummary } from '@/lib/api/capture-sessions'
import {
  createRrwebReplayer,
  formatReproDuration,
  formatReproOffset,
  parseReproBracketSummary,
  parseRrwebReplayEvents,
  type ReproBracketView,
  type RrwebReplayerLike,
} from '@/lib/repro-replay'

type PlayerState = 'idle' | 'loading' | 'ready' | 'error'

type ReproReplayPanelProps = {
  captureSessionId: string
  reproArtifact?: CaptureArtifactSummary | null
  rrwebArtifact?: CaptureArtifactSummary | null
  /** Injectable for tests. */
  fetchBlob?: typeof fetchCaptureArtifactBlob
  /** Injectable for tests (avoids loading rrweb in jsdom). */
  createReplayer?: typeof createRrwebReplayer
}

/**
 * Operator-side viewer for a captured reproduction: renders the `repro_bracket`
 * summary (start condition, problem, duration, timestamped marks) and plays the
 * `rrweb` DOM replay in-app, with each mark a seek button into the replay. The
 * heavy rrweb player loads lazily on the first "Play reproduction" click.
 */
export function ReproReplayPanel({
  captureSessionId,
  reproArtifact,
  rrwebArtifact,
  fetchBlob = fetchCaptureArtifactBlob,
  createReplayer = createRrwebReplayer,
}: ReproReplayPanelProps) {
  const [summary, setSummary] = useState<ReproBracketView | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [playerState, setPlayerState] = useState<PlayerState>('idle')
  const [playerError, setPlayerError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const replayerRef = useRef<RrwebReplayerLike | null>(null)

  useEffect(() => {
    if (!reproArtifact) return
    let cancelled = false
    void (async () => {
      try {
        const blob = await fetchBlob(captureSessionId, reproArtifact.id)
        const parsed = parseReproBracketSummary(JSON.parse(await blob.text()))
        if (!cancelled) setSummary(parsed)
      } catch (e) {
        if (!cancelled) setSummaryError(e instanceof Error ? e.message : 'Failed to load reproduction summary')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [captureSessionId, reproArtifact, fetchBlob])

  useEffect(() => {
    return () => replayerRef.current?.destroy?.()
  }, [])

  async function startPlayback() {
    if (!rrwebArtifact || !containerRef.current) return
    setPlayerState('loading')
    setPlayerError(null)
    try {
      const blob = await fetchBlob(captureSessionId, rrwebArtifact.id)
      const events = parseRrwebReplayEvents(JSON.parse(await blob.text()))
      if (!events) throw new Error('This replay has too few events to play.')
      replayerRef.current?.destroy?.()
      replayerRef.current = await createReplayer(events, containerRef.current)
      replayerRef.current.play()
      setPlayerState('ready')
    } catch (e) {
      setPlayerState('error')
      setPlayerError(e instanceof Error ? e.message : 'Could not start the replay.')
    }
  }

  function seekTo(offsetMs: number) {
    if (playerState !== 'ready') return
    replayerRef.current?.play(offsetMs)
  }

  if (!reproArtifact && !rrwebArtifact) return null
  const marksSeekable = playerState === 'ready' && Boolean(rrwebArtifact)

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>Reproduction</div>

      {summary ? (
        <div style={{ display: 'grid', gap: 6 }}>
          {summary.start_note ? (
            <div style={lineStyle}>
              <span style={labelStyle}>Start</span> {summary.start_note}
            </div>
          ) : null}
          {summary.end_note ? (
            <div style={lineStyle}>
              <span style={labelStyle}>Problem</span> {summary.end_note}
            </div>
          ) : null}
          <div style={metaStyle}>
            {summary.route_path ? `${summary.route_path} · ` : ''}
            {formatReproDuration(summary.duration_ms)}
            {summary.replay_enabled ? ' · screen replay' : ''}
          </div>
          {summary.marks.length ? (
            <div style={marksRowStyle}>
              <span style={metaStyle}>Marks</span>
              {summary.marks.map((mark, i) => (
                <button
                  key={`${mark.offset_ms}-${i}`}
                  type="button"
                  style={marksSeekable ? markChipActiveStyle : markChipStyle}
                  onClick={() => seekTo(mark.offset_ms)}
                  disabled={!marksSeekable}
                  title={marksSeekable ? 'Jump the replay to this moment' : 'Play the reproduction to jump to marks'}
                >
                  {formatReproOffset(mark.offset_ms)} · {mark.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : summaryError ? (
        <div style={errorStyle}>{summaryError}</div>
      ) : reproArtifact ? (
        <div style={metaStyle}>Loading reproduction…</div>
      ) : null}

      {rrwebArtifact ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div
            ref={containerRef}
            style={playerState === 'ready' ? playerContainerActiveStyle : playerContainerStyle}
            data-testid="repro-replay-container"
          />
          <div style={controlsStyle}>
            {playerState === 'idle' || playerState === 'error' ? (
              <MButton variant="ghost" onClick={startPlayback}>
                Play reproduction
              </MButton>
            ) : playerState === 'loading' ? (
              <span style={metaStyle}>Loading replay…</span>
            ) : (
              <>
                <MButton variant="ghost" onClick={() => replayerRef.current?.play()}>
                  Play
                </MButton>
                <MButton variant="ghost" onClick={() => replayerRef.current?.pause()}>
                  Pause
                </MButton>
              </>
            )}
          </div>
          {playerError ? <div style={errorStyle}>{playerError}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

const panelStyle: CSSProperties = {
  display: 'grid',
  gap: 10,
  padding: 12,
  border: '1px solid #e2dccc',
  borderRadius: 8,
  background: '#fffdf7',
}
const titleStyle: CSSProperties = { fontWeight: 700, fontSize: 13, color: '#3f372c' }
const lineStyle: CSSProperties = { fontSize: 13, color: '#3f372c' }
const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  color: '#8a7f70',
  marginRight: 6,
}
const metaStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  color: '#6b6155',
}
const marksRowStyle: CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }
const markChipStyle: CSSProperties = {
  fontSize: 12,
  padding: '3px 8px',
  borderRadius: 999,
  border: '1px solid #e2dccc',
  background: '#f5f1e8',
  color: '#8a7f70',
  cursor: 'default',
}
const markChipActiveStyle: CSSProperties = {
  ...markChipStyle,
  background: '#fff',
  color: '#2d5fa6',
  borderColor: '#cdb',
  cursor: 'pointer',
}
const controlsStyle: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }
const playerContainerStyle: CSSProperties = { display: 'none' }
const playerContainerActiveStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  minHeight: 200,
  maxHeight: 420,
  overflow: 'auto',
  borderRadius: 6,
  border: '1px solid #e2dccc',
  background: '#fff',
}
const errorStyle: CSSProperties = { color: '#b4231f', fontSize: 12 }
