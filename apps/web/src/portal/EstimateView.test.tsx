import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCaptureStateProvidersForTests,
  uploadRegisteredCaptureStateSnapshots,
} from '@/lib/capture-state-providers'
import type { CaptureArtifactUploadInput, CaptureArtifactUploadResponse } from '@/lib/api/capture-sessions'
import type { PortalEstimateView } from './api'
import { EstimateView } from './EstimateView'

const signature = vi.hoisted(() => ({
  usePortalEstimateSignature: vi.fn(),
}))

vi.mock('@/machines/portal-estimate-signature', () => signature)

const issueReporter = vi.hoisted(() => ({
  IssueReporter: vi.fn(() => null),
}))

vi.mock('./IssueReporter', () => issueReporter)

const view: PortalEstimateView = {
  id: 'estimate-share-1',
  project_name: 'Private Project Name',
  company_name: 'LA Ops',
  recipient_email: 'private@example.test',
  recipient_name: 'Private Recipient',
  sent_at: '2026-06-04T12:00:00.000Z',
  expires_at: '2026-06-18T12:00:00.000Z',
  status: 'pending',
  estimate: {
    bid_total: 1234,
    scope_total: 1200,
    captured_at: '2026-06-04T11:58:00.000Z',
    lines: [
      {
        service_item_code: 'LABOR',
        quantity: 2,
        unit: 'hr',
        rate: 100,
        amount: 200,
        division_code: '01',
      },
    ],
  },
  accepted_at: null,
  declined_at: null,
  decline_reason: 'Private decline reason',
  signer_name: null,
}

describe('EstimateView capture state', () => {
  beforeEach(() => {
    __resetCaptureStateProvidersForTests()
    signature.usePortalEstimateSignature.mockReturnValue({
      view,
      loadError: null,
      submitError: 'Private submit error',
      mode: 'idle',
      signerName: 'Private Signer',
      signature: 'data:image/png;base64,private-signature',
      declineReason: 'confidential reason text',
      isLoading: false,
      isSubmittingAccept: false,
      isSubmittingDecline: false,
      isSubmitting: false,
      shouldRedirectAccepted: false,
      startAccept: vi.fn(),
      startDecline: vi.fn(),
      cancel: vi.fn(),
      setSignerName: vi.fn(),
      setSignature: vi.fn(),
      setDeclineReason: vi.fn(),
      submitAccept: vi.fn(),
      submitDecline: vi.fn(),
      dismissError: vi.fn(),
      acceptValidationMessage: null,
      declineValidationMessage: null,
    })
  })

  afterEach(() => {
    __resetCaptureStateProvidersForTests()
    vi.clearAllMocks()
  })

  it('registers redacted estimate review state for public feedback capture', async () => {
    render(
      <MemoryRouter initialEntries={['/portal/estimates/share-token?capture_invite=invite-1']}>
        <Routes>
          <Route path="/portal/estimates/:shareToken" element={<EstimateView />} />
        </Routes>
      </MemoryRouter>,
    )

    const upload = vi.fn(async (_captureSessionId: string, _input: CaptureArtifactUploadInput) => ({
      artifact: {
        id: 'artifact-1',
        kind: 'state_snapshot',
        storage_key: 'capture/state.json',
        content_type: 'application/json',
        byte_size: 10,
        content_hash: 'sha256:test',
        redaction_version: 'capture-session-v1',
      },
    })) satisfies (
      captureSessionId: string,
      input: CaptureArtifactUploadInput,
    ) => Promise<CaptureArtifactUploadResponse>

    await uploadRegisteredCaptureStateSnapshots('capture-1', {
      reason: 'recording_stopped',
      metadata: {
        surface: 'portal_feedback',
        trigger: 'portal_feedback_stop',
      },
      upload,
    })

    expect(signature.usePortalEstimateSignature).toHaveBeenCalledWith('share-token')
    expect(issueReporter.IssueReporter).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'estimate_portal', shareToken: 'share-token' }),
      undefined,
    )
    expect(upload).toHaveBeenCalledWith(
      'capture-1',
      expect.objectContaining({
        kind: 'state_snapshot',
        fileName: 'portal-estimate-state_snapshot.json',
        pii_level: 'internal',
        access_policy: 'support_only',
        metadata: expect.objectContaining({
          source: 'capture_state_provider',
          artifact_type: 'capture.state_snapshot',
          provider_id: 'portal:estimate',
          reason: 'recording_stopped',
          schema: 'sitelayer.portal.estimate-state.v1',
          portal_surface: 'estimate_portal',
          route_template: '/portal/estimates/:shareToken',
          trigger: 'portal_feedback_stop',
        }),
      }),
    )

    const input = upload.mock.calls[0]?.[1] as CaptureArtifactUploadInput
    const body = JSON.parse(await input.file.text()) as Record<string, unknown>
    expect(body).toMatchObject({
      artifact_type: 'capture.state_snapshot',
      provider_id: 'portal:estimate',
      reason: 'recording_stopped',
      schema: 'sitelayer.portal.estimate-state.v1',
      payload: {
        surface: 'estimate_portal',
        route_template: '/portal/estimates/:shareToken',
        share_token_present: true,
        is_loading: false,
        mode: 'idle',
        submit_error_present: true,
        draft: {
          signer_name_length: 14,
          signature_present: true,
          decline_reason_length: 24,
        },
        estimate: {
          id: 'estimate-share-1',
          status: 'pending',
          has_recipient: true,
          bid_total: 1234,
          scope_total: 1200,
          line_count: 1,
          lines: [
            {
              service_item_code: 'LABOR',
              quantity: 2,
              unit: 'hr',
              division_code: '01',
              amount: 200,
            },
          ],
        },
      },
    })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('Private Project Name')
    expect(serialized).not.toContain('private@example.test')
    expect(serialized).not.toContain('Private Recipient')
    expect(serialized).not.toContain('Private Signer')
    expect(serialized).not.toContain('data:image/png')
    expect(serialized).not.toContain('confidential reason text')
    expect(serialized).not.toContain('Private decline reason')
    expect(serialized).not.toContain('Private submit error')
    expect(serialized).not.toContain('share-token')
  })
})
