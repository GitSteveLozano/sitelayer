import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MButton, MButtonRow, MButtonStack } from './button'

afterEach(cleanup)

describe('MButton', () => {
  it('renders children and defaults to primary variant + md size', () => {
    render(<MButton>Save</MButton>)
    const btn = screen.getByRole('button', { name: 'Save' })
    expect(btn.getAttribute('data-variant')).toBe('primary')
    // md size means no m-btn-sm modifier.
    expect(btn.className).toContain('m-btn')
    expect(btn.className).not.toContain('m-btn-sm')
    expect(btn.getAttribute('type')).toBe('button')
  })

  it('applies the requested variant via data-variant', () => {
    render(
      <>
        <MButton variant="ghost">Ghost</MButton>
        <MButton variant="quiet">Quiet</MButton>
      </>,
    )
    expect(screen.getByRole('button', { name: 'Ghost' }).getAttribute('data-variant')).toBe('ghost')
    expect(screen.getByRole('button', { name: 'Quiet' }).getAttribute('data-variant')).toBe('quiet')
  })

  it('adds the small-size modifier when size="sm"', () => {
    render(<MButton size="sm">Small</MButton>)
    expect(screen.getByRole('button', { name: 'Small' }).className).toContain('m-btn-sm')
  })

  it('merges a caller-supplied className', () => {
    render(<MButton className="extra-class">Hi</MButton>)
    const btn = screen.getByRole('button', { name: 'Hi' })
    expect(btn.className).toContain('m-btn')
    expect(btn.className).toContain('extra-class')
  })

  it('fires onClick when enabled', () => {
    const onClick = vi.fn()
    render(<MButton onClick={onClick}>Go</MButton>)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does not fire onClick when disabled', () => {
    const onClick = vi.fn()
    render(
      <MButton onClick={onClick} disabled>
        Nope
      </MButton>,
    )
    const btn = screen.getByRole('button', { name: 'Nope' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('forwards arbitrary button attributes (aria-label, type override)', () => {
    render(
      <MButton aria-label="Close dialog" type="submit">
        x
      </MButton>,
    )
    const btn = screen.getByRole('button', { name: 'Close dialog' })
    expect(btn.getAttribute('aria-label')).toBe('Close dialog')
    expect(btn.getAttribute('type')).toBe('submit')
  })
})

describe('MButtonRow / MButtonStack', () => {
  it('MButtonRow wraps children in m-btn-row', () => {
    const { container } = render(
      <MButtonRow>
        <span>child</span>
      </MButtonRow>,
    )
    const row = container.querySelector('.m-btn-row')
    expect(row).toBeTruthy()
    expect(row?.textContent).toBe('child')
  })

  it('MButtonStack wraps children in m-btn-stack', () => {
    const { container } = render(
      <MButtonStack>
        <span>child</span>
      </MButtonStack>,
    )
    expect(container.querySelector('.m-btn-stack')?.textContent).toBe('child')
  })
})
