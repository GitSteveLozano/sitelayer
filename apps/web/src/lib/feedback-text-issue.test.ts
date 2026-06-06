import { describe, expect, it } from 'vitest'
import {
  buildTextIssueCaptureSessionInput,
  buildTextIssueConsentScope,
  buildTextIssueMetadata,
} from './feedback-text-issue'

describe('feedback text issue capture helpers', () => {
  it('builds the shared no-plugin text issue consent scope', () => {
    expect(buildTextIssueConsentScope()).toEqual({
      surface: 'authenticated_app',
      streams: ['text_note', 'registered_artifacts'],
      artifacts: {
        canvas_geometry: true,
        screen_context: true,
        state_snapshot: true,
        text_note: true,
      },
      event_classes: ['authenticated_feedback'],
      audio: false,
      dom_replay: false,
      registered_artifacts: true,
      screen_video: false,
      text_note: true,
    })
  })

  it('builds metadata with optional collaborator mode', () => {
    expect(buildTextIssueMetadata('e2e-fixtures', 'text_issue_prewarm', 'steve')).toEqual({
      surface: 'authenticated_app',
      company_slug: 'e2e-fixtures',
      capture_profile: 'text_issue_prewarm',
      collab_mode: 'steve',
    })

    expect(buildTextIssueMetadata('e2e-fixtures', 'text_issue')).toEqual({
      surface: 'authenticated_app',
      company_slug: 'e2e-fixtures',
      capture_profile: 'text_issue',
    })
  })

  it('builds the capture session upsert payload', () => {
    expect(
      buildTextIssueCaptureSessionInput({
        captureSessionId: '00000000-0000-4000-8000-000000000123',
        companySlug: 'e2e-fixtures',
        captureProfile: 'text_issue',
        collabMode: 'steve',
        routePath: '/m-preview',
        deviceKind: 'desktop',
        platform: 'Mozilla test',
        viewport: '1280x900',
        consentVersion: 'authenticated-feedback-v1',
      }),
    ).toEqual({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      mode: 'feedback',
      consent_version: 'authenticated-feedback-v1',
      route_path: '/m-preview',
      device_kind: 'desktop',
      platform: 'Mozilla test',
      viewport: '1280x900',
      metadata: {
        surface: 'authenticated_app',
        company_slug: 'e2e-fixtures',
        capture_profile: 'text_issue',
        collab_mode: 'steve',
      },
      consent_scope: {
        surface: 'authenticated_app',
        streams: ['text_note', 'registered_artifacts'],
        artifacts: {
          canvas_geometry: true,
          screen_context: true,
          state_snapshot: true,
          text_note: true,
        },
        event_classes: ['authenticated_feedback'],
        audio: false,
        dom_replay: false,
        registered_artifacts: true,
        screen_video: false,
        text_note: true,
      },
    })
  })
})
