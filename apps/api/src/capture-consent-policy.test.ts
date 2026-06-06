import { describe, expect, it } from 'vitest'
import { captureConsentAllowsArtifactKind, captureConsentAllowsEventClass } from './capture-consent-policy.js'

describe('captureConsentAllowsArtifactKind — repro_bracket', () => {
  it('allows repro_bracket when the scope lists it explicitly', () => {
    const scope = {
      streams: ['registered_artifacts', 'text_note'],
      artifacts: { repro_bracket: true, text_note: true },
      registered_artifacts: true,
      text_note: true,
    }
    expect(captureConsentAllowsArtifactKind(scope, 'repro_bracket')).toBe(true)
  })

  it('allows repro_bracket under a registered-artifacts grant even without an explicit entry', () => {
    const scope = { streams: ['registered_artifacts'], registered_artifacts: true }
    expect(captureConsentAllowsArtifactKind(scope, 'repro_bracket')).toBe(true)
  })

  it('denies repro_bracket when an explicit scope grants neither it nor registered artifacts', () => {
    const scope = { streams: ['audio'], artifacts: { audio: true }, audio: true }
    expect(captureConsentAllowsArtifactKind(scope, 'repro_bracket')).toBe(false)
  })

  it('keeps the produced repro consent scope self-consistent (allows its own artifacts/events)', () => {
    // The flat shape the web `buildReproBracketConsentScope({domReplay:true})` produces.
    const scope = {
      surface: 'authenticated_app',
      streams: ['dom_replay', 'registered_artifacts', 'text_note'],
      artifacts: {
        rrweb: true,
        canvas_geometry: true,
        screen_context: true,
        state_snapshot: true,
        text_note: true,
        repro_bracket: true,
      },
      event_classes: ['repro', 'authenticated_feedback'],
      audio: false,
      dom_replay: true,
      registered_artifacts: true,
      screen_video: false,
      text_note: true,
    }
    expect(captureConsentAllowsArtifactKind(scope, 'repro_bracket')).toBe(true)
    expect(captureConsentAllowsArtifactKind(scope, 'state_snapshot')).toBe(true)
    expect(captureConsentAllowsArtifactKind(scope, 'rrweb')).toBe(true)
    expect(captureConsentAllowsArtifactKind(scope, 'text_note')).toBe(true)
    // Audio/video stay forbidden — a reproduction bracket never implies them.
    expect(captureConsentAllowsArtifactKind(scope, 'audio')).toBe(false)
    expect(captureConsentAllowsArtifactKind(scope, 'video')).toBe(false)
    // The repro event class is allowed; an unrelated class is not.
    expect(captureConsentAllowsEventClass(scope, 'repro')).toBe(true)
    expect(captureConsentAllowsEventClass(scope, 'portal_feedback')).toBe(false)
  })
})
