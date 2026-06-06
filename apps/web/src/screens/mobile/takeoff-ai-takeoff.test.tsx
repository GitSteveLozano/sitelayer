import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * AI auto-takeoff SETUP float: the "ADD TARGET" control is an HONEST disabled
 * affordance, not a silent no-op. Custom symbol→item targets have no backend
 * yet (the capture endpoint reads every detected symbol and ignores per-target
 * selection — the GAP on `useTakeoffSetup`), so the button must be visibly
 * disabled rather than appearing clickable.
 */

const mocks = vi.hoisted(() => ({
  useCaptureTakeoffDraft: vi.fn(),
  useCaptureBlueprintVisionLive: vi.fn(),
  useBlueprintVisionLiveAvailable: vi.fn(),
  useProjectBlueprints: vi.fn(),
}))

vi.mock('../../lib/api/takeoff-drafts.js', () => ({
  fetchBlueprintFile: vi.fn(),
  useBlueprintVisionLiveAvailable: mocks.useBlueprintVisionLiveAvailable,
  useCaptureBlueprintVisionLive: mocks.useCaptureBlueprintVisionLive,
  useCaptureTakeoffDraft: mocks.useCaptureTakeoffDraft,
}))
vi.mock('../../lib/api/takeoff.js', () => ({ useProjectBlueprints: mocks.useProjectBlueprints }))

import { EstAiTakeoffSetupPanel } from './takeoff-ai-takeoff'

mocks.useCaptureTakeoffDraft.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null })
mocks.useCaptureBlueprintVisionLive.mockReturnValue({ mutateAsync: vi.fn(), isPending: false, error: null })
mocks.useBlueprintVisionLiveAvailable.mockReturnValue({ data: false })
mocks.useProjectBlueprints.mockReturnValue({ data: { blueprints: [] } })

afterEach(cleanup)

describe('AI auto-takeoff SETUP — ADD TARGET affordance', () => {
  it('renders ADD TARGET as a disabled, non-clickable control with a reason', () => {
    render(
      <MemoryRouter>
        <EstAiTakeoffSetupPanel projectId="p1" onClose={() => {}} onReviewDraft={() => {}} />
      </MemoryRouter>,
    )
    const btn = screen.getByText(/ADD TARGET/i).closest('button')
    expect(btn).toBeTruthy()
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect(btn?.getAttribute('title') ?? '').toMatch(/coming soon/i)
  })
})
