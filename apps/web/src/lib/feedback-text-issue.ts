import type { CaptureSessionCreateInput } from './api/capture-sessions'
import { buildAuthenticatedTextIssueConsentScope } from './capture-policy'

export type TextIssueCaptureProfile = 'text_issue_prewarm' | 'text_issue' | (string & {})

export type TextIssueCaptureInputArgs = {
  captureSessionId: string
  companySlug: string
  captureProfile: TextIssueCaptureProfile
  collabMode?: string | null
  routePath: string
  deviceKind: string
  platform: string
  viewport: string
  consentVersion: string
}

export function buildTextIssueMetadata(
  companySlug: string,
  captureProfile: TextIssueCaptureProfile,
  collabMode: string | null = null,
): Record<string, unknown> {
  return {
    surface: 'authenticated_app',
    company_slug: companySlug,
    capture_profile: captureProfile,
    ...(collabMode ? { collab_mode: collabMode } : {}),
  }
}

export function buildTextIssueConsentScope(): Record<string, unknown> {
  return buildAuthenticatedTextIssueConsentScope()
}

export function buildTextIssueCaptureSessionInput(args: TextIssueCaptureInputArgs): CaptureSessionCreateInput {
  return {
    capture_session_id: args.captureSessionId,
    mode: 'feedback',
    consent_version: args.consentVersion,
    route_path: args.routePath,
    device_kind: args.deviceKind,
    platform: args.platform,
    viewport: args.viewport,
    metadata: buildTextIssueMetadata(args.companySlug, args.captureProfile, args.collabMode ?? null),
    consent_scope: buildTextIssueConsentScope(),
  }
}
