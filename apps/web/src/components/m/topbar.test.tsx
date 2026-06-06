import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MTopBar } from './topbar'

afterEach(cleanup)

describe('MTopBar', () => {
  it('renders the title', () => {
    render(<MTopBar title="Today" />)
    expect(screen.getByText('Today')).toBeTruthy()
  })

  it('renders eyebrow and sub when provided', () => {
    render(<MTopBar title="Project" eyebrow="ESTIMATE" sub="Acme Builders" />)
    expect(screen.getByText('ESTIMATE')).toBeTruthy()
    expect(screen.getByText('Acme Builders')).toBeTruthy()
  })

  it('does not render a back button by default', () => {
    render(<MTopBar title="Home" />)
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
  })

  it('renders an aria-labelled back button and fires onBack', () => {
    const onBack = vi.fn()
    render(<MTopBar title="Detail" back onBack={onBack} />)
    const back = screen.getByRole('button', { name: 'Back' })
    expect(back.getAttribute('aria-label')).toBe('Back')
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('renders the action button with its accessible label and fires onAction', () => {
    const onAction = vi.fn()
    render(<MTopBar title="Today" actionIcon={<span>+</span>} actionLabel="New project" onAction={onAction} />)
    const action = screen.getByRole('button', { name: 'New project' })
    expect(action.getAttribute('aria-label')).toBe('New project')
    fireEvent.click(action)
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('falls back to a generic "Action" aria-label when actionIcon is given without a label', () => {
    render(<MTopBar title="X" actionIcon={<span>+</span>} />)
    expect(screen.getByRole('button', { name: 'Action' })).toBeTruthy()
  })

  it('renders no action button when neither actionIcon nor actionLabel is given', () => {
    render(<MTopBar title="Plain" />)
    expect(screen.queryByRole('button', { name: 'Action' })).toBeNull()
  })
})
