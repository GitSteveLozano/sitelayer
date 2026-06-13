import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * PDF-deliverable render tests (design msg__32, audit M05 #14).
 *
 * Honesty invariants under test:
 *   - the preview is the REAL generated estimate PDF (authenticated blob →
 *     iframe), never the desktop modal's mock page;
 *   - mode selection maps onto the real ?report= kinds the API serves;
 *   - generating/failure states are explicit, with a retry;
 *   - DOWNLOAD is disabled until a real blob exists, and SEND TO CLIENT
 *     opens the shared estimate-share sheet (single-sourced chain).
 */

const mocks = vi.hoisted(() => ({
  useScopeVsBid: vi.fn(),
  useAuthenticatedObjectUrl: vi.fn(),
  useCustomers: vi.fn(),
  createEstimateShare: vi.fn(),
  apiGet: vi.fn(),
}))

vi.mock('../../lib/api/estimate.js', async (importOriginal) => {
  // Keep estimateReportPath REAL — the path the preview fetches is part of
  // what's under test — and mock only the data hook.
  const actual = await importOriginal<typeof import('../../lib/api/estimate.js')>()
  return { ...actual, useScopeVsBid: mocks.useScopeVsBid }
})
vi.mock('../../lib/api/blob-url.js', () => ({ useAuthenticatedObjectUrl: mocks.useAuthenticatedObjectUrl }))
vi.mock('@/lib/api/customers', () => ({ useCustomers: mocks.useCustomers }))
vi.mock('../../lib/api/estimate-shares.js', () => ({ createEstimateShare: mocks.createEstimateShare }))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, apiGet: mocks.apiGet, getActiveCompanySlug: () => 'acme' }
})
// Stub the shared send sheet — its own behavior is covered by the
// estimate-review screen; here we only assert the deliverable opens it.
vi.mock('./estimate-review.js', () => ({
  SendToClientSheet: () => <div>SEND-TO-CLIENT-SHEET</div>,
  slugifyFile: (name: string) =>
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'estimate',
}))

import { MobileEstPdfDeliverable } from './est-pdf-deliverable'

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

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1/estimate/pdf']}>
      <Routes>
        <Route path="/projects/:projectId/estimate/pdf" element={<MobileEstPdfDeliverable companySlug="acme" />} />
        <Route path="/projects/:projectId/quantities" element={<div>QUANTITIES-SCREEN</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mocks.apiGet.mockReturnValue(new Promise(() => {}))
  mocks.useScopeVsBid.mockReturnValue({ data: { lines: [LINE] }, isLoading: false })
  mocks.useAuthenticatedObjectUrl.mockReturnValue({ url: null, loading: true, error: null })
  mocks.useCustomers.mockReturnValue({ data: { customers: [] } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MobileEstPdfDeliverable', () => {
  it('shows an honest generating state and disables DOWNLOAD until the blob exists', () => {
    renderScreen()
    expect(screen.getByText('Generating preview…')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders the real PDF blob in an iframe and enables DOWNLOAD', () => {
    mocks.useAuthenticatedObjectUrl.mockReturnValue({ url: 'blob:pdf-1', loading: false, error: null })
    renderScreen()
    const frame = screen.getByTitle(/PDF preview/) as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe('blob:pdf-1')
    expect((screen.getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('fetches the customer proposal by default and switches to the real ?report= kind on mode tap', () => {
    mocks.useAuthenticatedObjectUrl.mockReturnValue({ url: 'blob:pdf-1', loading: false, error: null })
    renderScreen()
    expect(mocks.useAuthenticatedObjectUrl).toHaveBeenLastCalledWith('/api/projects/p1/estimate.pdf?report=customer')
    fireEvent.click(screen.getByRole('button', { name: 'RFQ' }))
    expect(mocks.useAuthenticatedObjectUrl).toHaveBeenLastCalledWith('/api/projects/p1/estimate.pdf?report=rfq')
    fireEvent.click(screen.getByRole('button', { name: 'INTERNAL' }))
    expect(mocks.useAuthenticatedObjectUrl).toHaveBeenLastCalledWith('/api/projects/p1/estimate.pdf')
  })

  it('surfaces a generation failure honestly and retries with a cache-busted fetch', () => {
    mocks.useAuthenticatedObjectUrl.mockReturnValue({ url: null, loading: false, error: new Error('render failed') })
    renderScreen()
    expect(screen.getByText('Could not generate the PDF')).toBeTruthy()
    expect(screen.getByText('render failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(mocks.useAuthenticatedObjectUrl).toHaveBeenLastCalledWith(
      '/api/projects/p1/estimate.pdf?report=customer&retry=1',
    )
  })

  it('is honest when there is no priced estimate — nothing fetched, send disabled', () => {
    mocks.useScopeVsBid.mockReturnValue({ data: { lines: [] }, isLoading: false })
    renderScreen()
    expect(screen.getByText(/No priced line items yet/)).toBeTruthy()
    expect(mocks.useAuthenticatedObjectUrl).toHaveBeenLastCalledWith(null)
    expect((screen.getByRole('button', { name: 'Send to client' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('SEND TO CLIENT opens the shared estimate-share sheet', () => {
    mocks.useAuthenticatedObjectUrl.mockReturnValue({ url: 'blob:pdf-1', loading: false, error: null })
    renderScreen()
    fireEvent.click(screen.getByRole('button', { name: 'Send to client' }))
    expect(screen.getByText('SEND-TO-CLIENT-SHEET')).toBeTruthy()
  })
})
