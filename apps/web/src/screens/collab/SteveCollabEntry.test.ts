import { describe, expect, it } from 'vitest'
import { audioFlag, targetWithCaptureFlags } from './SteveCollabEntry'

// Guards the Steve one-link mic posture. The operator pastes this link to a
// non-developer collaborator, so the audio default and its opt-out must not
// silently regress, and the URL flag must stay in sync with the localStorage
// key the feedback dock reads (capture_audio <-> AUTH_FEEDBACK_AUDIO_*).
describe('SteveCollabEntry audioFlag', () => {
  it('defaults mic ON when ?audio is absent', () => {
    expect(audioFlag(new URLSearchParams(''))).toBe('1')
  })

  it('opts mic OFF with ?audio=0', () => {
    expect(audioFlag(new URLSearchParams('audio=0'))).toBe('0')
    expect(audioFlag(new URLSearchParams('audio=false'))).toBe('0')
    expect(audioFlag(new URLSearchParams('audio=no'))).toBe('0')
  })

  it('honors an explicit ?audio=1', () => {
    expect(audioFlag(new URLSearchParams('audio=1'))).toBe('1')
    expect(audioFlag(new URLSearchParams('audio=on'))).toBe('1')
  })
})

describe('SteveCollabEntry targetWithCaptureFlags', () => {
  it('stamps the full browser-capture kit on the destination by default', () => {
    const out = targetWithCaptureFlags('/desktop', new URLSearchParams(''))
    const params = new URLSearchParams(out.split('?')[1] ?? '')
    expect(params.get('capture_feedback')).toBe('1')
    expect(params.get('capture_replay')).toBe('1')
    expect(params.get('capture_audio')).toBe('1') // mic on by default
    expect(params.get('feedback_open')).toBe('1')
    expect(params.get('collab')).toBe('steve')
  })

  it('propagates ?audio=0 through to capture_audio=0', () => {
    const out = targetWithCaptureFlags('/desktop', new URLSearchParams('audio=0'))
    const params = new URLSearchParams(out.split('?')[1] ?? '')
    expect(params.get('capture_audio')).toBe('0')
  })
})
