import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { MBanner, MButton } from '../../components/m/index.js'
import { useAiChatEnabled } from '@/lib/api/operator-context-chat'
import { useSpeechRecognition } from '@/lib/use-speech-recognition'
import { resolveVoiceProjectIntent, type ProposedProjectFields } from '@/lib/api/voice-project-intent'

/**
 * VOICE PROJECT SETUP (v1) — optional mic control on the new-project flow.
 *
 * Voice PROPOSES fields; the human CONFIRMS. Speaking ("new project called
 * Maple Ridge for Acme, scaffold and concrete divisions") captures a transcript,
 * which is staged + parsed via the operator's mesh AI path; the parsed fields
 * are handed to `onProposed` so the PARENT pre-fills its (editable) form. This
 * control NEVER creates a project — the mandatory Create tap goes through the
 * existing POST /api/projects in the parent.
 *
 * Gating (renders nothing unless ALL hold):
 *   - features.ai_chat_enabled === true (same flag the operator chat reads — the
 *     parse path is the same mesh hand-off; a non-AI instance no-ops);
 *   - the browser supports the Web Speech API (feature-detected).
 *
 * Capability/role gating matches the create-project path: the host screen only
 * mounts this where create is reachable, and the API re-checks admin/office +
 * create_project on the stage endpoint.
 */
export function VoiceProjectSetupControl({ onProposed }: { onProposed: (fields: ProposedProjectFields) => void }) {
  const { data: aiChatEnabled } = useAiChatEnabled()
  const [parsing, setParsing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // Latched final transcript so the operator can see what was heard while it
  // parses, and re-try without re-speaking if the parse times out.
  const [heard, setHeard] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const runParse = (transcript: string) => {
    setHeard(transcript)
    setNotice(null)
    setParsing(true)
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    void resolveVoiceProjectIntent(transcript, { signal: controller.signal })
      .then((proposed) => {
        if (!mountedRef.current || controller.signal.aborted) return
        if (proposed) {
          // Hand the proposal to the parent form. The human reviews + edits +
          // taps Create; this control never creates anything itself.
          onProposed(proposed)
          setNotice('Filled in below — review and edit, then tap Create.')
        } else {
          setNotice('Could not turn that into project fields — type the details instead.')
        }
      })
      .catch(() => {
        if (!mountedRef.current || controller.signal.aborted) return
        setNotice('Voice setup is unavailable right now — type the details instead.')
      })
      .finally(() => {
        if (mountedRef.current && !controller.signal.aborted) setParsing(false)
      })
  }

  const speech = useSpeechRecognition({ onFinal: runParse })

  // Hide entirely when the AI path isn't configured OR the browser can't do
  // speech. `aiChatEnabled` is undefined while /api/features loads — keep the
  // control hidden until we've confirmed true (fail-closed; never offer a mic
  // that can't reach a parse path).
  if (aiChatEnabled !== true || !speech.supported) return null

  const busy = speech.listening || parsing

  return (
    <div style={wrapStyle} data-testid="voice-project-setup">
      <div style={rowStyle}>
        <MButton
          variant={speech.listening ? 'primary' : 'ghost'}
          size="sm"
          disabled={parsing}
          aria-label={speech.listening ? 'Stop voice setup' : 'Set up by voice'}
          aria-pressed={speech.listening}
          onClick={() => {
            if (speech.listening) {
              speech.stop()
            } else {
              setNotice(null)
              speech.reset()
              speech.start()
            }
          }}
        >
          {speech.listening ? 'Stop mic' : 'Set up by voice'}
        </MButton>
        {speech.listening ? (
          <span style={hintStyle}>
            Listening… e.g. “new project called Maple Ridge for Acme, scaffold and concrete”.
          </span>
        ) : parsing ? (
          <span style={hintStyle}>Parsing what you said…</span>
        ) : heard ? (
          <span style={heardStyle}>Heard: “{heard}”</span>
        ) : (
          <span style={hintStyle}>Optional — say the project name, customer, and divisions.</span>
        )}
      </div>
      {speech.error ? <MBanner tone="error" title="Voice capture failed" body={speech.error} /> : null}
      {notice ? <span style={noticeStyle}>{notice}</span> : null}
      <span style={confirmHintStyle} aria-hidden={busy ? undefined : true}>
        Voice only fills the form — nothing is created until you tap Create.
      </span>
    </div>
  )
}

const wrapStyle: CSSProperties = { display: 'grid', gap: 8, padding: '0 16px' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
const hintStyle: CSSProperties = { fontSize: 12, color: 'var(--m-ink-3)' }
const heardStyle: CSSProperties = { fontSize: 12, color: 'var(--m-ink-2)', fontStyle: 'italic' }
const noticeStyle: CSSProperties = { fontSize: 12, color: 'var(--m-ink-2)' }
const confirmHintStyle: CSSProperties = { fontSize: 11, color: 'var(--m-ink-3)' }
