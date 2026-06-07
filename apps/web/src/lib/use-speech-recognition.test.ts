import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { getSpeechRecognitionCtor, useSpeechRecognition } from './use-speech-recognition'

describe('getSpeechRecognitionCtor / useSpeechRecognition feature-detect', () => {
  const w = window as unknown as Record<string, unknown>
  let prevStd: unknown
  let prevWebkit: unknown
  beforeEach(() => {
    prevStd = w.SpeechRecognition
    prevWebkit = w.webkitSpeechRecognition
  })
  afterEach(() => {
    if (prevStd === undefined) delete w.SpeechRecognition
    else w.SpeechRecognition = prevStd
    if (prevWebkit === undefined) delete w.webkitSpeechRecognition
    else w.webkitSpeechRecognition = prevWebkit
  })

  it('reports unsupported when neither global is present', () => {
    delete w.SpeechRecognition
    delete w.webkitSpeechRecognition
    expect(getSpeechRecognitionCtor()).toBeNull()
    const { result } = renderHook(() => useSpeechRecognition())
    expect(result.current.supported).toBe(false)
  })

  it('reports supported when a constructor is present (incl. the webkit-prefixed one)', () => {
    delete w.SpeechRecognition
    class FakeRec {
      lang = ''
      interimResults = false
      continuous = false
      start() {}
      stop() {}
      onresult = null
      onend = null
      onerror = null
    }
    w.webkitSpeechRecognition = FakeRec
    expect(getSpeechRecognitionCtor()).toBe(FakeRec)
    const { result } = renderHook(() => useSpeechRecognition())
    expect(result.current.supported).toBe(true)
  })
})
