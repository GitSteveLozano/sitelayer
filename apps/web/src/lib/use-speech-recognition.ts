import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * Minimal Web Speech API surface — TypeScript's lib doesn't ship the type. Kept
 * local (mirrors the AgentSupervisionPanel voice-approve control) to avoid extra
 * ambient types. The recognizer is feature-detected; callers HIDE the control
 * when `supported` is false.
 */
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  start(): void
  stop(): void
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}
interface SpeechRecognitionResultEvent {
  results: ArrayLike<{ isFinal?: boolean; [index: number]: { transcript: string } }>
}

export function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export interface UseSpeechRecognitionResult {
  /** False when the browser has no SpeechRecognition — callers hide the control. */
  supported: boolean
  listening: boolean
  /** The live (interim + final) transcript captured so far. */
  transcript: string
  /** A user-facing error/notice, or null. */
  error: string | null
  start: () => void
  stop: () => void
  reset: () => void
}

/**
 * Reusable single-utterance dictation hook. Feature-detected, English, one-shot
 * (continuous=false). `onFinal` fires once with the final transcript when
 * dictation ends, so the caller can act on the complete utterance rather than
 * interim partials. Stops the recognizer on unmount so the mic never lingers.
 */
export function useSpeechRecognition(
  opts: { lang?: string; onFinal?: (transcript: string) => void } = {},
): UseSpeechRecognitionResult {
  const supported = useMemo(() => getSpeechRecognitionCtor() !== null, [])
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const onFinalRef = useRef(opts.onFinal)
  onFinalRef.current = opts.onFinal
  const lang = opts.lang ?? 'en-US'

  useEffect(() => {
    return () => recognitionRef.current?.stop()
  }, [])

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor || recognitionRef.current) return
    setError(null)
    setTranscript('')
    const rec = new Ctor()
    rec.lang = lang
    rec.interimResults = true
    rec.continuous = false
    rec.onresult = (event: SpeechRecognitionResultEvent) => {
      let text = ''
      for (let i = 0; i < event.results.length; i += 1) {
        text += event.results[i]?.[0]?.transcript ?? ''
      }
      setTranscript(text)
    }
    rec.onend = () => {
      setListening(false)
      recognitionRef.current = null
      setTranscript((finalText) => {
        const trimmed = finalText.trim()
        if (trimmed) onFinalRef.current?.(trimmed)
        return finalText
      })
    }
    rec.onerror = () => {
      setListening(false)
      recognitionRef.current = null
      setError('Voice capture failed — type the details instead.')
    }
    rec.start()
    recognitionRef.current = rec
    setListening(true)
  }, [lang])

  const stop = useCallback(() => {
    recognitionRef.current?.stop()
    setListening(false)
  }, [])

  const reset = useCallback(() => {
    setTranscript('')
    setError(null)
  }, [])

  return { supported, listening, transcript, error, start, stop, reset }
}
