import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCaptureStateProvidersForTests,
  uploadRegisteredCaptureStateSnapshots,
} from '@/lib/capture-state-providers'
import type { CaptureArtifactUploadInput, CaptureArtifactUploadResponse } from '@/lib/api/capture-sessions'
import { RentalsPortalProvider } from './RentalsPortalProvider'

const rentals = vi.hoisted(() => ({
  useRentalsPortal: vi.fn(),
}))

vi.mock('@/machines/rentals-portal', () => rentals)

const issueReporter = vi.hoisted(() => ({
  IssueReporter: vi.fn(() => null),
}))

vi.mock('./IssueReporter', () => issueReporter)

describe('RentalsPortalProvider capture state', () => {
  beforeEach(() => {
    __resetCaptureStateProvidersForTests()
    rentals.useRentalsPortal.mockReturnValue({
      items: [
        {
          id: 'item-1',
          code: 'SCAFF-10',
          description: '10 ft scaffold',
          category: 'Scaffold',
          unit: 'ea',
          default_rental_rate: '12.00',
          replacement_value: '100.00',
        },
      ],
      error: null,
      isLoading: false,
      query: 'scaff',
      category: 'Scaffold',
      categories: ['All', 'Scaffold'],
      filtered: [
        {
          id: 'item-1',
          code: 'SCAFF-10',
          description: '10 ft scaffold',
          category: 'Scaffold',
          unit: 'ea',
          default_rental_rate: '12.00',
          replacement_value: '100.00',
        },
      ],
      cart: [
        {
          inventory_item_id: 'item-1',
          qty: 2,
          start: '2026-06-05',
          end: '2026-06-07',
          delivery: 'delivery',
        },
      ],
      contact: {
        name: 'Private Customer',
        email: 'private@example.test',
        phone: '555-0100',
        notes: 'do not capture this note',
      },
      range: { start: '2026-06-05', end: '2026-06-07' },
      requestId: 'rental-request-1',
      reserveError: 'Reserve failed',
      isReserving: false,
      isReserved: false,
      setQuery: vi.fn(),
      setCategory: vi.fn(),
      addToCart: vi.fn(),
      updateLine: vi.fn(),
      removeLine: vi.fn(),
      setContact: vi.fn(),
      clearCart: vi.fn(),
      openCart: vi.fn(),
      backToBrowse: vi.fn(),
      reserve: vi.fn(),
      reload: vi.fn(),
    })
  })

  afterEach(() => {
    __resetCaptureStateProvidersForTests()
    vi.clearAllMocks()
  })

  it('registers redacted rental portal machine state for public feedback capture', async () => {
    render(
      <MemoryRouter initialEntries={['/portal/rentals/share-token/cart?capture_invite=invite-1']}>
        <Routes>
          <Route
            path="/portal/rentals/:shareToken/cart"
            element={
              <RentalsPortalProvider>
                <div>Cart</div>
              </RentalsPortalProvider>
            }
          />
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

    expect(rentals.useRentalsPortal).toHaveBeenCalledWith('share-token')
    expect(issueReporter.IssueReporter).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'rental_portal', shareToken: 'share-token' }),
      undefined,
    )
    expect(upload).toHaveBeenCalledWith(
      'capture-1',
      expect.objectContaining({
        kind: 'state_snapshot',
        fileName: 'portal-rentals-state_snapshot.json',
        pii_level: 'internal',
        access_policy: 'support_only',
        metadata: expect.objectContaining({
          source: 'capture_state_provider',
          artifact_type: 'capture.state_snapshot',
          provider_id: 'portal:rentals',
          reason: 'recording_stopped',
          schema: 'sitelayer.portal.rentals-state.v1',
          portal_surface: 'rental_portal',
          route_template: '/portal/rentals/:shareToken',
          trigger: 'portal_feedback_stop',
        }),
      }),
    )

    const input = upload.mock.calls[0]?.[1] as CaptureArtifactUploadInput
    const body = JSON.parse(await input.file.text()) as Record<string, unknown>
    expect(body).toMatchObject({
      artifact_type: 'capture.state_snapshot',
      provider_id: 'portal:rentals',
      reason: 'recording_stopped',
      schema: 'sitelayer.portal.rentals-state.v1',
      payload: {
        surface: 'rental_portal',
        route_template: '/portal/rentals/:shareToken',
        share_token_present: true,
        query: 'scaff',
        category: 'Scaffold',
        catalog: {
          item_count: 1,
          filtered_count: 1,
          category_count: 2,
        },
        cart: {
          line_count: 1,
          range: { start: '2026-06-05', end: '2026-06-07' },
          truncated: false,
          lines: [
            {
              inventory_item_id: 'item-1',
              item_code: 'SCAFF-10',
              item_category: 'Scaffold',
              unit: 'ea',
              qty: 2,
              start: '2026-06-05',
              end: '2026-06-07',
              delivery: 'delivery',
            },
          ],
        },
        reservation: {
          request_id: 'rental-request-1',
          is_reserving: false,
          is_reserved: false,
          has_error: true,
          error_message: 'Reserve failed',
        },
      },
    })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('Private Customer')
    expect(serialized).not.toContain('private@example.test')
    expect(serialized).not.toContain('555-0100')
    expect(serialized).not.toContain('do not capture this note')
    expect(serialized).not.toContain('share-token')
  })
})
