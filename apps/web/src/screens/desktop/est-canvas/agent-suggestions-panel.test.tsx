import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TakeoffDraft } from '@/lib/api'

const promoteMutate = vi.fn()
const draftResult = {
  data: {
    pipeline_version: '1.0',
    takeoff_result: {
      producedAt: new Date().toISOString(),
      quantities: [
        {
          id: 'q-high',
          description: 'North wall area',
          unit: 'sqft',
          value: 240.5,
          confidence: 0.92,
          masterformatCode: '07 46 00',
        },
        {
          id: 'q-low',
          description: 'Maybe trim',
          unit: 'lf',
          value: 12,
          confidence: 0.4,
          masterformatCode: '06 20 00',
        },
      ],
    },
  },
  isLoading: false,
  isError: false,
}

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    useTakeoffDraftResult: () => draftResult,
    usePromoteCapturedQuantities: () => ({ mutate: promoteMutate, isPending: false }),
  }
})
vi.mock('@/components/ai', async (importActual) => {
  const actual = await importActual<typeof import('@/components/ai')>()
  return { ...actual, useRejectSheet: () => [null, vi.fn(async () => null)] }
})

import { AgentSuggestionsPanel } from './agent-suggestions-panel'

const DRAFT = {
  id: 'd-1',
  source: 'blueprint_vision',
  created_at: new Date().toISOString(),
  pipeline_version: '1.0',
} as unknown as TakeoffDraft

afterEach(cleanup)
beforeEach(() => promoteMutate.mockClear())

describe('AgentSuggestionsPanel', () => {
  it('renders captured quantities for review', () => {
    render(<AgentSuggestionsPanel projectId="p-1" draft={DRAFT} />)
    expect(screen.getByText(/Agent suggestions/)).toBeTruthy()
    expect(screen.getByText(/North wall area/)).toBeTruthy()
  })

  it('hides low-confidence rows behind a disclosure', () => {
    render(<AgentSuggestionsPanel projectId="p-1" draft={DRAFT} />)
    expect(screen.queryByText(/Maybe trim/)).toBeNull()
    expect(screen.getByText(/Show low-confidence \(1\)/)).toBeTruthy()
  })

  it('reveals low-confidence rows when the disclosure is opened', () => {
    render(<AgentSuggestionsPanel projectId="p-1" draft={DRAFT} />)
    fireEvent.click(screen.getByText(/Show low-confidence \(1\)/))
    expect(screen.getByText(/Maybe trim/)).toBeTruthy()
  })

  it('promotes a quantity on Confirm', () => {
    render(<AgentSuggestionsPanel projectId="p-1" draft={DRAFT} />)
    fireEvent.click(screen.getAllByText('Confirm', { exact: true })[0])
    expect(promoteMutate).toHaveBeenCalledTimes(1)
    expect(promoteMutate.mock.calls[0][0].quantity_ids).toContain('q-high')
  })
})
