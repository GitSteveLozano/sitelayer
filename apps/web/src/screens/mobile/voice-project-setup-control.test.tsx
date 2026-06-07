import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ProposedProjectFields } from '@/lib/api/voice-project-intent'

// --- Mocks --------------------------------------------------------------
// The feature gate (useAiChatEnabled) is overridden per-test via this mutable
// holder so we can flip the deployment between AI-on and AI-off.
const aiEnabledHolder = { value: undefined as boolean | undefined }
vi.mock('@/lib/api/operator-context-chat', () => ({
  useAiChatEnabled: () => ({ data: aiEnabledHolder.value }),
}))

// The speech hook is mocked so the test can synthesize a final transcript
// without a real (unavailable in jsdom) SpeechRecognition.
const speechHolder = {
  supported: true,
  onFinal: undefined as ((t: string) => void) | undefined,
}
vi.mock('@/lib/use-speech-recognition', () => ({
  useSpeechRecognition: (opts: { onFinal?: (t: string) => void }) => {
    speechHolder.onFinal = opts.onFinal
    return {
      supported: speechHolder.supported,
      listening: false,
      transcript: '',
      error: null,
      start: vi.fn(),
      stop: vi.fn(),
      reset: vi.fn(),
    }
  },
}))

// resolveVoiceProjectIntent is mocked so we never hit the network; it returns
// a fixed proposal so we can assert the confirm-gate hand-off.
const resolveMock = vi.fn<(transcript: string) => Promise<ProposedProjectFields | null>>()
vi.mock('@/lib/api/voice-project-intent', () => ({
  resolveVoiceProjectIntent: (transcript: string) => resolveMock(transcript),
}))

import { VoiceProjectSetupControl } from './voice-project-setup-control'

beforeEach(() => {
  aiEnabledHolder.value = undefined
  speechHolder.supported = true
  speechHolder.onFinal = undefined
  resolveMock.mockReset()
})
afterEach(() => cleanup())

describe('VoiceProjectSetupControl — gating', () => {
  it('renders nothing while ai_chat_enabled is undefined (loading, fail-closed)', () => {
    aiEnabledHolder.value = undefined
    const { container } = render(<VoiceProjectSetupControl onProposed={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when ai_chat_enabled is false (non-AI instance no-op)', () => {
    aiEnabledHolder.value = false
    const { container } = render(<VoiceProjectSetupControl onProposed={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the browser lacks SpeechRecognition', () => {
    aiEnabledHolder.value = true
    speechHolder.supported = false
    const { container } = render(<VoiceProjectSetupControl onProposed={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the mic control when AI is enabled AND speech is supported', () => {
    aiEnabledHolder.value = true
    render(<VoiceProjectSetupControl onProposed={() => {}} />)
    expect(screen.getByTestId('voice-project-setup')).toBeTruthy()
    expect(screen.getByLabelText('Set up by voice')).toBeTruthy()
  })
})

describe('VoiceProjectSetupControl — confirm-gate (proposes, never creates)', () => {
  it('forwards parsed fields to onProposed without creating anything', async () => {
    aiEnabledHolder.value = true
    const proposed: ProposedProjectFields = {
      name: 'Maple Ridge',
      customer: { match: 'new', name: 'Acme' },
      divisions: ['scaffold', 'concrete'],
      division_code: 'D3',
    }
    resolveMock.mockResolvedValue(proposed)
    const onProposed = vi.fn()
    render(<VoiceProjectSetupControl onProposed={onProposed} />)

    // Simulate the speech hook delivering a final transcript.
    expect(speechHolder.onFinal).toBeTypeOf('function')
    speechHolder.onFinal!('new project called Maple Ridge for Acme, scaffold and concrete divisions')

    await waitFor(() => expect(onProposed).toHaveBeenCalledWith(proposed))
    expect(resolveMock).toHaveBeenCalledWith('new project called Maple Ridge for Acme, scaffold and concrete divisions')
    // Confirm-gate copy stays present — the control only fills, never creates.
    expect(screen.getByText(/nothing is created until you tap Create/i)).toBeTruthy()
  })

  it('surfaces a calm notice when the parse yields nothing (and never calls onProposed)', async () => {
    aiEnabledHolder.value = true
    resolveMock.mockResolvedValue(null)
    const onProposed = vi.fn()
    render(<VoiceProjectSetupControl onProposed={onProposed} />)

    speechHolder.onFinal!('mmm uh')
    await waitFor(() => expect(screen.getByText(/Could not turn that into project fields/i)).toBeTruthy())
    expect(onProposed).not.toHaveBeenCalled()
  })
})
