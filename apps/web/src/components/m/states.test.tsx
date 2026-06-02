import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { EmptyState, ErrorState, LoadingState } from './states'
import { DEmptyState, DErrorState, DLoadingState } from '../d'

afterEach(cleanup)

describe('shared content states', () => {
  it('EmptyState renders the d-state mark + default copy', () => {
    const { container } = render(<EmptyState />)
    expect(container.querySelector('.d-state')).toBeTruthy()
    expect(container.querySelector('.d-state-mark')).toBeTruthy()
    expect(container.querySelector('.d-state-title')?.textContent).toBe('Nothing here yet')
  })

  it('ErrorState renders the bang + bad-toned title + optional code', () => {
    const { container } = render(<ErrorState code="500" />)
    expect(container.querySelector('.d-state-bang')).toBeTruthy()
    expect(container.querySelector('.d-state-title')?.getAttribute('data-tone')).toBe('bad')
    expect(container.querySelector('.d-state-code')?.textContent).toBe('500')
  })

  it('LoadingState renders the pulsing mark + label', () => {
    const { container } = render(<LoadingState label="Working…" />)
    expect(container.querySelector('.d-pulse')).toBeTruthy()
    expect(container.querySelector('.d-state-body')?.textContent).toBe('Working…')
  })
})

describe('desktop back-compat aliases', () => {
  it('DEmptyState/DErrorState/DLoadingState are the promoted shared components', () => {
    expect(DEmptyState).toBe(EmptyState)
    expect(DErrorState).toBe(ErrorState)
    expect(DLoadingState).toBe(LoadingState)
  })
})
