import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * Tests for `CrewQuickActions` — the per-worker action sheet that the
 * foreman opens with a long-press on a crew row. The interesting paths
 * are the "compose message" sub-flow added in the worker-message slice:
 *
 *   menu  →click "Send message"→  compose
 *   compose  →send success→  sent
 *   compose  →send 422 error→  compose + rewritten banner
 *
 * The send mutation hook (`useSendWorkerMessage`) is mocked so the
 * sheet's state transitions can be exercised without a real network
 * call. Other branches (menu navigation, close handler) are exercised
 * incidentally.
 */

// We mock the workers API module before importing the component so the
// component picks up the mocked `useSendWorkerMessage`.
const mutateAsyncMock = vi.fn<(input: { workerId: string; input: { body: string } }) => Promise<unknown>>()
const useSendWorkerMessageState: {
  isPending: boolean
  error: Error | null
} = { isPending: false, error: null }

vi.mock('../../lib/api/workers', () => ({
  useSendWorkerMessage: () => ({
    mutateAsync: mutateAsyncMock,
    isPending: useSendWorkerMessageState.isPending,
    error: useSendWorkerMessageState.error,
  }),
}))

import { CrewQuickActions } from './foreman-crew'

afterEach(() => {
  cleanup()
  mutateAsyncMock.mockReset()
  useSendWorkerMessageState.isPending = false
  useSendWorkerMessageState.error = null
})

const baseWorker = {
  id: 'w-1',
  name: 'Alex Mason',
  role: 'crew' as const,
  version: 1,
  deleted_at: null,
  created_at: '2026-05-01T00:00:00.000Z',
}

function renderSheet(overrides: Partial<Parameters<typeof CrewQuickActions>[0]> = {}) {
  const onClose = vi.fn()
  const onAdjustHours = vi.fn()
  render(<CrewQuickActions worker={baseWorker} onClose={onClose} onAdjustHours={onAdjustHours} {...overrides} />)
  return { onClose, onAdjustHours }
}

describe('CrewQuickActions', () => {
  it('starts in menu mode with the worker name and the action buttons', () => {
    renderSheet()
    expect(screen.getByText('Alex Mason')).toBeTruthy()
    expect(screen.getByText('Send message')).toBeTruthy()
    expect(screen.getByText('Adjust hours')).toBeTruthy()
  })

  it('switches to compose mode when "Send message" is tapped', () => {
    renderSheet()
    fireEvent.click(screen.getByText('Send message'))
    expect(screen.getByPlaceholderText('Message to Alex Mason…')).toBeTruthy()
    expect(screen.getByText('Send')).toBeTruthy()
    expect(screen.getByText('Back')).toBeTruthy()
  })

  it('disables Send until the body has non-whitespace content', () => {
    renderSheet()
    fireEvent.click(screen.getByText('Send message'))
    const sendButton = screen.getByText('Send') as HTMLButtonElement
    expect(sendButton.disabled).toBe(true)
    const textarea = screen.getByPlaceholderText('Message to Alex Mason…') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '   ' } })
    expect(sendButton.disabled).toBe(true)
    fireEvent.change(textarea, { target: { value: 'Bring extras' } })
    expect(sendButton.disabled).toBe(false)
  })

  it('calls the mutation with the trimmed body and transitions to sent on success', async () => {
    mutateAsyncMock.mockResolvedValueOnce({ notification_id: 'n-1', recipient_clerk_user_id: 'user_w' })
    renderSheet()
    fireEvent.click(screen.getByText('Send message'))
    fireEvent.change(screen.getByPlaceholderText('Message to Alex Mason…'), {
      target: { value: '  Heads up at 3pm  ' },
    })
    fireEvent.click(screen.getByText('Send'))
    expect(mutateAsyncMock).toHaveBeenCalledWith({ workerId: 'w-1', input: { body: 'Heads up at 3pm' } })
    // `findByText` polls until the resolved mutation propagates through
    // the awaited setMode('sent'); manual microtask flushes aren't
    // reliable across React's batched updates.
    expect(await screen.findByText('Message sent')).toBeTruthy()
  })

  it('rewrites a 422 error into onboarding guidance', async () => {
    useSendWorkerMessageState.error = new Error('422 worker has no associated user account yet')
    mutateAsyncMock.mockRejectedValueOnce(new Error('422 worker has no associated user account yet'))
    renderSheet()
    fireEvent.click(screen.getByText('Send message'))
    fireEvent.change(screen.getByPlaceholderText('Message to Alex Mason…'), { target: { value: 'Hi' } })
    fireEvent.click(screen.getByText('Send'))
    expect(await screen.findByText(/hasn't signed in to the app yet/i)).toBeTruthy()
    // The compose textarea is still visible — user stays in compose mode.
    expect(screen.getByPlaceholderText('Message to Alex Mason…')).toBeTruthy()
  })

  it('shows the raw server message for non-422 errors', () => {
    useSendWorkerMessageState.error = new Error('500 internal')
    renderSheet()
    fireEvent.click(screen.getByText('Send message'))
    expect(screen.getByText(/500 internal/)).toBeTruthy()
  })

  it('returns to menu when "Back" is tapped from compose', () => {
    renderSheet()
    fireEvent.click(screen.getByText('Send message'))
    fireEvent.click(screen.getByText('Back'))
    expect(screen.getByText('Send message')).toBeTruthy()
    expect(screen.getByText('Adjust hours')).toBeTruthy()
  })
})
