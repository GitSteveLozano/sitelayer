import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// Mock the capture mutation hook so the panel can be exercised without a
// QueryClient / network. `mutate` is a spy we assert on.
const mutate = vi.fn()
vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return { ...actual, useCaptureTakeoffDraft: () => ({ mutate, isPending: false }) }
})

import { CapturePanel } from './capture-panel'

afterEach(cleanup)
beforeEach(() => mutate.mockClear())

describe('CapturePanel', () => {
  it('renders the three scan pipelines + the dry-run blueprint button', () => {
    render(<CapturePanel projectId="p-1" onCaptured={() => {}} />)
    expect(screen.getByText('Capture / import scan')).toBeTruthy()
    expect(screen.getByText('RoomPlan JSON…')).toBeTruthy()
    expect(screen.getByText('Photogrammetry…')).toBeTruthy()
    expect(screen.getByText('Drone sidecar…')).toBeTruthy()
    expect(screen.getByText('Blueprint (dry-run)')).toBeTruthy()
  })

  it('dispatches a dry-run blueprint capture with the known dimension', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('30')
    render(<CapturePanel projectId="p-1" onCaptured={() => {}} />)
    fireEvent.click(screen.getByText('Blueprint (dry-run)'))
    expect(mutate).toHaveBeenCalledTimes(1)
    const [body] = mutate.mock.calls[0]
    expect(body.kind).toBe('blueprint_vision')
    expect(body.payload).toMatchObject({ dryRun: true, knownDimensionFt: 30 })
  })

  it('reads a RoomPlan JSON file and dispatches the roomplan pipeline', async () => {
    render(<CapturePanel projectId="p-1" onCaptured={() => {}} />)
    const input = screen
      .getByText('RoomPlan JSON…')
      .closest('label')!
      .querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['{"walls":[]}'], 'room.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [file] } })
    // FileReader.onload is async; wait a tick.
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    const [body] = mutate.mock.calls[0]
    expect(body.kind).toBe('roomplan')
    expect(body.payload).toHaveProperty('capturedRoomJson')
  })
})
