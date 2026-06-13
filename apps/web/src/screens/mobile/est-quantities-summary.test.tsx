import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * Quantities-summary render tests (design msg__30, audit M05 #13).
 *
 * Honesty invariants under test:
 *   - the TOTAL LINE ITEMS hero counts the REAL estimate lines;
 *   - the sheet-verification line states exactly what the blueprint pages
 *     say (all verified vs N to review vs no blueprint) — no fabricated
 *     "ALL VERIFIED" over missing data;
 *   - the empty state offers a recompute, and GENERATE PDF stays disabled
 *     until priced lines exist.
 */

const mocks = vi.hoisted(() => ({
  useEstimateBuilder: vi.fn(),
  useProjectBlueprints: vi.fn(),
  useBlueprintPages: vi.fn(),
  apiGet: vi.fn(),
}))

vi.mock('@/machines/estimate-builder', () => ({ useEstimateBuilder: mocks.useEstimateBuilder }))
vi.mock('../../lib/api/takeoff.js', () => ({
  useProjectBlueprints: mocks.useProjectBlueprints,
  useBlueprintPages: mocks.useBlueprintPages,
}))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, apiGet: mocks.apiGet, getActiveCompanySlug: () => 'acme' }
})

import { MobileEstQuantitiesSummary } from './est-quantities-summary'

function builderState(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: null,
    pendingEdits: {},
    lines: [],
    error: null,
    conflict: false,
    isLoading: false,
    isSaving: false,
    isRecomputing: false,
    hasDirtyEdits: false,
    refresh: vi.fn(),
    editLine: vi.fn(),
    save: vi.fn(),
    recompute: vi.fn(),
    dismissError: vi.fn(),
    ...overrides,
  }
}

const LINE = {
  id: 'l1',
  service_item_code: 'EPS-BOARD-2',
  quantity: '4785',
  unit: 'SF',
  rate: '1',
  amount: '4785',
  division_code: null,
  created_at: '2026-06-12T00:00:00Z',
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pg1',
    blueprint_document_id: 'doc1',
    page_number: 1,
    storage_path: null,
    calibration_world_distance: null,
    calibration_world_unit: null,
    calibration_x1: null,
    calibration_y1: null,
    calibration_x2: null,
    calibration_y2: null,
    calibration_set_at: null,
    scale_verified_at: null,
    scale_verified_by: null,
    measurement_count: 0,
    ...overrides,
  }
}

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1/quantities']}>
      <Routes>
        <Route path="/projects/:projectId/quantities" element={<MobileEstQuantitiesSummary companySlug="acme" />} />
        <Route path="/projects/:projectId/estimate/pdf" element={<div>PDF-DELIVERABLE-SCREEN</div>} />
        <Route path="/projects/:projectId/estimate" element={<div>PRICE-SEND-SCREEN</div>} />
        <Route path="/projects/:projectId/takeoff-ai/autoscale" element={<div>AUTOSCALE-SCREEN</div>} />
        <Route path="/projects/:projectId/takeoff-mobile" element={<div>CANVAS-SCREEN</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  // The summary fetch stays pending by default — the screen must not need it.
  mocks.apiGet.mockReturnValue(new Promise(() => {}))
  mocks.useEstimateBuilder.mockReturnValue(builderState())
  mocks.useProjectBlueprints.mockReturnValue({ data: { blueprints: [] }, isLoading: false })
  mocks.useBlueprintPages.mockReturnValue({ data: undefined, isLoading: false })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MobileEstQuantitiesSummary', () => {
  it('counts the real estimate lines in the hero and reports all-verified sheets', () => {
    mocks.useEstimateBuilder.mockReturnValue(
      builderState({ lines: [LINE, { ...LINE, id: 'l2', service_item_code: 'BASECOAT-POLY' }] }),
    )
    mocks.useProjectBlueprints.mockReturnValue({
      data: { blueprints: [{ id: 'doc1', deleted_at: null }] },
      isLoading: false,
    })
    mocks.useBlueprintPages.mockReturnValue({
      data: {
        pages: [
          page({ id: 'pg1', scale_verified_at: '2026-06-12T00:00:00Z' }),
          page({ id: 'pg2', page_number: 2, calibration_set_at: '2026-06-12T00:00:00Z' }),
        ],
      },
      isLoading: false,
    })
    renderScreen()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText(/2 SHEETS · ALL VERIFIED ✓ · READY FOR ESTIMATE/)).toBeTruthy()
    expect(screen.getByText('EPS-BOARD-2')).toBeTruthy()
    // Both fixture lines carry the same real quantity.
    expect(screen.getAllByText('4,785')).toHaveLength(2)
  })

  it('routes unverified sheets to the autoscale verify screen instead of claiming readiness', () => {
    mocks.useEstimateBuilder.mockReturnValue(builderState({ lines: [LINE] }))
    mocks.useProjectBlueprints.mockReturnValue({
      data: { blueprints: [{ id: 'doc1', deleted_at: null }] },
      isLoading: false,
    })
    mocks.useBlueprintPages.mockReturnValue({
      data: { pages: [page({ scale_verified_at: '2026-06-12T00:00:00Z' }), page({ id: 'pg2', page_number: 2 })] },
      isLoading: false,
    })
    renderScreen()
    const verifyLink = screen.getByText(/2 SHEETS · 1 VERIFIED · 1 TO REVIEW/)
    fireEvent.click(verifyLink)
    expect(screen.getByText('AUTOSCALE-SCREEN')).toBeTruthy()
  })

  it('is honest about a missing blueprint', () => {
    renderScreen()
    expect(screen.getByText('NO BLUEPRINT ON THIS PROJECT')).toBeTruthy()
  })

  it('disables GENERATE PDF and offers a recompute when there are no priced lines', () => {
    const recompute = vi.fn()
    mocks.useEstimateBuilder.mockReturnValue(builderState({ recompute }))
    renderScreen()
    expect(screen.getByText(/No line items yet/)).toBeTruthy()
    const generate = screen.getByRole('button', { name: 'Generate PDF' }) as HTMLButtonElement
    expect(generate.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Recompute estimate' }))
    expect(recompute).toHaveBeenCalled()
  })

  it('GENERATE PDF opens the deliverable and the continue CTA opens pricing', () => {
    mocks.useEstimateBuilder.mockReturnValue(builderState({ lines: [LINE] }))
    renderScreen()
    fireEvent.click(screen.getByRole('button', { name: 'Generate PDF' }))
    expect(screen.getByText('PDF-DELIVERABLE-SCREEN')).toBeTruthy()
  })

  it('continue-to-pricing forwards to Price&Send', () => {
    mocks.useEstimateBuilder.mockReturnValue(builderState({ lines: [LINE] }))
    renderScreen()
    fireEvent.click(screen.getByRole('button', { name: 'Continue to pricing →' }))
    expect(screen.getByText('PRICE-SEND-SCREEN')).toBeTruthy()
  })
})
