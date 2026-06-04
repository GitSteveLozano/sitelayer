import { describe, expect, it } from 'vitest'
import {
  buildAuthenticatedFeedbackConsentScope,
  buildAuthenticatedScreenRecordingConsentScope,
  buildAuthenticatedTextIssueConsentScope,
  buildPortalFeedbackConsentScope,
} from './capture-policy'

describe('capture consent policy builders', () => {
  it('makes audio feedback explicit as stream and artifact consent', () => {
    expect(buildAuthenticatedFeedbackConsentScope({ audio: true, domReplay: false })).toMatchObject({
      surface: 'authenticated_app',
      streams: ['audio', 'registered_artifacts', 'text_note'],
      artifacts: {
        audio: true,
        transcript: true,
        text_note: true,
        canvas_geometry: true,
        screen_context: true,
        state_snapshot: true,
      },
      event_classes: ['authenticated_feedback'],
      audio: true,
      dom_replay: false,
      registered_artifacts: true,
      screen_video: false,
      text_note: true,
    })
  })

  it('adds rrweb only when DOM replay is consented', () => {
    expect(buildAuthenticatedFeedbackConsentScope({ audio: false, domReplay: true })).toMatchObject({
      streams: ['dom_replay', 'registered_artifacts', 'text_note'],
      artifacts: {
        rrweb: true,
      },
      audio: false,
      dom_replay: true,
    })
  })

  it('keeps Steve text issue scope free of microphone consent', () => {
    expect(buildAuthenticatedTextIssueConsentScope()).toMatchObject({
      streams: ['text_note', 'registered_artifacts'],
      artifacts: {
        text_note: true,
        canvas_geometry: true,
        screen_context: true,
        state_snapshot: true,
      },
      audio: false,
      dom_replay: false,
      registered_artifacts: true,
    })
  })

  it('makes screen recording video consent separate from microphone consent', () => {
    expect(buildAuthenticatedScreenRecordingConsentScope()).toMatchObject({
      streams: ['screen_video', 'text_note', 'registered_artifacts'],
      artifacts: {
        video: true,
        video_clip_manifest: true,
      },
      audio: false,
      screen_video: true,
    })
  })

  it('marks invited portal feedback as microphone capture', () => {
    expect(buildPortalFeedbackConsentScope({ surface: 'estimate_portal', domReplay: true })).toMatchObject({
      portal_surface: 'estimate_portal',
      streams: ['audio', 'dom_replay', 'registered_artifacts'],
      artifacts: {
        audio: true,
        transcript: true,
        rrweb: true,
        canvas_geometry: true,
        screen_context: true,
        state_snapshot: true,
      },
      event_classes: ['portal_feedback'],
      audio: true,
      dom_replay: true,
      registered_artifacts: true,
    })
  })
})
